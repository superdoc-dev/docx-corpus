# docx-corpus

The largest open corpus of .docx files (~800K documents) for document processing research. Built by [SuperDoc](https://superdoc.dev).

## Architecture

This is a **data pipeline monorepo** with two runtimes:

- **TypeScript (Bun)** — infrastructure: scraping, extraction, embedding
- **Python** — data science: classification, export, publishing

```
apps/cli/               → corpus <command> (scrape, extract, embed, status)
apps/cdx-filter/        → AWS Lambda for Common Crawl CDX filtering
packages/shared/        → DB client (Bun.sql), R2 storage, UI helpers
packages/scraper/       → Downloads .docx from Common Crawl WARC archives
packages/extractor/     → Text extraction via Docling
packages/embedder/      → Embeddings via Google gemini-embedding-001
scripts/classification/ → ML classification pipeline (Python)
db/                     → PostgreSQL schema + migrations
```

## Pipeline

Each stage writes to the same PostgreSQL database (`documents` table):

1. **Scrape** (TS) — Common Crawl → .docx files in R2 (`status = 'uploaded'`)
2. **Extract** (TS) — Docling → text in R2 (`extracted_at`, `word_count`, `language`)
3. **Embed** (TS) — Google API → pgvector (`embedding`, `embedded_at`)
4. **Classify** (Python) — ModernBERT → labels (`document_type`, `document_topic`)

## Database

Single `documents` table in PostgreSQL (NeonDB) with pgvector. All pipeline stages write to this table.

- **Connection**: `DATABASE_URL` env var (Bun.sql for TS, psycopg2 for Python)
- **Schema**: `db/schema.sql` (canonical), `db/migrations/` (incremental)
- **Key columns**: `id` (SHA-256 hash), `status`, `extracted_at`, `embedded_at`, `document_type`, `document_topic`

## Storage

Documents and extracted text live in Cloudflare R2:
- `documents/{hash}.docx` — original files
- `extracted/{hash}.txt` — extracted text

Text is also available at `https://docxcorp.us/extracted/{id}.txt`.

## Commands

```bash
bun install                        # Install TS dependencies
bun run corpus scrape --crawl 3    # Scrape from Common Crawl
bun run corpus extract             # Extract text
bun run corpus embed               # Generate embeddings
bun run corpus status              # Show pipeline stats
```

## Key conventions

- Use `bun` for all TS tooling (not node/npm/pnpm)
- DB client is in `packages/shared/db.ts` — all pipeline stages use `DbClient`
- Storage abstraction in `packages/shared/storage.ts` — R2 or local
- Environment: `.env` at project root (gitignored), see `.env.example`
- Python scripts manage their own deps via `pyproject.toml`
