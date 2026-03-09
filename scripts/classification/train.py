#!/usr/bin/env python3
"""
Train classifiers on LLM-labeled documents.

Trains two independent classifiers:
  1. Document type (10 classes)
  2. Topic (9 classes)

Uses HuggingFace Transformers with xlm-roberta-base (multilingual).
Supports class-weighted loss, configurable train/val split, epochs, etc.

Usage:
    # Local training
    python train.py --input labeled_docs.jsonl
    python train.py --input labeled_docs.jsonl --epochs 5 --lr 2e-5

    # Cloud training on Modal (GPU)
    python train.py --input labeled_docs.jsonl --modal
    python train.py --input labeled_docs.jsonl --modal --gpu a10g
"""

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
import torch
from datasets import Dataset
from sklearn.metrics import accuracy_score, classification_report, f1_score
from sklearn.model_selection import train_test_split
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    EarlyStoppingCallback,
    Trainer,
    TrainingArguments,
)

from common import fetch_documents_text_parallel, load_taxonomy

DEFAULT_MODEL = "xlm-roberta-base"
DEFAULT_EPOCHS = 5
DEFAULT_LR = 2e-5
DEFAULT_BATCH_SIZE = 16
DEFAULT_MAX_LENGTH = 512
DEFAULT_VAL_SPLIT = 0.15
DEFAULT_OUTPUT_DIR = "./models"


# ---------------------------------------------------------------------------
# Shared helpers (used by both local and Modal paths)
# ---------------------------------------------------------------------------


def load_labeled_data(input_path: str, min_confidence: float = 0.0) -> list[dict]:
    """Load labeled documents, optionally filtering by confidence."""
    docs = []
    with open(input_path) as f:
        for line in f:
            if line.strip():
                entry = json.loads(line)
                if entry.get("confidence", 0) >= min_confidence:
                    docs.append(entry)
    return docs


def build_label_maps(taxonomy: dict) -> tuple[dict, dict, dict, dict]:
    """Build label-to-id and id-to-label mappings for both dimensions."""
    type_labels = [t["id"] for t in taxonomy["document_types"]]
    topic_labels = [t["id"] for t in taxonomy["topics"]]
    type2id = {label: i for i, label in enumerate(type_labels)}
    id2type = {i: label for label, i in type2id.items()}
    topic2id = {label: i for i, label in enumerate(topic_labels)}
    id2topic = {i: label for label, i in topic2id.items()}
    return type2id, id2type, topic2id, id2topic


def prepare_dataset(
    docs: list[dict],
    texts: dict[str, str],
    label_map: dict[str, int],
    label_field: str,
) -> tuple[list[str], list[int]]:
    """Prepare text/label pairs, skipping docs without text or valid labels."""
    input_texts = []
    labels = []
    skipped = 0
    for doc in docs:
        text = texts.get(doc["id"], "")
        label = doc.get(label_field, "")
        if not text or label not in label_map:
            skipped += 1
            continue
        input_texts.append(text)
        labels.append(label_map[label])
    if skipped:
        print(f"  Skipped {skipped} docs (missing text or invalid label)")
    return input_texts, labels


def compute_metrics(eval_pred):
    """Compute accuracy and macro F1 for evaluation."""
    predictions, labels = eval_pred
    preds = np.argmax(predictions, axis=-1)
    return {
        "accuracy": accuracy_score(labels, preds),
        "f1_macro": f1_score(labels, preds, average="macro"),
    }


def compute_class_weights(labels: list[int], num_classes: int) -> torch.Tensor:
    """Compute inverse-frequency class weights."""
    from collections import Counter

    counts = Counter(labels)
    total = len(labels)
    weights = [total / (num_classes * counts.get(i, 1)) for i in range(num_classes)]
    return torch.tensor(weights, dtype=torch.float32)


