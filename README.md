<img width="400" alt="logo" src="https://github.com/user-attachments/assets/ea105e9e-00d0-4d48-a2a4-006cc4e89848" />

[![CLI](https://img.shields.io/github/v/release/superdoc-dev/docx-corpus?filter=cli-v*&label=cli)](https://github.com/superdoc-dev/docx-corpus/releases)
[![CDX Filter](https://img.shields.io/github/v/release/superdoc-dev/docx-corpus?filter=cdx-filter-v*&label=cdx-filter)](https://github.com/superdoc-dev/docx-corpus/releases)
[![codecov](https://codecov.io/gh/superdoc-dev/docx-corpus/graph/badge.svg)](https://codecov.io/gh/superdoc-dev/docx-corpus)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

The largest open corpus of classified Word documents. 736K+ `.docx` files from the public web, classified into 10 document types and 9 topics across 46+ languages.

**[docxcorp.us](https://docxcorp.us)** · **[HuggingFace](https://huggingface.co/datasets/superdoc-dev/docx-corpus)** · **[API](https://api.docxcorp.us/stats)**

## How It Works

```
Common Crawl (3B+ URLs/month)
    ↓
[1. cdx-filter]  AWS Lambda — filters CDX indexes for .docx URLs
    ↓
[2. scrape]      Download WARC records, validate, deduplicate, store
    ↓
[3. extract]     Extract text + detect language (Docling + lingua)
    ↓
[4. classify]    Classify by type + topic (ModernBERT, FineWeb-Edu pattern)
    ↓
[5. export]      Push to HuggingFace / serve via API
```

## Quick Start

```bash
git clone https://github.com/superdoc-dev/docx-corpus.git
cd docx-corpus
bun install
```

## CLI

All pipeline stages are accessible through a single CLI:

```bash
corpus cdx-filter                         # Show available vs filtered crawls
corpus cdx-filter --crawl CC-MAIN-2026-08 # Filter a specific crawl via Lambda
corpus cdx-filter --latest 3              # Filter 3 newest missing crawls
corpus crawls                              # List available crawls from R2
corpus scrape --crawl CC-MAIN-2025-51      # Scrape a specific crawl
corpus scrape --crawl 3 --batch 100        # Latest 3 crawls, 100 docs each
corpus extract                             # Extract text from all pending
corpus extract -b 100 -w 8                 # Custom batch size + workers
corpus classify                            # Classify all pending documents
corpus classify --modal --workers 20       # Cloud GPU classification
corpus export                              # Export parquet locally
corpus export --push                       # Push to HuggingFace
corpus status                              # Show full pipeline stats
```

Run `corpus <command> --help` for detailed options.

## Project Structure

```
apps/
  cli/              # Unified CLI — corpus <command>
  cdx-filter/       # AWS Lambda — filters CDX indexes for .docx URLs
  web/              # Landing page (docxcorp.us) + Cloudflare Worker API
packages/
  shared/           # DB client, storage abstraction, formatting
  scraper/          # Downloads WARC, validates .docx, deduplicates
  extractor/        # Text extraction via Docling (Bun + Python)
  embedder/         # Document embeddings via Gemini
scripts/
  classification/   # ML classification pipeline (Python)
  export-hf.py      # HuggingFace dataset export
db/
  schema.sql        # PostgreSQL + pgvector schema
  migrations/       # Database migrations
```

| Layer | What | Runtime |
|-------|------|---------|
| **cli** | `corpus` command — orchestrates everything | Bun |
| **cdx-filter** | Filter Common Crawl CDX indexes (Lambda) | Node.js |
| **web** | docxcorp.us landing page + API worker | Static + CF Worker |
| **scraper** | Download, validate, deduplicate .docx files | Bun |
| **extractor** | Extract text + detect language (Docling) | Bun + Python |
| **embedder** | Generate embeddings (Gemini) | Bun |
| **classification** | Type + topic classification (ModernBERT) | Python |

## Pipeline Details

### 1. CDX Filtering (Lambda)

Pre-filters Common Crawl CDX indexes for `.docx` URLs. Runs in AWS Lambda (us-east-1) for direct S3 access — minutes instead of days.

```bash
corpus cdx-filter                          # Show what's available vs filtered
corpus cdx-filter --crawl CC-MAIN-2026-08  # Filter one crawl
corpus cdx-filter --all                    # Filter all missing crawls
```

**AWS setup**: The Lambda function needs AWS credentials configured locally. See [apps/cdx-filter/README.md](apps/cdx-filter/README.md) for Lambda deployment.

```bash
# Option 1: AWS CLI profile (recommended)
aws configure --profile docx-corpus
export AWS_PROFILE=docx-corpus

# Option 2: Environment variables
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_REGION=us-east-1
```

The AWS IAM user/role needs `lambda:InvokeFunction` permission on the `cdx-filter` function.

### 2. Scraping

Downloads WARC records from Common Crawl, validates ZIP structure, computes SHA-256 hash, deduplicates, and stores to R2/local filesystem.

```bash
corpus scrape --crawl CC-MAIN-2025-51 --batch 500
corpus scrape --crawl 3                  # Latest 3 crawls
corpus scrape --crawl CC-MAIN-2025-51 --force  # Re-process existing
```

- Adaptive rate limiting (backs off on 503/429, recovers on success)
- Content-addressed storage (`documents/{sha256}.docx`)
- Deduplication by content hash

### 3. Extraction

Extracts text using Docling (persistent Python subprocess), detects language with lingua.

```bash
corpus extract                    # All pending documents
corpus extract -b 100 -w 8       # Custom batch + workers
```

- Smart table handling (avoids padding bloat)
- Updates: `word_count`, `char_count`, `table_count`, `image_count`, `language`

### 4. Classification

Classifies documents by **type** (10 classes) and **topic** (9 classes) using the [FineWeb-Edu](https://huggingface.co/spaces/HuggingFaceFW/blogpost-fineweb-v1) pattern: LLM labels a sample → train lightweight classifier → apply at scale.

```bash
corpus classify                            # Local classification
corpus classify --modal --workers 20       # Cloud GPUs via Modal
corpus classify -l en,ru --batch-size 256  # Filter + custom batch
```

**First-time setup** (training):

```bash
cd scripts/classification
pip install -e .
python sample.py --total 3500 --output sampled_docs.jsonl
python label.py --input sampled_docs.jsonl --output labeled_docs.jsonl
python train.py --input labeled_docs.jsonl --output-dir ./models
```

See [scripts/classification/CLAUDE.md](scripts/classification/CLAUDE.md) for details.

**Document types**: legal, forms, reports, policies, educational, correspondence, technical, administrative, creative, reference

**Topics**: government, education, healthcare, finance, legal_judicial, technology, environment, nonprofit, general

### 5. Export

Export corpus metadata to HuggingFace as a Parquet dataset.

```bash
corpus export                    # Dry run: local parquet
corpus export --push             # Push to HuggingFace
```

### 6. Embedding (optional)

Generate vector embeddings for semantic search. Not required for the website or classification.

```bash
corpus embed                     # All extracted documents
corpus embed --batch 100         # With batch limit
```

Uses Google Gemini `gemini-embedding-001` (3072 dimensions).

## Web & API

**[docxcorp.us](https://docxcorp.us)** — Browse, filter, and preview documents with SuperDoc.

**API** (Cloudflare Worker):

```bash
# Corpus stats
curl https://api.docxcorp.us/stats

# Search documents with faceted filtering
curl "https://api.docxcorp.us/documents?type=legal&lang=en&min_confidence=0.8"

# Download manifest (wget-compatible URL list)
curl "https://api.docxcorp.us/manifest?type=legal&lang=en" -o manifest.txt
wget -i manifest.txt -P ./corpus/
```

## Configuration

All via environment variables (`.env`):

```bash
# Database (required)
DATABASE_URL=postgres://user:pass@host:5432/dbname

# Cloudflare R2 (required for cloud storage)
CLOUDFLARE_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=docx-corpus

# Local storage fallback
STORAGE_PATH=./corpus

# Embeddings (optional)
GOOGLE_API_KEY=

# AWS (for cdx-filter Lambda invocation)
AWS_PROFILE=docx-corpus  # or set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY

# Classification (for LLM labeling step only)
ANTHROPIC_API_KEY=
```

## Local Development

```bash
# Start local PostgreSQL + pgvector
docker compose up -d

# Run against local database
DATABASE_URL=postgres://postgres:postgres@localhost:5432/docx_corpus \
  bun run corpus status

# Run web API locally
cd apps/web/worker
npx wrangler dev
```

## Docker

```bash
docker build -t docx-corpus .
docker run -e DATABASE_URL=postgres://... docx-corpus scrape --batch 100
```

## Takedown Requests

If you find a document you own and would like removed, email [help@docxcorp.us](mailto:help@docxcorp.us) with the document hash or URL and proof of ownership. Processed within 7 days.

## License

MIT

---

Built by 🦋 [SuperDoc](https://superdoc.dev)
