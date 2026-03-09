#!/usr/bin/env python3
"""
Evaluate classification quality.

Can evaluate:
  1. LLM labels (from label.py) — confidence distribution, class balance
  2. Trained models (from train.py) — val set metrics
  3. Full corpus (from classify.py) — distribution analysis from DB

Usage:
    python evaluate.py labels --input labeled_docs.jsonl
    python evaluate.py corpus
    python evaluate.py corpus --languages en,ru
"""

import argparse
import json
import os
import sys

from common import get_db_connection, load_taxonomy


def evaluate_labels(input_path: str, taxonomy: dict):
    """Evaluate LLM-labeled data: distribution, confidence, quality signals."""
    docs = []
    with open(input_path) as f:
        for line in f:
            if line.strip():
                docs.append(json.loads(line))

    print(f"\n{'=' * 60}")
    print(f"LLM Label Evaluation ({len(docs)} documents)")
    print(f"{'=' * 60}")

    # Class distribution - document types
    type_counts: dict[str, int] = {}
    topic_counts: dict[str, int] = {}
    lang_counts: dict[str, int] = {}

    type_confs: dict[str, list[float]] = {}
    topic_confs: dict[str, list[float]] = {}

    for doc in docs:
        dt = doc.get("document_type", "unknown")
        tp = doc.get("document_topic", "unknown")
        lang = doc.get("language", "unknown")

        type_counts[dt] = type_counts.get(dt, 0) + 1
        topic_counts[tp] = topic_counts.get(tp, 0) + 1
        lang_counts[lang] = lang_counts.get(lang, 0) + 1

        type_confs.setdefault(dt, []).append(doc.get("type_confidence", 0))
        topic_confs.setdefault(tp, []).append(doc.get("topic_confidence", 0))

    # Document type distribution
    print("\nDocument Type Distribution:")
    print(f"  {'Type':<20s} {'Count':>6s} {'%':>7s} {'Avg Conf':>10s}")
    print(f"  {'-' * 45}")
    for t, c in sorted(type_counts.items(), key=lambda x: -x[1]):
        pct = 100 * c / len(docs)
        avg_conf = sum(type_confs[t]) / len(type_confs[t]) if type_confs.get(t) else 0
        print(f"  {t:<20s} {c:>6d} {pct:>6.1f}% {avg_conf:>9.3f}")

    # Topic distribution
    print("\nTopic Distribution:")
    print(f"  {'Topic':<20s} {'Count':>6s} {'%':>7s} {'Avg Conf':>10s}")
    print(f"  {'-' * 45}")
    for t, c in sorted(topic_counts.items(), key=lambda x: -x[1]):
        pct = 100 * c / len(docs)
        avg_conf = sum(topic_confs[t]) / len(topic_confs[t]) if topic_confs.get(t) else 0
        print(f"  {t:<20s} {c:>6d} {pct:>6.1f}% {avg_conf:>9.3f}")

    # Language distribution
    print("\nLanguage Distribution:")
    for lang, c in sorted(lang_counts.items(), key=lambda x: -x[1]):
        pct = 100 * c / len(docs)
        print(f"  {lang:<5s}: {c:>6d} ({pct:.1f}%)")

    # Overall confidence stats
    all_confs = [doc.get("confidence", 0) for doc in docs]
    if all_confs:
        avg = sum(all_confs) / len(all_confs)
        low = sum(1 for c in all_confs if c < 0.5)
        med = sum(1 for c in all_confs if 0.5 <= c < 0.8)
        high = sum(1 for c in all_confs if c >= 0.8)
        print(f"\nConfidence Distribution:")
        print(f"  Mean: {avg:.3f}")
        print(f"  High (>=0.8): {high:>5d} ({100 * high / len(all_confs):.1f}%)")
        print(f"  Medium (0.5-0.8): {med:>5d} ({100 * med / len(all_confs):.1f}%)")
        print(f"  Low (<0.5): {low:>5d} ({100 * low / len(all_confs):.1f}%)")

    # Parse failures
    failed = sum(1 for doc in docs if doc.get("reasoning") == "Failed to parse LLM response")
    if failed:
        print(f"\n  Parse failures: {failed} ({100 * failed / len(docs):.1f}%)")

    # Cross-tabulation (type x topic)
    print("\nType x Topic Cross-tabulation (top 5 combos):")
    combos: dict[str, int] = {}
    for doc in docs:
        key = f"{doc.get('document_type', '?')} + {doc.get('document_topic', '?')}"
        combos[key] = combos.get(key, 0) + 1
    for combo, c in sorted(combos.items(), key=lambda x: -x[1])[:10]:
        pct = 100 * c / len(docs)
        print(f"  {combo:<40s} {c:>5d} ({pct:.1f}%)")

    # Check for taxonomy coverage
    valid_types = {t["id"] for t in taxonomy["document_types"]}
    valid_topics = {t["id"] for t in taxonomy["topics"]}
    missing_types = valid_types - set(type_counts.keys())
    missing_topics = valid_topics - set(topic_counts.keys())
    if missing_types:
        print(f"\n  Unused document types: {missing_types}")
    if missing_topics:
        print(f"  Unused topics: {missing_topics}")


