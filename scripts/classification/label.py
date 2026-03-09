#!/usr/bin/env python3
"""
Phase 2, Step 2: LLM-label sampled documents using Claude.

Reads a JSONL of sampled documents, fetches their text, sends to Claude
for classification, and saves labeled results.

Supports resume — already-labeled documents are skipped.

Usage:
    python label.py --input sampled_docs.jsonl --output labeled_docs.jsonl
    python label.py --input sampled_docs.jsonl --output labeled_docs.jsonl --model claude-haiku-4-5
    python label.py --input sampled_docs.jsonl --output labeled_docs.jsonl --parallel 5
"""

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

import anthropic
from tqdm import tqdm

from common import fetch_documents_text_parallel, load_taxonomy

# Rate limiting defaults
DEFAULT_PARALLEL = 5
DEFAULT_RPM = 50
DEFAULT_DELAY = 1.5


def build_classification_prompt(taxonomy: dict, text: str, filename: str | None) -> str:
    """Build the prompt for Claude to classify a single document."""
    doc_types = "\n".join(
        f"  - **{t['id']}**: {t['label']} — {t['description']}"
        for t in taxonomy["document_types"]
    )
    topics = "\n".join(
        f"  - **{t['id']}**: {t['label']} — {t['description']}"
        for t in taxonomy["topics"]
    )

    filename_line = f"\n- Filename: {filename}" if filename else ""

    return f"""Classify this document along two independent dimensions.

## Dimension 1: Document Type (what kind of document is this?)
{doc_types}

## Dimension 2: Topic (what subject domain does it belong to?)
{topics}

## Document{filename_line}
\"\"\"
{text}
\"\"\"

## Instructions
1. Read the document text carefully
2. Choose the BEST matching document_type from Dimension 1
3. Choose the BEST matching topic from Dimension 2
4. These are INDEPENDENT — a "legal" type document can have any topic, and vice versa
5. Provide confidence scores (0.0-1.0) for each choice

Respond with ONLY this JSON:
{{"document_type": {{"id": "<type_id>", "confidence": <0.0-1.0>}}, "topic": {{"id": "<topic_id>", "confidence": <0.0-1.0>}}, "reasoning": "<1 sentence>"}}"""


def parse_llm_response(text: str, taxonomy: dict) -> dict:
    """Parse and validate LLM classification response."""
    import re

    valid_types = {t["id"] for t in taxonomy["document_types"]}
    valid_topics = {t["id"] for t in taxonomy["topics"]}

    try:
        json_match = re.search(r"\{[\s\S]*\}", text)
        if json_match:
            result = json.loads(json_match.group())
            doc_type = result["document_type"]["id"]
            topic = result["topic"]["id"]

            # Validate against taxonomy
            if doc_type not in valid_types:
                doc_type = "general" if "general" in valid_types else list(valid_types)[0]
            if topic not in valid_topics:
                topic = "general" if "general" in valid_topics else list(valid_topics)[0]

            return {
                "document_type": doc_type,
                "document_topic": topic,
                "type_confidence": float(result["document_type"]["confidence"]),
                "topic_confidence": float(result["topic"]["confidence"]),
                "confidence": min(
                    float(result["document_type"]["confidence"]),
                    float(result["topic"]["confidence"]),
                ),
                "reasoning": result.get("reasoning", ""),
            }
    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
        pass

    return {
        "document_type": "general",
        "document_topic": "general",
        "type_confidence": 0.0,
        "topic_confidence": 0.0,
        "confidence": 0.0,
        "reasoning": "Failed to parse LLM response",
    }


def load_existing_results(output_path: str) -> dict[str, dict]:
    """Load already-labeled documents for resume support."""
    results = {}
    if os.path.exists(output_path):
        with open(output_path) as f:
            for line in f:
                if line.strip():
                    entry = json.loads(line)
                    results[entry["id"]] = entry
    return results


def append_result(output_path: str, result: dict):
    """Append a single labeled result to the output file."""
    with open(output_path, "a") as f:
        f.write(json.dumps(result) + "\n")