class WeightedTrainer(Trainer):
    """Trainer with class-weighted cross-entropy loss."""

    def __init__(self, class_weights: torch.Tensor | None = None, **kwargs):
        super().__init__(**kwargs)
        self.class_weights = class_weights

    def compute_loss(self, model, inputs, return_outputs=False, **kwargs):
        labels = inputs.pop("labels")
        outputs = model(**inputs)
        logits = outputs.logits
        if self.class_weights is not None:
            weight = self.class_weights.to(logits.device)
            loss = torch.nn.functional.cross_entropy(logits, labels, weight=weight)
        else:
            loss = torch.nn.functional.cross_entropy(logits, labels)
        return (loss, outputs) if return_outputs else loss


def train_classifier(
    train_texts: list[str],
    train_labels: list[int],
    val_texts: list[str],
    val_labels: list[int],
    num_labels: int,
    id2label: dict[int, str],
    label2id: dict[str, int],
    output_dir: str,
    model_name: str,
    epochs: int,
    lr: float,
    batch_size: int,
    max_length: int,
    classifier_name: str,
):
    """Train a single classifier (type or topic)."""
    print(f"\n{'=' * 60}")
    print(f"Training: {classifier_name}")
    print(f"  Train: {len(train_texts)}, Val: {len(val_texts)}")
    print(f"  Classes: {num_labels}, Model: {model_name}")
    print(f"  Epochs: {epochs}, LR: {lr}, Batch: {batch_size}")
    print(f"{'=' * 60}")

    tokenizer = AutoTokenizer.from_pretrained(model_name)
    model = AutoModelForSequenceClassification.from_pretrained(
        model_name, num_labels=num_labels, id2label=id2label, label2id=label2id,
    )

    def tokenize(examples):
        return tokenizer(
            examples["text"], truncation=True,
            max_length=max_length, padding="max_length",
        )

    train_ds = Dataset.from_dict({"text": train_texts, "label": train_labels})
    val_ds = Dataset.from_dict({"text": val_texts, "label": val_labels})
    train_ds = train_ds.map(tokenize, batched=True, remove_columns=["text"])
    val_ds = val_ds.map(tokenize, batched=True, remove_columns=["text"])
    train_ds.set_format("torch")
    val_ds.set_format("torch")

    save_dir = os.path.join(output_dir, classifier_name)

    training_args = TrainingArguments(
        output_dir=save_dir,
        num_train_epochs=epochs,
        per_device_train_batch_size=batch_size,
        per_device_eval_batch_size=batch_size * 2,
        learning_rate=lr,
        weight_decay=0.01,
        warmup_ratio=0.1,
        eval_strategy="epoch",
        save_strategy="epoch",
        load_best_model_at_end=True,
        metric_for_best_model="f1_macro",
        greater_is_better=True,
        save_total_limit=2,
        logging_steps=50,
        fp16=torch.cuda.is_available(),
        report_to="none",
        seed=42,
    )

    class_weights = compute_class_weights(train_labels, num_labels)
    print(f"  Class weights: {[f'{w:.2f}' for w in class_weights.tolist()]}")

    trainer = WeightedTrainer(
        class_weights=class_weights, model=model, args=training_args,
        train_dataset=train_ds, eval_dataset=val_ds,
        compute_metrics=compute_metrics,
        callbacks=[EarlyStoppingCallback(early_stopping_patience=2)],
    )

    trainer.train()

    eval_results = trainer.evaluate()
    print(f"\n  Val accuracy: {eval_results['eval_accuracy']:.4f}")
    print(f"  Val F1 macro: {eval_results['eval_f1_macro']:.4f}")

    best_dir = os.path.join(save_dir, "best")
    trainer.save_model(best_dir)
    tokenizer.save_pretrained(best_dir)

    preds = trainer.predict(val_ds)
    pred_labels = np.argmax(preds.predictions, axis=-1)
    report = classification_report(
        val_ds["label"], pred_labels,
        target_names=[id2label[i] for i in range(num_labels)],
    )
    print(f"\nClassification Report ({classifier_name}):\n{report}")

    report_path = os.path.join(save_dir, "eval_report.txt")
    with open(report_path, "w") as f:
        f.write(f"Model: {model_name}\nClassifier: {classifier_name}\n")
        f.write(f"Train size: {len(train_texts)}\nVal size: {len(val_texts)}\n")
        f.write(f"Epochs: {epochs}\n")
        f.write(f"Val accuracy: {eval_results['eval_accuracy']:.4f}\n")
        f.write(f"Val F1 macro: {eval_results['eval_f1_macro']:.4f}\n\n")
        f.write(report)

    return eval_results


