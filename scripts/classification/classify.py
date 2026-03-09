#!/usr/bin/env python3
"""
Phase 4: Apply trained classifiers to the full corpus.

Loads the trained ModernBERT models and classifies all unclassified documents.
Fetches text from R2, runs inference, updates the database.

Supports resume — already-classified documents are skipped.

Usage:
    python classify.py --models-dir ./models
    python classify.py --models-dir ./models --batch-size 256 --languages en,ru,cs,pl,es
    python classify.py --models-dir ./models --dry-run --limit 100
"""

import argparse
import json
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
                {
                    "id": row[0],
                    "source_url": row[1],
                    "original_filename": row[2],
                    "word_count": row[3],
                    "language": row[4],
                }
                for row in cur.fetchall()
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
                "total": row[0],
                "classified": row[1],
                "classifiable": row[2],
                "remaining": row[2] - row[1],
            }
    finally:
        conn.close()


@torch.no_grad()
def classify_batch(
    texts: list[str],
    tokenizer,
    model,
    max_length: int,
    device: torch.device,
) -> list[tuple[str, float]]:
    """Classify a batch of texts. Returns list of (label, confidence)."""
    inputs = tokenizer(
        texts,
        truncation=True,
        max_length=max_length,
        padding=True,
        return_tensors="pt",
    ).to(device)

    outputs = model(**inputs)
    probs = torch.softmax(outputs.logits, dim=-1)
    confidences, pred_ids = torch.max(probs, dim=-1)

    results = []
    for pred_id, conf in zip(pred_ids.cpu().numpy(), confidences.cpu().numpy()):
        label = model.config.id2label[int(pred_id)]
        results.append((label, float(conf)))

    return results


def process_batch(
    docs: list[dict],
    type_tokenizer,
    type_model,
    topic_tokenizer,
    topic_model,
    max_length: int,
    max_chars: int,
    device: torch.device,
    model_name: str,
) -> list[dict]:
    """Process a batch: fetch texts, classify, return label dicts."""
    # Fetch texts
    doc_ids = [d["id"] for d in docs]
    texts = fetch_documents_text_parallel(doc_ids, max_chars=max_chars)

    # Filter docs with text
    valid_docs = []
    valid_texts = []
    for doc in docs:
        text = texts.get(doc["id"], "")
        if text:
            valid_docs.append(doc)
            valid_texts.append(text)

    if not valid_texts:
        return []

    # Classify with both models
    type_results = classify_batch(
        valid_texts, type_tokenizer, type_model, max_length, device
    )
    topic_results = classify_batch(
        valid_texts, topic_tokenizer, topic_model, max_length, device
    )

    # Build label dicts for DB update
    labels = []
    for doc, (doc_type, type_conf), (topic, topic_conf) in zip(
        valid_docs, type_results, topic_results
    ):
        labels.append(
            {
                "id": doc["id"],
                "document_type": doc_type,
                "document_topic": topic,
                "confidence": min(type_conf, topic_conf),
                "model": model_name,
            }
        )

    return labels


