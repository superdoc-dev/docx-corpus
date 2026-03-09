#!/usr/bin/env python3
"""
Phase 3: Train ModernBERT classifiers on LLM-labeled documents.

Trains two independent classifiers:
  1. Document type (10 classes)
  2. Topic (9 classes)

Uses HuggingFace Transformers with the answerdotai/ModernBERT-base model.
Supports configurable train/val split, epochs, learning rate, etc.

Usage:
    python train.py --input labeled_docs.jsonl
    python train.py --input labeled_docs.jsonl --epochs 5 --lr 2e-5
    python train.py --input labeled_docs.jsonl --output-dir ./models
"""

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
import torch
from datasets import Dataset
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    f1_score,
)
from sklearn.model_selection import train_test_split
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    EarlyStoppingCallback,
    Trainer,
    TrainingArguments,
)

from common import fetch_documents_text_parallel, load_taxonomy

DEFAULT_MODEL = "answerdotai/ModernBERT-base"
DEFAULT_EPOCHS = 5
DEFAULT_LR = 2e-5
DEFAULT_BATCH_SIZE = 16
DEFAULT_MAX_LENGTH = 512
DEFAULT_VAL_SPLIT = 0.15
DEFAULT_OUTPUT_DIR = "./models"


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


def fetch_texts(docs: list[dict], max_chars: int = 2000) -> dict[str, str]:
    """Fetch document texts in parallel batches."""
    doc_ids = [d["id"] for d in docs]
    all_texts = {}
    batch_size = 100
    for i in range(0, len(doc_ids), batch_size):
        batch = doc_ids[i : i + batch_size]
        texts = fetch_documents_text_parallel(batch, max_chars=max_chars)
        all_texts.update(texts)
        fetched = min(i + batch_size, len(doc_ids))
        if fetched < len(doc_ids):
            print(f"  Fetched text: {fetched}/{len(doc_ids)}")
    return all_texts


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
    acc = accuracy_score(labels, preds)
    f1 = f1_score(labels, preds, average="macro")
    return {"accuracy": acc, "f1_macro": f1}


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
    print(f"  Classes: {num_labels}")
    print(f"  Model: {model_name}")
    print(f"  Epochs: {epochs}, LR: {lr}, Batch: {batch_size}")
    print(f"{'=' * 60}")

    tokenizer = AutoTokenizer.from_pretrained(model_name)
    model = AutoModelForSequenceClassification.from_pretrained(
        model_name,
        num_labels=num_labels,
        id2label=id2label,
        label2id=label2id,
    )

    def tokenize(examples):
        return tokenizer(
            examples["text"],
            truncation=True,
            max_length=max_length,
            padding="max_length",
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

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_ds,
        eval_dataset=val_ds,
        compute_metrics=compute_metrics,
        callbacks=[EarlyStoppingCallback(early_stopping_patience=2)],
    )

    trainer.train()

    # Evaluate on validation set
    eval_results = trainer.evaluate()
    print(f"\n  Val accuracy: {eval_results['eval_accuracy']:.4f}")
    print(f"  Val F1 macro: {eval_results['eval_f1_macro']:.4f}")

    # Save best model
    best_dir = os.path.join(save_dir, "best")
    trainer.save_model(best_dir)
    tokenizer.save_pretrained(best_dir)

    # Full classification report on val set
    preds = trainer.predict(val_ds)
    pred_labels = np.argmax(preds.predictions, axis=-1)
    report = classification_report(
        val_ds["label"],
        pred_labels,
        target_names=[id2label[i] for i in range(num_labels)],
    )
    print(f"\nClassification Report ({classifier_name}):\n{report}")

    # Save report
    report_path = os.path.join(save_dir, "eval_report.txt")
    with open(report_path, "w") as f:
        f.write(f"Model: {model_name}\n")
        f.write(f"Classifier: {classifier_name}\n")
        f.write(f"Train size: {len(train_texts)}\n")
        f.write(f"Val size: {len(val_texts)}\n")
        f.write(f"Epochs: {epochs}\n")
        f.write(f"Val accuracy: {eval_results['eval_accuracy']:.4f}\n")
        f.write(f"Val F1 macro: {eval_results['eval_f1_macro']:.4f}\n\n")
        f.write(report)

    return eval_results


