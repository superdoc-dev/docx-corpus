#!/usr/bin/env python3
"""
Apply trained classifiers to the full corpus.

Loads the trained models and classifies all unclassified documents.
Fetches text from R2, runs inference, updates the database.
Supports resume — already-classified documents are skipped.

Usage:
    # Local classification
    python classify.py --models-dir ./models
    python classify.py --models-dir ./models --batch-size 256 --languages en,ru

    # Cloud classification on Modal (parallel GPU workers)
    python classify.py --models-dir ./models --modal
    python classify.py --models-dir ./models --modal --workers 20 --gpu a10g
"""

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np
import torch
from tqdm import tqdm
from transformers import AutoModelForSequenceClassification, AutoTokenizer

from common import (
    fetch_documents_text_parallel,
    get_db_connection,
    load_taxonomy,
    save_labels_to_db,
)

DEFAULT_BATCH_SIZE = 128
DEFAULT_MAX_LENGTH = 512
DEFAULT_MAX_CHARS = 2000


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def load_classifier(model_dir: str, device: torch.device):
    """Load a trained classifier and tokenizer."""
    tokenizer = AutoTokenizer.from_pretrained(model_dir)
    model = AutoModelForSequenceClassification.from_pretrained(model_dir)
    model.to(device)
    model.eval()
    return tokenizer, model


def get_unclassified_documents(
    languages: list[str] | None = None,
    limit: int | None = None,
) -> list[dict]:
    """Fetch documents that haven't been classified yet."""
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            query = """
                SELECT id, source_url, original_filename, word_count, language
                FROM documents
                WHERE extracted_at IS NOT NULL
                  AND extraction_error IS NULL
                  AND word_count > 0
                  AND classification_model IS NULL
            """
            params: list = []
            if languages:
                placeholders = ",".join(["%s"] * len(languages))
                query += f" AND language IN ({placeholders})"
                params.extend(languages)
            query += " ORDER BY random()"
            if limit:
                query += " LIMIT %s"
                params.append(limit)
            cur.execute(query, params)
            return [
                {"id": r[0], "source_url": r[1], "original_filename": r[2],
                 "word_count": r[3], "language": r[4]}
                for r in cur.fetchall()
            ]
    finally:
        conn.close()


