#!/usr/bin/env python3
"""
Phase 2, Step 1: Create a stratified sample of documents for LLM labeling.

Samples documents across the top 5 languages, stratified by:
- Language (proportional to corpus representation)
- Word count (small/medium/large terciles)
- Source domain diversity

Usage:
    python sample.py --total 3500 --output sampled_docs.jsonl
    python sample.py --total 3500 --output sampled_docs.jsonl --languages en,ru,cs,pl,es
"""

import argparse
import json
import random
import sys
from urllib.parse import urlparse

from common import get_db_connection

# Default top 5 languages and their approximate sample allocation
DEFAULT_LANGUAGES = ["en", "ru", "cs", "pl", "es"]


def get_documents_for_language(
    language: str, limit: int = 100000
) -> list[dict]:
    """Fetch extracted documents for a given language."""
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, source_url, original_filename, word_count, file_size_bytes
                FROM documents
                WHERE extracted_at IS NOT NULL
                  AND extraction_error IS NULL
                  AND language = %s
                  AND word_count > 0
                ORDER BY random()
                LIMIT %s
                """,
                (language, limit),
            )
            return [
                {
                    "id": row[0],
                    "source_url": row[1],
                    "original_filename": row[2],
                    "word_count": row[3],
                    "file_size_bytes": row[4],
                    "language": language,
                }
                for row in cur.fetchall()
            ]
    finally:
        conn.close()


def get_language_counts(languages: list[str]) -> dict[str, int]:
    """Get document counts for the specified languages."""
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            placeholders = ",".join(["%s"] * len(languages))
            cur.execute(
                f"""
                SELECT language, COUNT(*)::int as count
                FROM documents
                WHERE extracted_at IS NOT NULL
                  AND extraction_error IS NULL
                  AND language IN ({placeholders})
                  AND word_count > 0
                GROUP BY language
                ORDER BY count DESC
                """,
                languages,
            )
            return {row[0]: row[1] for row in cur.fetchall()}
    finally:
        conn.close()


def stratified_sample(
    docs: list[dict], n: int, seed: int = 42
) -> list[dict]:
    """
    Stratified sample by word count terciles and source domain diversity.

    Splits documents into 3 word-count bins (short/medium/long),
    samples proportionally from each, preferring diverse source domains.
    """
    rng = random.Random(seed)

    if len(docs) <= n:
        return docs

    # Sort by word count and split into terciles
    sorted_docs = sorted(docs, key=lambda d: d["word_count"])
    third = len(sorted_docs) // 3
    bins = [
        sorted_docs[:third],           # short
        sorted_docs[third : 2 * third], # medium
        sorted_docs[2 * third :],       # long
    ]

    # Sample proportionally from each bin with domain diversity
    samples_per_bin = n // 3
    remainder = n - (samples_per_bin * 3)

    result = []
    for i, bin_docs in enumerate(bins):
        target = samples_per_bin + (1 if i < remainder else 0)
        result.extend(_diverse_sample(bin_docs, target, rng))

    return result


def _diverse_sample(
    docs: list[dict], n: int, rng: random.Random
) -> list[dict]:
    """Sample n documents, preferring diverse source domains."""
    if len(docs) <= n:
        return docs

    # Group by domain
    by_domain: dict[str, list[dict]] = {}
    for doc in docs:
        try:
            domain = urlparse(doc["source_url"]).netloc
        except Exception:
            domain = "unknown"
        by_domain.setdefault(domain, []).append(doc)

    # Round-robin from domains until we have enough
    result = []
    domains = list(by_domain.keys())
    rng.shuffle(domains)

    # Shuffle within each domain
    for domain in domains:
        rng.shuffle(by_domain[domain])

    idx = {d: 0 for d in domains}
    while len(result) < n:
        added_any = False
        for domain in domains:
            if len(result) >= n:
                break
            if idx[domain] < len(by_domain[domain]):
                result.append(by_domain[domain][idx[domain]])
                idx[domain] += 1
                added_any = True
        if not added_any:
            break

    return result[:n]


def main():
    parser = argparse.ArgumentParser(
        description="Create stratified sample for LLM labeling"
    )
    parser.add_argument(
        "--total", type=int, default=3500, help="Total documents to sample (default: 3500)"
    )
    parser.add_argument(
        "--output", type=str, default="sampled_docs.jsonl", help="Output JSONL file"
    )
    parser.add_argument(
        "--languages",
        type=str,
        default=",".join(DEFAULT_LANGUAGES),
        help="Comma-separated language codes (default: en,ru,cs,pl,es)",
    )
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    args = parser.parse_args()

    languages = [l.strip() for l in args.languages.split(",")]

    print("=" * 60)
    print("Stratified Document Sampling")
    print("=" * 60)

    # Get language counts
    print(f"\nFetching counts for languages: {languages}")
    counts = get_language_counts(languages)
    total_docs = sum(counts.values())

    print(f"\nLanguage distribution:")
    for lang, count in sorted(counts.items(), key=lambda x: -x[1]):
        pct = 100 * count / total_docs
        print(f"  {lang}: {count:,} ({pct:.1f}%)")
    print(f"  Total: {total_docs:,}")

    # Calculate per-language sample sizes (proportional)
    min_per_lang = min(50, args.total // len(counts))
    allocations = {}
    for lang, count in counts.items():
        proportion = count / total_docs
        allocations[lang] = max(min_per_lang, round(args.total * proportion))

    # Adjust to hit exact total
    allocated = sum(allocations.values())
    if allocated != args.total:
        diff = args.total - allocated
        # Add/remove from largest language
        largest = max(allocations, key=allocations.get)
        allocations[largest] = max(1, allocations[largest] + diff)

    print(f"\nSample allocation (total={args.total}):")
    for lang in sorted(allocations, key=lambda l: -allocations[l]):
        print(f"  {lang}: {allocations[lang]}")

    # Sample from each language
    all_samples = []
    for lang, n_samples in allocations.items():
        print(f"\nSampling {n_samples} from {lang}...")
        # Fetch more than needed to allow stratification
        docs = get_documents_for_language(lang, limit=min(n_samples * 10, 100000))
        print(f"  Fetched {len(docs):,} candidates")

        sampled = stratified_sample(docs, n_samples, seed=args.seed)
        all_samples.extend(sampled)
        print(f"  Selected {len(sampled)} documents")

        # Show word count distribution of sample
        word_counts = [d["word_count"] for d in sampled if d["word_count"]]
        if word_counts:
            print(
                f"  Word count: min={min(word_counts):,}, "
                f"median={sorted(word_counts)[len(word_counts)//2]:,}, "
                f"max={max(word_counts):,}"
            )

    # Save
    with open(args.output, "w") as f:
        for doc in all_samples:
            f.write(json.dumps(doc) + "\n")

    print(f"\n{'=' * 60}")
    print(f"Saved {len(all_samples)} documents to {args.output}")
    print(f"{'=' * 60}")
    print(f"\nNext step: python label.py --input {args.output} --output labeled_docs.jsonl")


if __name__ == "__main__":
    main()