def main():
    parser = argparse.ArgumentParser(
        description="Train ModernBERT classifiers on labeled documents"
    )
    parser.add_argument(
        "--input", type=str, required=True, help="Labeled JSONL from label.py"
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default=DEFAULT_OUTPUT_DIR,
        help=f"Output directory for models (default: {DEFAULT_OUTPUT_DIR})",
    )
    parser.add_argument(
        "--model",
        type=str,
        default=DEFAULT_MODEL,
        help=f"Base model (default: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--epochs",
        type=int,
        default=DEFAULT_EPOCHS,
        help=f"Training epochs (default: {DEFAULT_EPOCHS})",
    )
    parser.add_argument(
        "--lr",
        type=float,
        default=DEFAULT_LR,
        help=f"Learning rate (default: {DEFAULT_LR})",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=DEFAULT_BATCH_SIZE,
        help=f"Batch size (default: {DEFAULT_BATCH_SIZE})",
    )
    parser.add_argument(
        "--max-length",
        type=int,
        default=DEFAULT_MAX_LENGTH,
        help=f"Max token length (default: {DEFAULT_MAX_LENGTH})",
    )
    parser.add_argument(
        "--val-split",
        type=float,
        default=DEFAULT_VAL_SPLIT,
        help=f"Validation split ratio (default: {DEFAULT_VAL_SPLIT})",
    )
    parser.add_argument(
        "--min-confidence",
        type=float,
        default=0.0,
        help="Minimum LLM confidence to include (default: 0.0)",
    )
    parser.add_argument(
        "--max-chars",
        type=int,
        default=2000,
        help="Max characters of document text (default: 2000)",
    )
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(f"ERROR: Input file not found: {args.input}")
        sys.exit(1)

    # Load taxonomy and label maps
    taxonomy = load_taxonomy()
    type2id, id2type, topic2id, id2topic = build_label_maps(taxonomy)
    print(f"Taxonomy: {taxonomy['name']} v{taxonomy['version']}")
    print(f"  Document types: {len(type2id)} classes")
    print(f"  Topics: {len(topic2id)} classes")

    # Load labeled data
    docs = load_labeled_data(args.input, min_confidence=args.min_confidence)
    print(f"\nLoaded {len(docs)} labeled documents")
    if args.min_confidence > 0:
        print(f"  (filtered by confidence >= {args.min_confidence})")

    # Fetch texts
    print(f"\nFetching document texts (max {args.max_chars} chars)...")
    texts = fetch_texts(docs, max_chars=args.max_chars)
    print(f"  Got text for {sum(1 for t in texts.values() if t)}/{len(docs)} docs")

    # Prepare datasets for both classifiers
    print("\nPreparing document_type dataset...")
    type_texts, type_labels = prepare_dataset(docs, texts, type2id, "document_type")
    print(f"  {len(type_texts)} examples across {len(set(type_labels))} classes")

    print("Preparing topic dataset...")
    topic_texts, topic_labels = prepare_dataset(docs, texts, topic2id, "document_topic")
    print(f"  {len(topic_texts)} examples across {len(set(topic_labels))} classes")

    # Split into train/val (same split for both to keep comparable)
    print(f"\nSplitting: {1 - args.val_split:.0%} train / {args.val_split:.0%} val")

    type_train_texts, type_val_texts, type_train_labels, type_val_labels = (
        train_test_split(
            type_texts,
            type_labels,
            test_size=args.val_split,
            random_state=args.seed,
            stratify=type_labels,
        )
    )

    topic_train_texts, topic_val_texts, topic_train_labels, topic_val_labels = (
        train_test_split(
            topic_texts,
            topic_labels,
            test_size=args.val_split,
            random_state=args.seed,
            stratify=topic_labels,
        )
    )

    os.makedirs(args.output_dir, exist_ok=True)

    # Train document_type classifier
    type_results = train_classifier(
        train_texts=type_train_texts,
        train_labels=type_train_labels,
        val_texts=type_val_texts,
        val_labels=type_val_labels,
        num_labels=len(type2id),
        id2label=id2type,
        label2id=type2id,
        output_dir=args.output_dir,
        model_name=args.model,
        epochs=args.epochs,
        lr=args.lr,
        batch_size=args.batch_size,
        max_length=args.max_length,
        classifier_name="document_type",
    )

    # Train topic classifier
    topic_results = train_classifier(
        train_texts=topic_train_texts,
        train_labels=topic_train_labels,
        val_texts=topic_val_texts,
        val_labels=topic_val_labels,
        num_labels=len(topic2id),
        id2label=id2topic,
        label2id=topic2id,
        output_dir=args.output_dir,
        model_name=args.model,
        epochs=args.epochs,
        lr=args.lr,
        batch_size=args.batch_size,
        max_length=args.max_length,
        classifier_name="topic",
    )

    # Summary
    print(f"\n{'=' * 60}")
    print("Training Complete")
    print(f"{'=' * 60}")
    print(f"  Document Type — Acc: {type_results['eval_accuracy']:.4f}, F1: {type_results['eval_f1_macro']:.4f}")
    print(f"  Topic         — Acc: {topic_results['eval_accuracy']:.4f}, F1: {topic_results['eval_f1_macro']:.4f}")
    print(f"\n  Models saved to: {args.output_dir}/")
    print(f"    {args.output_dir}/document_type/best/")
    print(f"    {args.output_dir}/topic/best/")

    # Save training config
    config = {
        "base_model": args.model,
        "taxonomy": taxonomy["name"],
        "taxonomy_version": taxonomy["version"],
        "input_file": args.input,
        "total_docs": len(docs),
        "min_confidence": args.min_confidence,
        "max_chars": args.max_chars,
        "max_length": args.max_length,
        "epochs": args.epochs,
        "learning_rate": args.lr,
        "batch_size": args.batch_size,
        "val_split": args.val_split,
        "seed": args.seed,
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
    config_path = os.path.join(args.output_dir, "training_config.json")
    with open(config_path, "w") as f:
        json.dump(config, f, indent=2)
    print(f"  Config saved to: {config_path}")

    print(f"\nNext step: python classify.py --models-dir {args.output_dir}")


if __name__ == "__main__":
    main()