def run_training_pipeline(
    docs, texts, taxonomy, type2id, id2type, topic2id, id2topic,
    output_dir, model_name, epochs, lr, batch_size, max_length, val_split, seed,
):
    """Shared training pipeline used by both local and Modal paths."""
    # Prepare datasets
    print("\nPreparing document_type dataset...")
    type_texts, type_labels = prepare_dataset(docs, texts, type2id, "document_type")
    print(f"  {len(type_texts)} examples across {len(set(type_labels))} classes")

    print("Preparing topic dataset...")
    topic_texts, topic_labels = prepare_dataset(docs, texts, topic2id, "document_topic")
    print(f"  {len(topic_texts)} examples across {len(set(topic_labels))} classes")

    print(f"\nSplitting: {1 - val_split:.0%} train / {val_split:.0%} val")

    type_train_t, type_val_t, type_train_l, type_val_l = train_test_split(
        type_texts, type_labels, test_size=val_split,
        random_state=seed, stratify=type_labels,
    )
    topic_train_t, topic_val_t, topic_train_l, topic_val_l = train_test_split(
        topic_texts, topic_labels, test_size=val_split,
        random_state=seed, stratify=topic_labels,
    )

    os.makedirs(output_dir, exist_ok=True)

    type_results = train_classifier(
        type_train_t, type_train_l, type_val_t, type_val_l,
        len(type2id), id2type, type2id, output_dir,
        model_name, epochs, lr, batch_size, max_length, "document_type",
    )

    topic_results = train_classifier(
        topic_train_t, topic_train_l, topic_val_t, topic_val_l,
        len(topic2id), id2topic, topic2id, output_dir,
        model_name, epochs, lr, batch_size, max_length, "topic",
    )

    print(f"\n{'=' * 60}")
    print("Training Complete")
    print(f"{'=' * 60}")
    print(f"  Document Type — Acc: {type_results['eval_accuracy']:.4f}, F1: {type_results['eval_f1_macro']:.4f}")
    print(f"  Topic         — Acc: {topic_results['eval_accuracy']:.4f}, F1: {topic_results['eval_f1_macro']:.4f}")

    config = {
        "base_model": model_name,
        "taxonomy": taxonomy["name"],
        "taxonomy_version": taxonomy["version"],
        "total_docs": len(docs),
        "epochs": epochs,
        "learning_rate": lr,
        "batch_size": batch_size,
        "results": {
            "document_type": {
                "accuracy": type_results["eval_accuracy"],
                "f1_macro": type_results["eval_f1_macro"],
            },
            "topic": {
                "accuracy": topic_results["eval_accuracy"],
                "f1_macro": topic_results["eval_f1_macro"],
            },
        },
    }
    config_path = os.path.join(output_dir, "training_config.json")
    with open(config_path, "w") as f:
        json.dump(config, f, indent=2)
    print(f"  Config: {config_path}")

    return config


# ---------------------------------------------------------------------------
# Local training
# ---------------------------------------------------------------------------


