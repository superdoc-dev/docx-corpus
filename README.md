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
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│   Common Crawl   │      │   cdx-filter     │      │   Cloudflare R2  │
│      (S3)        │ ───► │    (Lambda)      │ ───► │                  │
│                  │      │                  │      │  cdx-filtered/   │
│  CDX indexes     │      │  Filters .docx   │      │  *.jsonl         │
└──────────────────┘      └──────────────────┘      └──────────────────┘

                         Phase 2: Document Collection (CLI)
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│   Cloudflare R2  │      │   corpus CLI     │      │     Storage      │
│                  │ ───► │     (Bun)        │ ───► │                  │
│  cdx-filtered/   │      │                  │      │  Local or R2     │
│  *.jsonl         │      │  Downloads WARC  │      │  documents/      │
├──────────────────┤      │  Validates docx  │      └──────────────────┘
│   Common Crawl   │ ───► │  Deduplicates    │
│  WARC archives   │      │                  │
└──────────────────┘      └──────────────────┘
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
  shared/         # Shared utilities (progress bars, formatting)
  scraper/        # Core scraper logic (downloads WARC, validates .docx)
  extractor/      # Text extraction using Docling (Python)
apps/
  cli/            # Unified CLI - corpus <command>
  cdx-filter/     # AWS Lambda - filters CDX indexes for .docx URLs
```

| Package/App    | Purpose                           | Runtime              |
| -------------- | --------------------------------- | -------------------- |
| **cli**        | Unified CLI entry point           | Bun                  |
| **scraper**    | Download and validate .docx files | Bun                  |
| **extractor**  | Extract text from .docx files     | Bun + Python         |
| **cdx-filter** | Filter Common Crawl CDX indexes   | AWS Lambda (Node.js) |

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

## Configuration

All configuration via environment variables (`.env`):

```bash
# Cloudflare R2 (required for both Lambda and scraper)
CLOUDFLARE_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=docx-corpus

# Scraping
STORAGE_PATH=./corpus
CRAWL_ID=CC-MAIN-2025-51

# Performance tuning
CONCURRENCY=50              # Parallel downloads
RATE_LIMIT_RPS=50           # Requests per second (initial)
MAX_RPS=100                 # Max requests per second
MIN_RPS=10                  # Min requests per second
TIMEOUT_MS=45000            # Request timeout in ms
MAX_RETRIES=10              # Max retry attempts
MAX_BACKOFF_MS=60000        # Max backoff delay (ms)
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