def get_classification_stats() -> dict:
    """Get current classification progress."""
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT
                    COUNT(*)::int as total,
                    COUNT(CASE WHEN classification_model IS NOT NULL THEN 1 END)::int as classified,
                    COUNT(CASE WHEN extracted_at IS NOT NULL AND extraction_error IS NULL AND word_count > 0 THEN 1 END)::int as classifiable
                FROM documents
            """)
            row = cur.fetchone()
            return {
                "total": row[0], "classified": row[1],
                "classifiable": row[2], "remaining": row[2] - row[1],
            }
    finally:
        conn.close()


@torch.no_grad()
def classify_batch(
    texts: list[str], tokenizer, model, max_length: int, device: torch.device,
) -> list[tuple[str, float]]:
    """Classify a batch of texts. Returns list of (label, confidence)."""
    inputs = tokenizer(
        texts, truncation=True, max_length=max_length,
        padding=True, return_tensors="pt",
    ).to(device)
    outputs = model(**inputs)
    probs = torch.softmax(outputs.logits, dim=-1)
    confidences, pred_ids = torch.max(probs, dim=-1)
    return [
        (model.config.id2label[int(pid)], float(conf))
        for pid, conf in zip(pred_ids.cpu().numpy(), confidences.cpu().numpy())
    ]


def process_batch(
    docs, type_tokenizer, type_model, topic_tokenizer, topic_model,
    max_length, max_chars, device, model_name,
) -> list[dict]:
    """Process a batch: fetch texts, classify, return label dicts."""
    doc_ids = [d["id"] for d in docs]
    texts = fetch_documents_text_parallel(doc_ids, max_chars=max_chars)
    valid_docs = []
    valid_texts = []
    for doc in docs:
        text = texts.get(doc["id"], "")
        if text:
            valid_docs.append(doc)
            valid_texts.append(text)
    if not valid_texts:
        return []
    type_results = classify_batch(valid_texts, type_tokenizer, type_model, max_length, device)
    topic_results = classify_batch(valid_texts, topic_tokenizer, topic_model, max_length, device)
    return [
        {
            "id": doc["id"], "document_type": dt, "document_topic": tp,
            "confidence": min(tc, tpc), "model": model_name,
        }
        for doc, (dt, tc), (tp, tpc) in zip(valid_docs, type_results, topic_results)
    ]


# ---------------------------------------------------------------------------
# Local classification
# ---------------------------------------------------------------------------


def run_local(args):
    """Classify documents locally using available device."""
    type_model_dir = os.path.join(args.models_dir, "document_type", "best")
    topic_model_dir = os.path.join(args.models_dir, "topic", "best")
    for d in [type_model_dir, topic_model_dir]:
        if not os.path.exists(d):
            print(f"ERROR: Model directory not found: {d}")
            sys.exit(1)

    config_path = os.path.join(args.models_dir, "training_config.json")
    if os.path.exists(config_path):
        with open(config_path) as f:
            train_config = json.load(f)
        model_name = f"modernbert-{train_config.get('taxonomy_version', 'v2')}"
    else:
        model_name = "modernbert-v2"

    if torch.cuda.is_available():
        device = torch.device("cuda")
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        device = torch.device("mps")
    else:
        device = torch.device("cpu")
    print(f"Device: {device}")

    print(f"\nLoading document_type model from {type_model_dir}...")
    type_tokenizer, type_model = load_classifier(type_model_dir, device)
    print(f"Loading topic model from {topic_model_dir}...")
    topic_tokenizer, topic_model = load_classifier(topic_model_dir, device)

    stats = get_classification_stats()
    print(f"\nCorpus: {stats['total']:,} total, {stats['classifiable']:,} classifiable, "
          f"{stats['classified']:,} done, {stats['remaining']:,} remaining")

    languages = [l.strip() for l in args.languages.split(",")] if args.languages else None
    docs = get_unclassified_documents(languages=languages, limit=args.limit)
    print(f"Found {len(docs):,} documents to classify")
    if not docs:
        print("Nothing to classify!")
        return
    if args.dry_run:
        print("  (DRY RUN — will not write to database)")

    total_classified = 0
    total_errors = 0
    start_time = time.time()
    fetch_batch_size = min(args.batch_size, 100)
    pbar = tqdm(total=len(docs), desc="Classifying", unit="doc")

    for i in range(0, len(docs), fetch_batch_size):
        batch_docs = docs[i : i + fetch_batch_size]
        labels = process_batch(
            batch_docs, type_tokenizer, type_model, topic_tokenizer, topic_model,
            args.max_length, args.max_chars, device, model_name,
        )
        if labels and not args.dry_run:
            save_labels_to_db(labels, batch_size=args.db_batch_size)
        total_classified += len(labels)
        total_errors += len(batch_docs) - len(labels)
        pbar.update(len(batch_docs))
        elapsed = time.time() - start_time
        rate = total_classified / elapsed if elapsed > 0 else 0
        pbar.set_postfix_str(f"{rate:.0f} docs/s, {total_errors} errors")
    pbar.close()

    elapsed = time.time() - start_time
    rate = total_classified / elapsed if elapsed > 0 else 0
    print(f"\n{'=' * 60}")
    print("Classification Complete")
    print(f"{'=' * 60}")
    print(f"  Classified: {total_classified:,}, Errors: {total_errors:,}")
    print(f"  Time: {elapsed:.1f}s ({rate:.0f} docs/s)")
    if not args.dry_run:
        final = get_classification_stats()
        print(f"  DB classified: {final['classified']:,}, remaining: {final['remaining']:,}")
    if args.dry_run:
        print("  (DRY RUN — no changes written)")


# ---------------------------------------------------------------------------
# Modal cloud classification (parallel workers)
# ---------------------------------------------------------------------------


def run_modal(args):
    """Classify on Modal with parallel GPU workers."""
    import modal

    app = modal.App("docx-classifier-inference")
    inference_image = (
        modal.Image.debian_slim(python_version="3.11")
        .pip_install("torch", "transformers", "numpy", "psycopg2-binary")
    )
    model_volume = modal.Volume.from_name("classifier-models")
    db_secret = modal.Secret.from_name("docx-db")

    gpu_map = {"t4": "T4", "a10g": "a10g", "l4": "l4", "a100": "a100"}
    gpu = gpu_map.get(args.gpu.lower(), args.gpu)

    @app.function(image=inference_image, timeout=300, secrets=[db_secret])
    def fetch_unclassified_ids(languages: list[str] | None, limit: int | None) -> list[str]:
        import os
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            with conn.cursor() as cur:
                query = """
                    SELECT id FROM documents
                    WHERE extracted_at IS NOT NULL AND extraction_error IS NULL
                      AND word_count > 0 AND classification_model IS NULL
                """
                params = []
                if languages:
                    query += f" AND language IN ({','.join(['%s'] * len(languages))})"
                    params.extend(languages)
                query += " ORDER BY random()"
                if limit:
                    query += " LIMIT %s"
                    params.append(limit)
                cur.execute(query, params)
                return [r[0] for r in cur.fetchall()]
        finally:
            conn.close()

    @app.function(
        image=inference_image, gpu=gpu, timeout=7200,
        volumes={"/models": model_volume}, secrets=[db_secret],
    )
    def classify_chunk(
        doc_ids: list[str], worker_id: int, total_workers: int,
        max_length: int, max_chars: int, dry_run: bool,
    ) -> dict:
        import os
        import time
        import urllib.request
        from concurrent.futures import ThreadPoolExecutor
        import psycopg2
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        TEXT_BASE_URL = "https://docxcorp.us/extracted"

        def fetch_text(did, mc=2000):
            try:
                req = urllib.request.Request(f"{TEXT_BASE_URL}/{did}.txt", headers={"User-Agent": "docx-classifier/2.0"})
                with urllib.request.urlopen(req, timeout=15) as r:
                    return r.read().decode("utf-8")[:mc]
            except Exception:
                return ""

        def fetch_parallel(ids, mc):
            res = {}
            with ThreadPoolExecutor(max_workers=50) as ex:
                for did, txt in ex.map(lambda d: (d, fetch_text(d, mc)), ids):
                    res[did] = txt
            return res

        def save_batch(labels):
            conn = psycopg2.connect(os.environ["DATABASE_URL"])
            try:
                with conn.cursor() as cur:
                    for l in labels:
                        cur.execute("""
                            UPDATE documents SET document_type=%s, document_topic=%s,
                                classification_confidence=%s, classification_model=%s
                            WHERE id=%s
                        """, (l["document_type"], l["document_topic"], l["confidence"], l["model"], l["id"]))
                conn.commit()
            finally:
                conn.close()

        model_volume.reload()
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        gpu_name = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu"
        print(f"[Worker {worker_id}/{total_workers}] {len(doc_ids):,} docs, device={gpu_name}")

        cfg_path = "/models/training_config.json"
        model_name = "modernbert-v2"
        if os.path.exists(cfg_path):
            with open(cfg_path) as f:
                model_name = f"modernbert-{json.load(f).get('taxonomy_version', 'v2')}"

        type_tok = AutoTokenizer.from_pretrained("/models/document_type/best")
        type_mdl = AutoModelForSequenceClassification.from_pretrained("/models/document_type/best").to(device).eval()
        topic_tok = AutoTokenizer.from_pretrained("/models/topic/best")
        topic_mdl = AutoModelForSequenceClassification.from_pretrained("/models/topic/best").to(device).eval()

        @torch.no_grad()
        def infer(texts, tok, mdl):
            inp = tok(texts, truncation=True, max_length=max_length, padding=True, return_tensors="pt").to(device)
            probs = torch.softmax(mdl(**inp).logits, dim=-1)
            confs, preds = torch.max(probs, dim=-1)
            return [(mdl.config.id2label[int(p)], float(c)) for p, c in zip(preds.cpu().numpy(), confs.cpu().numpy())]

        total_classified = 0
        total_errors = 0
        start = time.time()

        for i in range(0, len(doc_ids), 100):
            batch = doc_ids[i:i+100]
            texts = fetch_parallel(batch, max_chars)
            valid = [(did, texts[did]) for did in batch if texts.get(did)]
            if not valid:
                total_errors += len(batch)
                continue
            vids, vtxts = zip(*valid)
            vtxts = list(vtxts)
            tr = infer(vtxts, type_tok, type_mdl)
            tpr = infer(vtxts, topic_tok, topic_mdl)
            labels = [
                {"id": did, "document_type": dt, "document_topic": tp,
                 "confidence": min(tc, tpc), "model": model_name}
                for did, (dt, tc), (tp, tpc) in zip(vids, tr, tpr)
            ]
            if labels and not dry_run:
                save_batch(labels)
            total_classified += len(labels)
            total_errors += len(batch) - len(labels)
            if (i // 100) % 10 == 0:
                elapsed = time.time() - start
                rate = total_classified / elapsed if elapsed > 0 else 0
                pct = (i + len(batch)) / len(doc_ids) * 100
                print(f"  [Worker {worker_id}] [{pct:5.1f}%] {total_classified:,} done, {rate:.0f} docs/s")

        elapsed = time.time() - start
        rate = total_classified / elapsed if elapsed > 0 else 0
        print(f"  [Worker {worker_id}] DONE — {total_classified:,} in {elapsed:.0f}s ({rate:.0f} docs/s)")
        return {"worker_id": worker_id, "classified": total_classified, "errors": total_errors,
                "elapsed_seconds": round(elapsed, 1), "docs_per_second": round(rate, 1)}

    languages = [l.strip() for l in args.languages.split(",")] if args.languages else None
    n_workers = args.workers

    print(f"Modal parallel classification ({gpu} GPU, {n_workers} workers)")
    if args.dry_run:
        print("  DRY RUN mode")
    print()

    with app.run():
        print("Fetching unclassified document IDs...")
        all_ids = fetch_unclassified_ids.remote(languages=languages, limit=args.limit)
        print(f"  Found {len(all_ids):,} documents to classify")
        if not all_ids:
            print("Nothing to classify!")
            return

        n_workers = min(n_workers, len(all_ids))
        chunk_size = math.ceil(len(all_ids) / n_workers)
        chunks = [all_ids[i:i+chunk_size] for i in range(0, len(all_ids), chunk_size)]
        print(f"  Split into {len(chunks)} chunks of ~{chunk_size:,} docs")
        print(f"  Estimated: ~{len(all_ids) / (n_workers * 8) / 60:.0f} minutes\n")

        results = list(classify_chunk.map(
            chunks,
            [i for i in range(len(chunks))],
            [len(chunks)] * len(chunks),
            [args.max_length] * len(chunks),
            [args.max_chars] * len(chunks),
            [args.dry_run] * len(chunks),
        ))

        total_classified = sum(r["classified"] for r in results)
        total_errors = sum(r["errors"] for r in results)
        max_elapsed = max(r["elapsed_seconds"] for r in results)
        agg_rate = total_classified / max_elapsed if max_elapsed > 0 else 0

        print(f"\n{'=' * 60}")
        print("Classification Complete")
        print(f"{'=' * 60}")
        print(f"  Workers: {len(results)}")
        print(f"  Classified: {total_classified:,}, Errors: {total_errors:,}")
        print(f"  Wall time: {max_elapsed:.0f}s ({max_elapsed/60:.1f} min)")
        print(f"  Aggregate: {agg_rate:.0f} docs/s")
        if args.dry_run:
            print("  (DRY RUN — no changes written)")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="Classify corpus with trained models")
    parser.add_argument("--models-dir", type=str, required=True)
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--max-length", type=int, default=DEFAULT_MAX_LENGTH)
    parser.add_argument("--max-chars", type=int, default=DEFAULT_MAX_CHARS)
    parser.add_argument("--languages", type=str, default=None)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--db-batch-size", type=int, default=500)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--modal", action="store_true", help="Run on Modal cloud GPUs")
    parser.add_argument("--workers", type=int, default=20, help="Modal parallel workers (default: 20)")
    parser.add_argument("--gpu", type=str, default="T4", help="Modal GPU type: T4, a10g, l4, a100")
    args = parser.parse_args()

    if args.modal:
        run_modal(args)
    else:
        run_local(args)


if __name__ == "__main__":
    main()