def run_local(args):
    """Train locally using available device (CPU/MPS/CUDA)."""
    taxonomy = load_taxonomy()
    type2id, id2type, topic2id, id2topic = build_label_maps(taxonomy)
    print(f"Taxonomy: {taxonomy['name']} v{taxonomy['version']}")
    print(f"  Document types: {len(type2id)}, Topics: {len(topic2id)}")

    docs = load_labeled_data(args.input, min_confidence=args.min_confidence)
    print(f"\nLoaded {len(docs)} labeled documents")

    print(f"\nFetching document texts (max {args.max_chars} chars)...")
    doc_ids = [d["id"] for d in docs]
    all_texts = {}
    for i in range(0, len(doc_ids), 100):
        batch = doc_ids[i : i + 100]
        all_texts.update(fetch_documents_text_parallel(batch, max_chars=args.max_chars))
    print(f"  Got text for {sum(1 for t in all_texts.values() if t)}/{len(docs)} docs")

    config = run_training_pipeline(
        docs, all_texts, taxonomy, type2id, id2type, topic2id, id2topic,
        args.output_dir, args.model, args.epochs, args.lr,
        args.batch_size, args.max_length, args.val_split, args.seed,
    )

    print(f"\n  Models saved to: {args.output_dir}/")
    print(f"  Next step: python classify.py --models-dir {args.output_dir}")
    return config


# ---------------------------------------------------------------------------
# Modal cloud training
# ---------------------------------------------------------------------------


