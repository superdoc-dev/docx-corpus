# @docx-corpus/shared

Shared utilities used by all TypeScript packages. This is the foundation layer — every TS package depends on it.

## What's here

- **`db.ts`** — `DbClient` interface and `createDb()` factory. Uses `Bun.sql` (not pg/postgres.js). All pipeline stages (scrape, extract, embed, classify) read/write through this client.
- **`storage.ts`** — `Storage` interface with `createR2Storage()` and `createLocalStorage()`. Abstracts Cloudflare R2 vs local filesystem.
- **`ui.ts`** — Terminal formatting helpers (progress bars, headers, multi-line progress).
- **`index.ts`** — Barrel exports.

## Key types

- `DocumentRecord` — the full row from the `documents` table. Every pipeline stage adds columns to this.
- `DbClient` — interface with methods grouped by pipeline stage (scraping, extraction, embedding, classification).
- `LLMClassificationData` — `{ id, documentType, documentTopic, confidence, model }` for the classification pipeline.

## When modifying

- Adding a new pipeline stage? Add fields to `DocumentRecord`, add methods to `DbClient` interface AND the `createDb()` implementation.
- DB uses tagged template literals (`sql\`...\``) for parameterized queries. Use `sql.unsafe()` only when dynamic column names are needed.
- Don't add external dependencies — this package only depends on Bun built-ins and `@aws-sdk/client-s3`.