async def label_documents(
    docs: list[dict],
    taxonomy: dict,
    output_path: str,
    model: str,
    max_parallel: int,
    rpm: int,
    delay: float,
):
    """Label all documents with Claude, with rate limiting and resume."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ERROR: ANTHROPIC_API_KEY environment variable not set")
        sys.exit(1)

    client = anthropic.AsyncAnthropic(api_key=api_key)
    semaphore = asyncio.Semaphore(max_parallel)

    # Load existing results for resume
    existing = load_existing_results(output_path)
    remaining = [d for d in docs if d["id"] not in existing]

    if existing:
        print(f"  Resuming: {len(existing)} already labeled, {len(remaining)} remaining")

    if not remaining:
        print("  All documents already labeled!")
        return existing

    # Prefetch text for all remaining documents
    print(f"  Fetching text for {len(remaining)} documents...")
    doc_ids = [d["id"] for d in remaining]

    # Fetch in batches to avoid overwhelming the server
    all_texts = {}
    batch_size = 100
    for i in range(0, len(doc_ids), batch_size):
        batch = doc_ids[i : i + batch_size]
        texts = fetch_documents_text_parallel(batch, max_chars=2000)
        all_texts.update(texts)
        if i + batch_size < len(doc_ids):
            print(f"    Fetched text: {min(i + batch_size, len(doc_ids))}/{len(doc_ids)}")

    print(f"  Text fetched. Starting LLM classification with {model}...")

    # Rate limiting
    interval = 60.0 / rpm
    last_request = [0.0]
    lock = asyncio.Lock()

    async def rate_limit():
        async with lock:
            now = time.time()
            wait = last_request[0] + max(interval, delay) - now
            if wait > 0:
                await asyncio.sleep(wait)
            last_request[0] = time.time()

    completed = [0]
    errors = [0]
    pbar = tqdm(total=len(remaining), desc="Labeling", unit="doc")

    async def classify_one(doc: dict) -> dict | None:
        text = all_texts.get(doc["id"], "")
        if not text:
            errors[0] += 1
            pbar.update(1)
            return None

        prompt = build_classification_prompt(taxonomy, text, doc.get("original_filename"))

        max_retries = 5
        for attempt in range(max_retries):
            await rate_limit()
            async with semaphore:
                try:
                    response = await client.messages.create(
                        model=model,
                        max_tokens=256,
                        messages=[{"role": "user", "content": prompt}],
                    )
                    classification = parse_llm_response(
                        response.content[0].text, taxonomy
                    )

                    result = {
                        "id": doc["id"],
                        "language": doc.get("language"),
                        "word_count": doc.get("word_count"),
                        "original_filename": doc.get("original_filename"),
                        "source_url": doc.get("source_url"),
                        **classification,
                        "model": model,
                    }

                    append_result(output_path, result)
                    completed[0] += 1
                    pbar.update(1)
                    return result

                except anthropic.RateLimitError:
                    wait = min(10 * (2**attempt), 60)
                    pbar.set_postfix_str(f"rate limited, waiting {wait}s")
                    await asyncio.sleep(wait)
                except Exception as e:
                    if attempt == max_retries - 1:
                        errors[0] += 1
                        pbar.update(1)
                        pbar.set_postfix_str(f"error: {str(e)[:50]}")
                        return None
                    await asyncio.sleep(2)

        return None

    # Process all documents
    tasks = [classify_one(doc) for doc in remaining]
    results = await asyncio.gather(*tasks)
    pbar.close()

    # Merge with existing
    all_results = dict(existing)
    for r in results:
        if r:
            all_results[r["id"]] = r

    print(f"\n  Completed: {completed[0]}, Errors: {errors[0]}")
    return all_results


def print_summary(output_path: str, taxonomy: dict):
    """Print classification distribution summary."""
    results = load_existing_results(output_path)
    if not results:
        return

    print(f"\n{'=' * 60}")
    print(f"Classification Summary ({len(results)} documents)")
    print(f"{'=' * 60}")

    # By document type
    type_counts: dict[str, int] = {}
    topic_counts: dict[str, int] = {}
    lang_counts: dict[str, int] = {}

    for r in results.values():
        dt = r.get("document_type", "unknown")
        tp = r.get("document_topic", "unknown")
        lang = r.get("language", "unknown")
        type_counts[dt] = type_counts.get(dt, 0) + 1
        topic_counts[tp] = topic_counts.get(tp, 0) + 1
        lang_counts[lang] = lang_counts.get(lang, 0) + 1

    print("\nBy Document Type:")
    for t, c in sorted(type_counts.items(), key=lambda x: -x[1]):
        pct = 100 * c / len(results)
        print(f"  {t:20s}: {c:5d} ({pct:5.1f}%)")

    print("\nBy Topic:")
    for t, c in sorted(topic_counts.items(), key=lambda x: -x[1]):
        pct = 100 * c / len(results)
        print(f"  {t:20s}: {c:5d} ({pct:5.1f}%)")

    print("\nBy Language:")
    for t, c in sorted(lang_counts.items(), key=lambda x: -x[1]):
        pct = 100 * c / len(results)
        print(f"  {t:5s}: {c:5d} ({pct:5.1f}%)")

    # Confidence stats
    confidences = [r["confidence"] for r in results.values() if "confidence" in r]
    if confidences:
        avg = sum(confidences) / len(confidences)
        low = sum(1 for c in confidences if c < 0.6)
        print(f"\nConfidence: avg={avg:.2f}, <60%={low} ({100*low/len(confidences):.1f}%)")


def main():
    parser = argparse.ArgumentParser(
        description="LLM-label sampled documents using Claude"
    )
    parser.add_argument(
        "--input", type=str, required=True, help="Input JSONL from sample.py"
    )
    parser.add_argument(
        "--output", type=str, default="labeled_docs.jsonl", help="Output JSONL"
    )
    parser.add_argument(
        "--model", type=str, default="claude-haiku-4-5", help="Claude model"
    )
    parser.add_argument(
        "--parallel", type=int, default=DEFAULT_PARALLEL, help="Max parallel requests"
    )
    parser.add_argument(
        "--rpm", type=int, default=DEFAULT_RPM, help="Requests per minute limit"
    )
    parser.add_argument(
        "--delay", type=float, default=DEFAULT_DELAY, help="Min delay between requests"
    )
    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(f"ERROR: Input file not found: {args.input}")
        sys.exit(1)

    # Load taxonomy
    taxonomy = load_taxonomy()
    print(f"Taxonomy: {taxonomy['name']} v{taxonomy['version']}")
    print(f"  Document types: {len(taxonomy['document_types'])}")
    print(f"  Topics: {len(taxonomy['topics'])}")

    # Load sampled documents
    docs = []
    with open(args.input) as f:
        for line in f:
            if line.strip():
                docs.append(json.loads(line))

    print(f"\nDocuments to label: {len(docs)}")
    print(f"Model: {args.model}")
    print(f"Parallel: {args.parallel}, RPM: {args.rpm}, Delay: {args.delay}s")
    print()

    # Run labeling
    asyncio.run(
        label_documents(
            docs=docs,
            taxonomy=taxonomy,
            output_path=args.output,
            model=args.model,
            max_parallel=args.parallel,
            rpm=args.rpm,
            delay=args.delay,
        )
    )

    # Print summary
    print_summary(args.output, taxonomy)

    print(f"\nNext step: python train.py --input {args.output}")


if __name__ == "__main__":
    main()