def run_modal(args):
    """Train on Modal with a cloud GPU. Downloads models to --output-dir."""
    import modal

    app = modal.App("docx-classifier-training")

    training_image = (
        modal.Image.debian_slim(python_version="3.11")
        .pip_install("torch", "transformers", "datasets", "scikit-learn", "accelerate", "numpy")
    )
    model_volume = modal.Volume.from_name("classifier-models", create_if_missing=True)

    # Read local files to send to Modal
    labeled_jsonl = Path(args.input).read_text()
    taxonomy_path = Path(__file__).parent / "taxonomy.json"
    with open(taxonomy_path) as f:
        taxonomy = json.load(f)

    gpu_map = {"t4": "T4", "a10g": "a10g", "l4": "l4", "a100": "a100"}
    gpu = gpu_map.get(args.gpu.lower(), args.gpu)

    @app.function(image=training_image, gpu=gpu, timeout=3600, volumes={"/models": model_volume})
    def train_remote(labeled_jsonl: str, taxonomy: dict, **kwargs):
        """Self-contained training function running on Modal GPU."""
        import json
        import os
        import urllib.request
        from collections import Counter
        from concurrent.futures import ThreadPoolExecutor

        import numpy as np
        import torch
        from datasets import Dataset
        from sklearn.metrics import accuracy_score, classification_report, f1_score
        from sklearn.model_selection import train_test_split
        from transformers import (
            AutoModelForSequenceClassification, AutoTokenizer,
            EarlyStoppingCallback, Trainer, TrainingArguments,
        )

        TEXT_BASE_URL = "https://docxcorp.us/extracted"

        def fetch_text(doc_id, max_chars=2000):
            try:
                req = urllib.request.Request(
                    f"{TEXT_BASE_URL}/{doc_id}.txt",
                    headers={"User-Agent": "docx-classifier/2.0"},
                )
                with urllib.request.urlopen(req, timeout=15) as resp:
                    return resp.read().decode("utf-8")[:max_chars]
            except Exception:
                return ""

        def fetch_texts_parallel(docs, max_chars):
            results = {}
            def fetch_one(did):
                return did, fetch_text(did, max_chars)
            with ThreadPoolExecutor(max_workers=40) as ex:
                for did, text in ex.map(fetch_one, [d["id"] for d in docs]):
                    results[did] = text
            print(f"  Fetched text for {sum(1 for t in results.values() if t)}/{len(docs)} docs")
            return results

        class _WeightedTrainer(Trainer):
            def __init__(self, class_weights=None, **kw):
                super().__init__(**kw)
                self.class_weights = class_weights

            def compute_loss(self, model, inputs, return_outputs=False, **kw):
                labels = inputs.pop("labels")
                outputs = model(**inputs)
                logits = outputs.logits
                if self.class_weights is not None:
                    w = self.class_weights.to(logits.device)
                    loss = torch.nn.functional.cross_entropy(logits, labels, weight=w)
                else:
                    loss = torch.nn.functional.cross_entropy(logits, labels)
                return (loss, outputs) if return_outputs else loss

        def _compute_metrics(eval_pred):
            preds = np.argmax(eval_pred.predictions, axis=-1)
            return {
                "accuracy": accuracy_score(eval_pred.label_ids, preds),
                "f1_macro": f1_score(eval_pred.label_ids, preds, average="macro"),
            }

        def _class_weights(labels, n):
            counts = Counter(labels)
            total = len(labels)
            return torch.tensor([total / (n * counts.get(i, 1)) for i in range(n)], dtype=torch.float32)

        def _train_one(train_t, train_l, val_t, val_l, n_labels, id2l, l2id, out, mname, ep, lr, bs, ml, name):
            print(f"\n{'='*60}\nTraining: {name}\n  Train: {len(train_t)}, Val: {len(val_t)}, Classes: {n_labels}")
            print(f"  Device: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU'}")

            tok = AutoTokenizer.from_pretrained(mname)
            mdl = AutoModelForSequenceClassification.from_pretrained(mname, num_labels=n_labels, id2label=id2l, label2id=l2id)

            def tokenize(ex):
                return tok(ex["text"], truncation=True, max_length=ml, padding="max_length")

            tds = Dataset.from_dict({"text": train_t, "label": train_l}).map(tokenize, batched=True, remove_columns=["text"])
            vds = Dataset.from_dict({"text": val_t, "label": val_l}).map(tokenize, batched=True, remove_columns=["text"])
            tds.set_format("torch"); vds.set_format("torch")

            sd = os.path.join(out, name)
            args = TrainingArguments(
                output_dir=sd, num_train_epochs=ep, per_device_train_batch_size=bs,
                per_device_eval_batch_size=bs*2, learning_rate=lr, weight_decay=0.01,
                warmup_ratio=0.1, eval_strategy="epoch", save_strategy="epoch",
                load_best_model_at_end=True, metric_for_best_model="f1_macro",
                greater_is_better=True, save_total_limit=2, logging_steps=50,
                fp16=torch.cuda.is_available(), report_to="none", seed=42,
            )
            cw = _class_weights(train_l, n_labels)
            trainer = _WeightedTrainer(
                class_weights=cw, model=mdl, args=args,
                train_dataset=tds, eval_dataset=vds, compute_metrics=_compute_metrics,
                callbacks=[EarlyStoppingCallback(early_stopping_patience=2)],
            )
            trainer.train()
            res = trainer.evaluate()
            best = os.path.join(sd, "best")
            trainer.save_model(best); tok.save_pretrained(best)

            preds = trainer.predict(vds)
            pl = np.argmax(preds.predictions, axis=-1)
            report = classification_report(vds["label"], pl, target_names=[id2l[i] for i in range(n_labels)])
            print(f"\nClassification Report ({name}):\n{report}")
            return res

        # --- Main pipeline ---
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        print(f"Device: {device} ({torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'cpu'})")

        docs = [json.loads(l) for l in labeled_jsonl.strip().split("\n") if l.strip()]
        docs = [d for d in docs if d.get("confidence", 0) >= kwargs.get("min_confidence", 0)]
        print(f"Loaded {len(docs)} documents")

        texts = fetch_texts_parallel(docs, kwargs.get("max_chars", 2000))

        type_labels = [t["id"] for t in taxonomy["document_types"]]
        topic_labels = [t["id"] for t in taxonomy["topics"]]
        type2id = {l: i for i, l in enumerate(type_labels)}
        id2type = {i: l for l, i in type2id.items()}
        topic2id = {l: i for i, l in enumerate(topic_labels)}
        id2topic = {i: l for l, i in topic2id.items()}

        def prep(field, lmap):
            it, il = [], []
            for d in docs:
                t, lab = texts.get(d["id"], ""), d.get(field, "")
                if t and lab in lmap:
                    it.append(t); il.append(lmap[lab])
            return it, il

        tt, tl = prep("document_type", type2id)
        tpt, tpl = prep("document_topic", topic2id)

        vs = kwargs.get("val_split", 0.15)
        sd = kwargs.get("seed", 42)
        ttt, tvt, ttl, tvl = train_test_split(tt, tl, test_size=vs, random_state=sd, stratify=tl)
        tptt, tpvt, tptl, tpvl = train_test_split(tpt, tpl, test_size=vs, random_state=sd, stratify=tpl)

        out = "/models"
        os.makedirs(out, exist_ok=True)
        mn = kwargs.get("model_name", "xlm-roberta-base")
        ep = kwargs.get("epochs", 5)
        lr = kwargs.get("lr", 2e-5)
        bs = kwargs.get("batch_size", 16)
        ml = kwargs.get("max_length", 512)

        tr = _train_one(ttt, ttl, tvt, tvl, len(type2id), id2type, type2id, out, mn, ep, lr, bs, ml, "document_type")
        tpr = _train_one(tptt, tptl, tpvt, tpvl, len(topic2id), id2topic, topic2id, out, mn, ep, lr, bs, ml, "topic")

        config = {
            "base_model": mn, "taxonomy": taxonomy["name"],
            "taxonomy_version": taxonomy["version"], "total_docs": len(docs),
            "epochs": ep, "learning_rate": lr, "batch_size": bs,
            "results": {
                "document_type": {"accuracy": tr["eval_accuracy"], "f1_macro": tr["eval_f1_macro"]},
                "topic": {"accuracy": tpr["eval_accuracy"], "f1_macro": tpr["eval_f1_macro"]},
            },
        }
        with open(os.path.join(out, "training_config.json"), "w") as f:
            json.dump(config, f, indent=2)
        return config

    @app.function(image=training_image, volumes={"/models": model_volume})
    def collect_models() -> dict[str, bytes]:
        model_volume.reload()
        files = {}
        for root, _dirs, filenames in os.walk("/models"):
            if "/best" in root or root == "/models":
                for fname in filenames:
                    full = os.path.join(root, fname)
                    files[full.replace("/models/", "")] = open(full, "rb").read()
        return files

    print(f"Submitting training job to Modal ({gpu} GPU)...")
    print(f"  Input: {args.input} ({labeled_jsonl.count(chr(10))} lines)")
    print(f"  Model: {args.model}, Epochs: {args.epochs}")
    print()

    with app.run():
        config = train_remote.remote(
            labeled_jsonl=labeled_jsonl, taxonomy=taxonomy,
            model_name=args.model, epochs=args.epochs, lr=args.lr,
            batch_size=args.batch_size, max_length=args.max_length,
            val_split=args.val_split, min_confidence=args.min_confidence,
            max_chars=args.max_chars, seed=args.seed,
        )

        print("\n--- Results ---")
        print(json.dumps(config, indent=2))

        # Download models
        output_dir = Path(args.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        print(f"\nDownloading models to {output_dir}...")

        files = collect_models.remote()
        for rel_path, data in files.items():
            local_path = output_dir / rel_path
            local_path.parent.mkdir(parents=True, exist_ok=True)
            local_path.write_bytes(data)
            print(f"  {rel_path}")
        print(f"\nModels saved to {output_dir}/")

    return config


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="Train classifiers on labeled documents")
    parser.add_argument("--input", type=str, required=True, help="Labeled JSONL from label.py")
    parser.add_argument("--output-dir", type=str, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--model", type=str, default=DEFAULT_MODEL)
    parser.add_argument("--epochs", type=int, default=DEFAULT_EPOCHS)
    parser.add_argument("--lr", type=float, default=DEFAULT_LR)
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--max-length", type=int, default=DEFAULT_MAX_LENGTH)
    parser.add_argument("--val-split", type=float, default=DEFAULT_VAL_SPLIT)
    parser.add_argument("--min-confidence", type=float, default=0.0)
    parser.add_argument("--max-chars", type=int, default=2000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--modal", action="store_true", help="Train on Modal cloud GPU")
    parser.add_argument("--gpu", type=str, default="T4", help="Modal GPU type: T4, a10g, l4, a100")
    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(f"ERROR: Input file not found: {args.input}")
        sys.exit(1)

    if args.modal:
        run_modal(args)
    else:
        run_local(args)


if __name__ == "__main__":
    main()