def main():
    parser = argparse.ArgumentParser(
        description="Classify full corpus with trained ModernBERT models"
    )
    parser.add_argument(
        "--models-dir",
        type=str,
        required=True,
        help="Directory containing trained models (from train.py)",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=DEFAULT_BATCH_SIZE,
        help=f"Inference batch size (default: {DEFAULT_BATCH_SIZE})",
    )
    parser.add_argument(
        "--max-length",
        type=int,
        default=DEFAULT_MAX_LENGTH,
        help=f"Max token length (default: {DEFAULT_MAX_LENGTH})",
    )
    parser.add_argument(
        "--max-chars",
        type=int,
        default=DEFAULT_MAX_CHARS,
        help=f"Max text characters to fetch (default: {DEFAULT_MAX_CHARS})",
    )
    parser.add_argument(
        "--languages",
        type=str,
        default=None,
        help="Comma-separated language codes to classify (default: all)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Max documents to classify (default: all)",
    )
    parser.add_argument(
        "--db-batch-size",
        type=int,
        default=500,
        help="DB update batch size (default: 500)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Classify but don't write to DB",
    )
    args = parser.parse_args()

    # Validate model directories
    type_model_dir = os.path.join(args.models_dir, "document_type", "best")
    topic_model_dir = os.path.join(args.models_dir, "topic", "best")

    for d in [type_model_dir, topic_model_dir]:
        if not os.path.exists(d):
            print(f"ERROR: Model directory not found: {d}")
            sys.exit(1)

    # Load training config for model name
    config_path = os.path.join(args.models_dir, "training_config.json")
    if os.path.exists(config_path):
        with open(config_path) as f:
            train_config = json.load(f)
        model_name = f"modernbert-{train_config.get('taxonomy_version', 'v2')}"
    else:
        model_name = "modernbert-v2"

    # Device
    if torch.cuda.is_available():
        device = torch.device("cuda")
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        device = torch.device("mps")
    else:
        device = torch.device("cpu")
    print(f"Device: {device}")

    # Load models
    print(f"\nLoading document_type model from {type_model_dir}...")
    type_tokenizer, type_model = load_classifier(type_model_dir, device)
    print(f"Loading topic model from {topic_model_dir}...")
    topic_tokenizer, topic_model = load_classifier(topic_model_dir, device)

    # Stats
    stats = get_classification_stats()
    print(f"\nCorpus stats:")
    print(f"  Total documents: {stats['total']:,}")
    print(f"  Classifiable: {stats['classifiable']:,}")
    print(f"  Already classified: {stats['classified']:,}")
    print(f"  Remaining: {stats['remaining']:,}")

    # Get unclassified docs
    languages = (
        [l.strip() for l in args.languages.split(",")]
        if args.languages
        else None
    )
    print(f"\nFetching unclassified documents...")
    docs = get_unclassified_documents(languages=languages, limit=args.limit)
    print(f"  Found {len(docs):,} documents to classify")

    if not docs:
        print("Nothing to classify!")
        return

    if args.dry_run:
        print("  (DRY RUN — will not write to database)")

    # Process in batches
    total_classified = 0
    total_errors = 0
    start_time = time.time()

    # Use smaller fetch batches for text retrieval
    fetch_batch_size = min(args.batch_size, 100)

    pbar = tqdm(total=len(docs), desc="Classifying", unit="doc")

    for i in range(0, len(docs), fetch_batch_size):
        batch_docs = docs[i : i + fetch_batch_size]

        labels = process_batch(
            docs=batch_docs,
            type_tokenizer=type_tokenizer,
            type_model=type_model,
            topic_tokenizer=topic_tokenizer,
            topic_model=topic_model,
            max_length=args.max_length,
            max_chars=args.max_chars,
            device=device,
            model_name=model_name,
        )

        if labels and not args.dry_run:
            save_labels_to_db(labels, batch_size=args.db_batch_size)

        total_classified += len(labels)
        total_errors += len(batch_docs) - len(labels)
        pbar.update(len(batch_docs))

        # Show throughput
        elapsed = time.time() - start_time
        rate = total_classified / elapsed if elapsed > 0 else 0
        pbar.set_postfix_str(f"{rate:.0f} docs/s, {total_errors} errors")

    pbar.close()

    elapsed = time.time() - start_time
    rate = total_classified / elapsed if elapsed > 0 else 0

    print(f"\n{'=' * 60}")
    print("Classification Complete")
    print(f"{'=' * 60}")
    print(f"  Classified: {total_classified:,}")
    print(f"  Errors (no text): {total_errors:,}")
    print(f"  Time: {elapsed:.1f}s ({rate:.0f} docs/s)")
    print(f"  Model: {model_name}")

    if not args.dry_run:
        final_stats = get_classification_stats()
        print(f"\n  Total classified in DB: {final_stats['classified']:,}")
        print(f"  Remaining: {final_stats['remaining']:,}")

    if args.dry_run:
        print("\n  (DRY RUN — no changes written to database)")

    # Print distribution of this batch
    if total_classified > 0 and labels:
        print(f"\nSample distribution (last batch):")
        type_counts: dict[str, int] = {}
        topic_counts: dict[str, int] = {}
        for label in labels:
            dt = label["document_type"]
            tp = label["document_topic"]
            type_counts[dt] = type_counts.get(dt, 0) + 1
            topic_counts[tp] = topic_counts.get(tp, 0) + 1

        print("  Types:", dict(sorted(type_counts.items(), key=lambda x: -x[1])))
        print("  Topics:", dict(sorted(topic_counts.items(), key=lambda x: -x[1])))


if __name__ == "__main__":
    main()
