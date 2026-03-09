# Classification Pipeline

Python ML pipeline that classifies ~800K .docx documents by **document type** (10 classes) and **topic** (9 classes).

Uses the FineWeb-Edu pattern: LLM labels a small sample → train lightweight classifier → apply at scale.

## Pipeline steps (run in order)

1. **`sample.py`** — Stratified sampling from PostgreSQL. Samples proportionally across languages (en, ru, cs, pl, es), stratified by word count terciles and source domain diversity.
2. **`label.py`** — Async LLM labeling with Claude. Supports resume (appends to JSONL). Rate-limited with configurable parallelism.
3. **`train.py`** — Fine-tunes two independent ModernBERT classifiers (document_type and topic). Outputs models to `./models/`.
4. **`classify.py`** — Batch inference on the full corpus. Fetches text from R2, runs both models, writes results to PostgreSQL.
5. **`evaluate.py`** — Quality metrics. Two modes: `labels` (analyzes JSONL) and `corpus` (queries DB).

## Key files

- **`taxonomy.json`** — Single source of truth for the 2D taxonomy (10 document types × 9 topics). Both prompt building and model training reference this.
- **`common.py`** — Shared utilities: DB connection (`psycopg2`), text fetching from `https://docxcorp.us/extracted/`, taxonomy loading.
- **`pyproject.toml`** — Python dependencies. Install with `pip install -e .` or `uv pip install -e .`.

## Database

Writes to the same `documents` table as the TS pipeline:
- `document_type` — one of 10 types (legal, forms, reports, etc.)
- `document_topic` — one of 9 topics (government, education, healthcare, etc.)
- `classification_confidence` — min(type_confidence, topic_confidence)
- `classification_model` — e.g. "claude-haiku-4-5" or "modernbert-v2.0.0"

Connection via `DATABASE_URL` env var loaded from `../../.env`.

## Conventions

- Python 3.11+, no type stubs needed
- Uses `psycopg2` for DB (not Bun.sql — this is Python)
- Uses `python-dotenv` to load `.env` from project root
- Text is fetched via HTTP from the public R2 endpoint, not direct R2 access
- All scripts support `--help` for usage
- JSONL files are the interchange format between steps