def evaluate_corpus(languages: list[str] | None = None):
    """Evaluate classification results from the database."""
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            # Overall stats
            cur.execute("""
                SELECT
                    COUNT(*)::int as total,
                    COUNT(CASE WHEN classification_model IS NOT NULL THEN 1 END)::int as classified,
                    COUNT(CASE WHEN extracted_at IS NOT NULL AND extraction_error IS NULL THEN 1 END)::int as extracted
                FROM documents
            """)
            row = cur.fetchone()
            total, classified, extracted = row

            print(f"\n{'=' * 60}")
            print(f"Corpus Classification Status")
            print(f"{'=' * 60}")
            print(f"  Total documents: {total:,}")
            print(f"  Extracted: {extracted:,}")
            print(f"  Classified: {classified:,} ({100 * classified / max(extracted, 1):.1f}% of extracted)")

            if classified == 0:
                print("\n  No classified documents yet.")
                return

            # Build language filter
            lang_filter = ""
            params: list = []
            if languages:
                placeholders = ",".join(["%s"] * len(languages))
                lang_filter = f"AND language IN ({placeholders})"
                params = list(languages)

            # Document type distribution
            cur.execute(
                f"""
                SELECT document_type, COUNT(*)::int as count,
                       ROUND(AVG(classification_confidence)::numeric, 3) as avg_conf
                FROM documents
                WHERE classification_model IS NOT NULL {lang_filter}
                GROUP BY document_type
                ORDER BY count DESC
                """,
                params,
            )
            rows = cur.fetchall()

            scope = f" (languages: {','.join(languages)})" if languages else ""
            print(f"\nDocument Type Distribution{scope}:")
            print(f"  {'Type':<20s} {'Count':>8s} {'%':>7s} {'Avg Conf':>10s}")
            print(f"  {'-' * 47}")
            row_total = sum(r[1] for r in rows)
            for dt, count, avg_conf in rows:
                pct = 100 * count / row_total
                print(f"  {dt or 'null':<20s} {count:>8,d} {pct:>6.1f}% {avg_conf or 0:>9.3f}")

            # Topic distribution
            cur.execute(
                f"""
                SELECT document_topic, COUNT(*)::int as count,
                       ROUND(AVG(classification_confidence)::numeric, 3) as avg_conf
                FROM documents
                WHERE classification_model IS NOT NULL {lang_filter}
                GROUP BY document_topic
                ORDER BY count DESC
                """,
                params,
            )
            rows = cur.fetchall()

            print(f"\nTopic Distribution{scope}:")
            print(f"  {'Topic':<20s} {'Count':>8s} {'%':>7s} {'Avg Conf':>10s}")
            print(f"  {'-' * 47}")
            for tp, count, avg_conf in rows:
                pct = 100 * count / row_total
                print(f"  {tp or 'null':<20s} {count:>8,d} {pct:>6.1f}% {avg_conf or 0:>9.3f}")

            # By language
            cur.execute(
                f"""
                SELECT language, COUNT(*)::int as count
                FROM documents
                WHERE classification_model IS NOT NULL {lang_filter}
                GROUP BY language
                ORDER BY count DESC
                LIMIT 20
                """,
                params,
            )
            rows = cur.fetchall()

            print(f"\nBy Language (top 20):")
            for lang, count in rows:
                pct = 100 * count / row_total
                print(f"  {lang or '?':<5s}: {count:>8,d} ({pct:.1f}%)")

            # Confidence distribution
            cur.execute(
                f"""
                SELECT
                    COUNT(CASE WHEN classification_confidence >= 0.8 THEN 1 END)::int as high,
                    COUNT(CASE WHEN classification_confidence >= 0.5 AND classification_confidence < 0.8 THEN 1 END)::int as med,
                    COUNT(CASE WHEN classification_confidence < 0.5 THEN 1 END)::int as low,
                    ROUND(AVG(classification_confidence)::numeric, 3) as avg
                FROM documents
                WHERE classification_model IS NOT NULL {lang_filter}
                """,
                params,
            )
            row = cur.fetchone()
            print(f"\nConfidence Distribution:")
            print(f"  Mean: {row[3]}")
            print(f"  High (>=0.8): {row[0]:>8,d} ({100 * row[0] / row_total:.1f}%)")
            print(f"  Medium (0.5-0.8): {row[1]:>8,d} ({100 * row[1] / row_total:.1f}%)")
            print(f"  Low (<0.5): {row[2]:>8,d} ({100 * row[2] / row_total:.1f}%)")

            # Classification model used
            cur.execute(
                f"""
                SELECT classification_model, COUNT(*)::int
                FROM documents
                WHERE classification_model IS NOT NULL {lang_filter}
                GROUP BY classification_model
                """,
                params,
            )
            rows = cur.fetchall()
            print(f"\nModels Used:")
            for model, count in rows:
                print(f"  {model}: {count:,}")

    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser(description="Evaluate classification quality")
    subparsers = parser.add_subparsers(dest="command", help="Evaluation mode")

    # Labels subcommand
    labels_parser = subparsers.add_parser(
        "labels", help="Evaluate LLM-labeled data"
    )
    labels_parser.add_argument(
        "--input", type=str, required=True, help="Labeled JSONL file"
    )

    # Corpus subcommand
    corpus_parser = subparsers.add_parser(
        "corpus", help="Evaluate corpus classification from DB"
    )
    corpus_parser.add_argument(
        "--languages",
        type=str,
        default=None,
        help="Comma-separated language codes to filter",
    )

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    taxonomy = load_taxonomy()

    if args.command == "labels":
        if not os.path.exists(args.input):
            print(f"ERROR: File not found: {args.input}")
            sys.exit(1)
        evaluate_labels(args.input, taxonomy)

    elif args.command == "corpus":
        languages = (
            [l.strip() for l in args.languages.split(",")]
            if args.languages
            else None
        )
        evaluate_corpus(languages=languages)


if __name__ == "__main__":
    main()
