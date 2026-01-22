<img width="400" alt="logo" src="https://github.com/user-attachments/assets/ea105e9e-00d0-4d48-a2a4-006cc4e89848" />

[![CLI](https://img.shields.io/github/v/release/superdoc-dev/docx-corpus?filter=cli-v*&label=cli)](https://github.com/superdoc-dev/docx-corpus/releases)
[![CDX Filter](https://img.shields.io/github/v/release/superdoc-dev/docx-corpus?filter=cdx-filter-v*&label=cdx-filter)](https://github.com/superdoc-dev/docx-corpus/releases)
[![codecov](https://codecov.io/gh/superdoc-dev/docx-corpus/graph/badge.svg)](https://codecov.io/gh/superdoc-dev/docx-corpus)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Building the largest open corpus of .docx files for document processing and rendering research.

## Vision

Document rendering is hard. Microsoft Word has decades of edge cases, quirks, and undocumented behaviors. To build reliable document processing tools, you need to test against **real-world documents** - not just synthetic test cases.

**docx-corpus** scrapes the entire public web (via Common Crawl) to collect .docx files, creating a massive test corpus for:

- Document parsing and rendering engines
- Visual regression testing
- Feature coverage analysis

- Edge case discovery
- Machine learning training data

## How It Works

```
Phase 1: Index Filtering (Lambda)
┌────────────────┐     ┌────────────────┐     ┌────────────────┐
│  Common Crawl  │     │   cdx-filter   │     │  Cloudflare R2 │
│  CDX indexes   │ ──► │   (Lambda)     │ ──► │  cdx-filtered/ │
└────────────────┘     └────────────────┘     └────────────────┘

Phase 2: Scrape (corpus scrape)
┌────────────────┐     ┌────────────────┐     ┌────────────────┐
│  Common Crawl  │     │                │     │    Storage     │
│  WARC archives │ ──► │  Downloads     │ ──► │  documents/    │
├────────────────┤     │  Validates     │     │  {hash}.docx   │
│  Cloudflare R2 │     │  Deduplicates  │     ├────────────────┤
│  cdx-filtered/ │ ──► │                │ ──► │   PostgreSQL   │
└────────────────┘     └────────────────┘     │  (metadata)    │
                                              └────────────────┘

Phase 3: Extract (corpus extract)
┌────────────────┐     ┌────────────────┐     ┌────────────────┐
│    Storage     │     │    Docling     │     │    Storage     │
│  documents/    │ ──► │   (Python)     │ ──► │  extracted/    │
│  {hash}.docx   │     │                │     │  {hash}.txt    │
└────────────────┘     │  Extracts text │     ├────────────────┤
                       │  Counts words  │ ──► │   PostgreSQL   │
                       └────────────────┘     │  (word_count)  │
                                              └────────────────┘

Phase 4: Embed (corpus embed)
┌────────────────┐     ┌────────────────┐     ┌────────────────┐
│    Storage     │     │ sentence-      │     │   PostgreSQL   │
│  extracted/    │ ──► │ transformers   │ ──► │   (pgvector)   │
│  {hash}.txt    │     │   (Python)     │     │  embedding     │
└────────────────┘     └────────────────┘     └────────────────┘
```

### Why Common Crawl?

Common Crawl is a nonprofit that crawls the web monthly and makes it freely available:

- **3+ billion URLs** per monthly crawl
- **Petabytes of data** going back to 2008
- **Free to access** - no API keys needed
- **Reproducible** - archived crawls never change

This gives us access to every public .docx file on the web.

## Installation

```bash
# Clone the repository
git clone https://github.com/superdoc-dev/docx-corpus.git
cd docx-corpus

# Install dependencies
bun install
```

## Project Structure

```
packages/
  shared/         # Shared utilities (DB client, storage, formatting)
  scraper/        # Core scraper logic (downloads WARC, validates .docx)
  extractor/      # Text extraction using Docling (Python)
  embedder/       # Document embeddings
apps/
  cli/            # Unified CLI - corpus <command>
  cdx-filter/     # AWS Lambda - filters CDX indexes for .docx URLs
  web/            # Landing page - docxcorp.us
db/
  schema.sql      # PostgreSQL schema (with pgvector)
  migrations/     # Database migrations
```

**Apps** (entry points)

| App            | Purpose                         | Uses                     |
| -------------- | ------------------------------- | ------------------------ |
| **cli**        | `corpus` command                | scraper, extractor, embedder |
| **cdx-filter** | Filter CDX indexes (Lambda)     | -                        |
| **web**        | Landing page                    | -                        |

**Packages** (libraries)

| Package        | Purpose                           | Runtime      |
| -------------- | --------------------------------- | ------------ |
| **shared**     | DB client, storage, formatting    | Bun          |
| **scraper**    | Download and validate .docx files | Bun          |
| **extractor**  | Extract text (Docling)            | Bun + Python |
| **embedder**   | Generate embeddings               | Bun          |

## Usage

### 1. Run Lambda to filter CDX indexes

First, deploy and run the Lambda function to filter Common Crawl CDX indexes for .docx files. See [apps/cdx-filter/README.md](apps/cdx-filter/README.md) for detailed setup instructions.

```bash
cd apps/cdx-filter
./invoke-all.sh CC-MAIN-2025-51
```

This reads CDX files directly from Common Crawl S3 (no rate limits) and stores filtered JSONL in your R2 bucket.

### 2. Run the scraper

```bash
# Scrape from a single crawl
bun run corpus scrape --crawl CC-MAIN-2025-51

# Scrape latest 3 crawls, 100 docs each
bun run corpus scrape --crawl 3 --batch 100

# Scrape from multiple specific crawls
bun run corpus scrape --crawl CC-MAIN-2025-51,CC-MAIN-2025-48 --batch 500

# Re-process URLs already in database
bun run corpus scrape --crawl CC-MAIN-2025-51 --force

# Check progress
bun run corpus status
```

### 3. Extract text from documents

```bash
# Extract all documents
bun run corpus extract

# Extract with batch limit
bun run corpus extract --batch 100

# Extract with custom workers
bun run corpus extract --batch 50 --workers 8

# Verbose output
bun run corpus extract --verbose
```

### 4. Generate embeddings

```bash
# Embed all extracted documents
bun run corpus embed

# Embed with batch limit
bun run corpus embed --batch 100 --verbose
```

Uses Google's `gemini-embedding-001` model (3072 dimensions, ~$0.006/1M tokens). Documents are chunked and embeddings are combined via weighted average.

### Docker

Run the CLI in a container:

```bash
# Build the image
docker build -t docx-corpus .

# Run CLI commands
docker run docx-corpus --help
docker run docx-corpus scrape --help
docker run docx-corpus scrape --crawl CC-MAIN-2025-51 --batch 100

# With environment variables
docker run \
  -e DATABASE_URL=postgres://... \
  -e CLOUDFLARE_ACCOUNT_ID=xxx \
  -e R2_ACCESS_KEY_ID=xxx \
  -e R2_SECRET_ACCESS_KEY=xxx \
  docx-corpus scrape --batch 100
```

### Storage Options

R2 credentials are **required** to read pre-filtered CDX records from the Lambda output.

**Local document storage** (default):
Downloaded .docx files are saved to `./corpus/documents/`

**Cloud document storage** (Cloudflare R2):
Documents can also be uploaded to R2 alongside the CDX records:

```bash
export CLOUDFLARE_ACCOUNT_ID=xxx
export R2_ACCESS_KEY_ID=xxx
export R2_SECRET_ACCESS_KEY=xxx
bun run corpus scrape --crawl CC-MAIN-2025-51 --batch 1000
```

## Local Development

Start PostgreSQL with pgvector locally:

```bash
docker compose up -d

# Verify
docker exec docx-corpus-postgres-1 psql -U postgres -d docx_corpus -c "\dt"
```

Run commands against local database:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/docx_corpus \
CLOUDFLARE_ACCOUNT_ID='' \
bun run corpus status
```

## Configuration

All configuration via environment variables (`.env`):

```bash
# Database (required)
DATABASE_URL=postgres://user:pass@host:5432/dbname

# Cloudflare R2 (required for cloud storage)
CLOUDFLARE_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=docx-corpus

# Local storage (used when R2 not configured)
STORAGE_PATH=./corpus

# Scraping
CRAWL_ID=CC-MAIN-2025-51
CONCURRENCY=50
RATE_LIMIT_RPS=50
MAX_RPS=100
MIN_RPS=10
TIMEOUT_MS=45000
MAX_RETRIES=10

# Extractor
EXTRACT_INPUT_PREFIX=documents
EXTRACT_OUTPUT_PREFIX=extracted
EXTRACT_BATCH_SIZE=100
EXTRACT_WORKERS=4

# Embedder
EMBED_INPUT_PREFIX=extracted
EMBED_BATCH_SIZE=100
GOOGLE_API_KEY=              # Required for embeddings
```

### Rate Limiting

- **WARC requests**: Adaptive rate limiting that adjusts to server load
- **On 503/429 errors**: Retries with exponential backoff + jitter (up to 60s)
- **On 403 errors**: Fails immediately (indicates 24h IP block from Common Crawl)

## Corpus Statistics

| Metric        | Description                           |
| ------------- | ------------------------------------- |
| Sources       | Entire public web via Common Crawl    |
| Deduplication | SHA-256 content hash                  |
| Validation    | ZIP structure + Word XML verification |
| Storage       | Content-addressed (hash as filename)  |

## Development

```bash
# Run linter
bun run lint

# Format code
bun run format

# Type check
bun run typecheck

# Run tests
bun run test

# Build
bun run build
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Takedown Requests

If you find a document in this corpus that you own and would like removed, please email [help@docxcorp.us](mailto:help@docxcorp.us) with:

- The document hash or URL
- Proof of ownership

We will process requests within 7 days.

## License

MIT

---

Built by 🦋[SuperDoc](https://superdoc.dev)
