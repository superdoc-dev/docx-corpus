# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "psycopg2-binary>=2.9.0",
#     "pyarrow>=18.0.0",
#     "huggingface_hub>=0.27.0",
#     "python-dotenv>=1.0.0",
#     "tqdm>=4.66.0",
# ]
# ///
"""
Export docx-corpus metadata to HuggingFace as a Parquet dataset.

Usage:
    uv run scripts/export-hf.py                    # dry-run: export parquet locally
    uv run scripts/export-hf.py --push             # export and push to HuggingFace
    uv run scripts/export-hf.py --push --private   # push as private dataset
"""

import argparse
import os
import tempfile
from pathlib import Path

import psycopg2
import pyarrow as pa
import pyarrow.parquet as pq
from dotenv import load_dotenv
from tqdm import tqdm

# Load .env from project root
load_dotenv(Path(__file__).parent.parent / ".env")

REPO_ID = "superdoc-dev/docx-corpus"
R2_BASE = "https://docxcorp.us/documents"

DATASET_CARD = """\
---
license: odc-by
task_categories:
  - text-classification
language:
  - en
  - ru
  - cs
  - pl
  - es
  - zh
  - lt
  - sk
  - fr
  - pt
  - de
  - it
  - sv
  - nl
  - bg
  - uk
  - tr
  - ja
  - hu
  - ko
size_categories:
  - 100K<n<1M
tags:
  - docx
  - word-documents
  - document-classification
  - ooxml
pretty_name: docx-corpus
---

# docx-corpus

The largest classified corpus of Word documents. 736K+ `.docx` files from the public web, classified into 10 document types and 9 topics across 76 languages.

## Dataset Description

This dataset contains metadata for publicly available `.docx` files collected from the web. Each document has been classified by document type and topic using a two-stage pipeline: LLM labeling (Claude) of a stratified sample, followed by fine-tuned XLM-RoBERTa classifiers applied at scale.

### Schema

| Column | Type | Description |
|--------|------|-------------|
| `id` | string | SHA-256 hash of the file (unique identifier) |
| `filename` | string | Original filename from the source URL |
| `type` | string | Document type (10 classes) |
| `topic` | string | Document topic (9 classes) |
| `language` | string | Detected language (ISO 639-1 code) |
| `word_count` | int | Number of words in the document |
| `confidence` | float | Classification confidence (min of type and topic) |
| `url` | string | Direct download URL for the `.docx` file |

### Document Types

legal, forms, reports, policies, educational, correspondence, technical, administrative, creative, reference

### Topics

government, education, healthcare, finance, legal_judicial, technology, environment, nonprofit, general

## Download Files

Each row includes a `url` column pointing to the `.docx` file on our CDN. You can download files directly:

```python
from datasets import load_dataset
import requests

ds = load_dataset("superdoc-dev/docx-corpus", split="train")

# Filter and download
legal_en = ds.filter(lambda x: x["type"] == "legal" and x["language"] == "en")
for row in legal_en:
    resp = requests.get(row["url"])
    with open(f"corpus/{row['id']}.docx", "wb") as f:
        f.write(resp.content)
```

Or use the manifest API for bulk downloads:

```bash
curl "https://api.docxcorp.us/manifest?type=legal&lang=en" -o manifest.txt
wget -i manifest.txt -P ./corpus/
```

## Links

- **Website**: [docxcorp.us](https://docxcorp.us)
- **GitHub**: [superdoc-dev/docx-corpus](https://github.com/superdoc-dev/docx-corpus)
- **Built by**: [SuperDoc](https://superdoc.dev)
"""


def export_parquet(output_path: str) -> int:
    """Query Neon and write metadata to a Parquet file. Returns row count."""
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise ValueError("DATABASE_URL not set — check .env file")

    conn = psycopg2.connect(database_url)
    try:
        with conn.cursor("export_cursor") as cur:
            cur.itersize = 10_000
            cur.execute("""
                SELECT id, original_filename, document_type, document_topic,
                       language, word_count, classification_confidence
                FROM documents
                WHERE document_type IS NOT NULL
                ORDER BY id
            """)

            ids, filenames, types, topics = [], [], [], []
            languages, word_counts, confidences, urls = [], [], [], []

            for row in tqdm(cur, desc="Reading rows", unit="rows"):
                ids.append(row[0])
                filenames.append(row[1] or "unknown.docx")
                types.append(row[2])
                topics.append(row[3])
                languages.append(row[4])
                word_counts.append(row[5])
                confidences.append(row[6])
                urls.append(f"{R2_BASE}/{row[0]}.docx")

        table = pa.table({
            "id": pa.array(ids, type=pa.string()),
            "filename": pa.array(filenames, type=pa.string()),
            "type": pa.array(types, type=pa.string()),
            "topic": pa.array(topics, type=pa.string()),
            "language": pa.array(languages, type=pa.string()),
            "word_count": pa.array(word_counts, type=pa.int32()),
            "confidence": pa.array(confidences, type=pa.float32()),
            "url": pa.array(urls, type=pa.string()),
        })

        pq.write_table(table, output_path, compression="zstd")
        return len(ids)
    finally:
        conn.close()


def push_to_hub(parquet_path: str, private: bool = False):
    """Push the parquet file and dataset card to HuggingFace."""
    from huggingface_hub import HfApi

    api = HfApi()

    # Create or get repo
    api.create_repo(REPO_ID, repo_type="dataset", private=private, exist_ok=True)

    # Upload parquet
    print(f"Uploading {parquet_path} to {REPO_ID}...")
    api.upload_file(
        path_or_fileobj=parquet_path,
        path_in_repo="data/train-00000-of-00001.parquet",
        repo_id=REPO_ID,
        repo_type="dataset",
    )

    # Upload dataset card
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
        f.write(DATASET_CARD)
        card_path = f.name

    api.upload_file(
        path_or_fileobj=card_path,
        path_in_repo="README.md",
        repo_id=REPO_ID,
        repo_type="dataset",
    )
    os.unlink(card_path)

    print(f"Done! Dataset available at: https://huggingface.co/datasets/{REPO_ID}")


def main():
    parser = argparse.ArgumentParser(description="Export docx-corpus to HuggingFace")
    parser.add_argument("--push", action="store_true", help="Push to HuggingFace (default: local export only)")
    parser.add_argument("--private", action="store_true", help="Create as private dataset")
    parser.add_argument("--output", default="docx-corpus.parquet", help="Local parquet output path")
    args = parser.parse_args()

    print(f"Exporting metadata to {args.output}...")
    count = export_parquet(args.output)
    size_mb = os.path.getsize(args.output) / (1024 * 1024)
    print(f"Exported {count:,} rows ({size_mb:.1f} MB)")

    if args.push:
        push_to_hub(args.output, private=args.private)
    else:
        print("Dry run — use --push to upload to HuggingFace")
        print(f"  uv run scripts/export-hf.py --push")


if __name__ == "__main__":
    main()
