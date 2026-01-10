<img width="400" alt="logo" src="https://github.com/user-attachments/assets/ea105e9e-00d0-4d48-a2a4-006cc4e89848" />

[![GitHub release](https://img.shields.io/github/v/release/superdoc-dev/docx-corpus)](https://github.com/superdoc-dev/docx-corpus/releases)
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
Common Crawl (3B+ URLs per crawl)
         │
         ▼
┌─────────────────────┐
│   CDX Index         │  ← Filter for .docx URLs
│   (gzipped text)    │
└─────────────────────┘
         │
         ▼
┌─────────────────────┐
│   WARC Records      │  ← Download actual files
│   (archived web)    │
└─────────────────────┘
         │
         ▼
┌─────────────────────┐
│   Validation        │  ← Verify valid .docx
│   (ZIP + XML check) │
└─────────────────────┘
         │
         ▼
┌─────────────────────┐
│   Storage           │  ← Local or Cloudflare R2
│   (deduplicated)    │
└─────────────────────┘
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

## Usage

```bash
# Scrape all documents from the latest crawl
bun run scrape

# Limit to 500 documents
bun run scrape --batch 500

# Re-process URLs already in database
bun run scrape --force

# Disable CDX caching (re-download index files)
bun run scrape --no-cache

# Check progress
bun run status

# List available crawls
bun start crawls
```

### Docker

Run the CLI in a container:

```bash
# Build and start the container
docker-compose up -d --build

# Run CLI commands
docker exec docx-corpus bun run scrape
docker exec docx-corpus bun run status
docker exec docx-corpus bun run crawls

# Stop the container
docker-compose down
```

The container mounts `./corpus` for persistent storage and defaults to 8GB memory limit. Adjust memory for higher concurrency:

```bash
MEMORY_LIMIT=16G docker-compose up -d --build
```

Pass environment variables via `docker run -e` or add them to your `.env` file.

### Storage Options

**Local storage** (default):
Files are saved to `./corpus/documents/`

**Cloud storage** (Cloudflare R2):

```bash
export CLOUDFLARE_ACCOUNT_ID=xxx
export R2_ACCESS_KEY_ID=xxx
export R2_SECRET_ACCESS_KEY=xxx
bun run scrape --batch 1000
```

## Configuration

All configuration via environment variables (`.env`):

```bash
# Storage (optional - defaults to local)
CLOUDFLARE_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=docx-corpus

# Scraping
STORAGE_PATH=./corpus
CRAWL_ID=CC-MAIN-2025-51

# Performance tuning
CDX_CONCURRENCY=3           # Parallel CDX index downloads
CDX_RATE_LIMIT_RPS=5        # CDX requests per second
CDX_QUEUE_SIZE=2000         # CDX record buffer size
WARC_CONCURRENCY=50         # Parallel WARC file downloads
WARC_RATE_LIMIT_RPS=100     # WARC requests per second
TIMEOUT_MS=45000            # Request timeout in ms
```

### Adaptive Rate Limiting

The scraper uses adaptive rate limiting that automatically adjusts to Common Crawl's server load:

- **On 503/429 errors**: RPS reduces by 20% and retries with exponential backoff
- **On success streaks**: RPS gradually increases by 5% (up to MAX_RPS)
- **Progress display**: Shows current RPS, docs/sec throughput, and retry count

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
