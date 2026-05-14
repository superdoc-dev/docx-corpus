# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "boto3>=1.35.0",
#     "psycopg2-binary>=2.9.0",
#     "python-dotenv>=1.0.0",
# ]
# ///
"""
Republish corrected R2 objects for documents affected by the pre-477d1b9
WARC trailing-bytes bug.

Reads each documents/{raw_id}.docx from R2, applies the same trim logic
as scripts/fix_trailing_warc_bytes.py (only trims when excess bytes are
exactly \\r\\n\\r\\n; verifies candidate passes zipfile.testzip), computes
the corrected SHA-256, and writes the corrected bytes to a new R2 key
documents/{corrected_id}.docx. The original raw object is left untouched.

State for resumability lives in the document_corrections table (see
db/migrations/006). One row per inspected raw_id, regardless of outcome.
Reruns LEFT JOIN that table to skip already-inspected objects (with an
opt-in --retry-errors to revisit error rows).

Important:
  - Dry-run by default. --commit required to write R2 objects or DB rows.
  - This is a backfill/prep script. Manifests, the public website, the
    /v1 API, the documents table, and extracted/{id}.txt are NOT modified
    here. Consumer-facing routing decisions (which URL is canonical, what
    manifest.txt advertises) are a separate change.
  - Multiple raw_ids may legitimately map to the same corrected_id when
    their only difference was the WARC tail. corrected_id is NOT unique.

Usage:
  uv run scripts/republish_corrected_objects.py                    # dry-run, all
  uv run scripts/republish_corrected_objects.py --limit 100        # dry-run, first 100
  uv run scripts/republish_corrected_objects.py --commit --limit 100  # commit first 100
  uv run scripts/republish_corrected_objects.py --commit           # full backfill
  uv run scripts/republish_corrected_objects.py --commit --retry-errors  # also retry errored rows

Exit codes:
  0 on success
  1 on real errors (fatal: missing env, DB unreachable, R2 unreachable)
"""
from __future__ import annotations

import argparse
import hashlib
import io
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import boto3
import psycopg2
import psycopg2.extras
from botocore.exceptions import ClientError
from dotenv import load_dotenv

# Reuse the trim/inspect logic from the local fixer so there's one source of truth
sys.path.insert(0, str(Path(__file__).resolve().parent))
import fix_trailing_warc_bytes as fixer  # noqa: E402


@dataclass
class Inspection:
    raw_id: str
    raw_size: int
    candidate: bytes | None
    fixer_status: str  # the granular status from fix_trailing_warc_bytes
    error: str | None = None


def map_status(fixer_status: str) -> tuple[str, str | None]:
    """Map the fixer's granular status to (db_status, reason)."""
    if fixer_status == "trimmed":
        return ("corrected", None)
    if fixer_status == "already-clean":
        return ("already_clean", None)
    if fixer_status.startswith("skipped-"):
        return ("skipped", fixer_status[len("skipped-"):])
    return ("skipped", fixer_status)


def open_db(database_url: str):
    return psycopg2.connect(database_url)


def open_r2():
    """Open an S3-compatible client for Cloudflare R2."""
    account_id = os.environ["CLOUDFLARE_ACCOUNT_ID"]
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def select_batch(conn, batch_size: int, retry_errors: bool) -> list[str]:
    """Return up to batch_size raw_ids that haven't been inspected yet
    (or that have status='error' if retry_errors=True). Ordered by id
    for deterministic progress."""
    if retry_errors:
        sql = """
            SELECT d.id
            FROM documents d
            LEFT JOIN document_corrections c ON c.raw_id = d.id
            WHERE d.status = 'uploaded'
              AND (c.raw_id IS NULL OR c.status = 'error')
            ORDER BY d.id
            LIMIT %s
        """
    else:
        sql = """
            SELECT d.id
            FROM documents d
            LEFT JOIN document_corrections c ON c.raw_id = d.id
            WHERE d.status = 'uploaded'
              AND c.raw_id IS NULL
            ORDER BY d.id
            LIMIT %s
        """
    with conn.cursor() as cur:
        cur.execute(sql, (batch_size,))
        return [row[0] for row in cur.fetchall()]


def r2_get(s3, bucket: str, key: str) -> bytes:
    obj = s3.get_object(Bucket=bucket, Key=key)
    return obj["Body"].read()


def r2_object_exists(s3, bucket: str, key: str) -> bool:
    try:
        s3.head_object(Bucket=bucket, Key=key)
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound"):
            return False
        raise


def r2_put(s3, bucket: str, key: str, body: bytes) -> None:
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=body,
        ContentLength=len(body),
        ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )


def inspect(s3, bucket: str, raw_id: str) -> Inspection:
    """Read raw_id from R2 and run the fixer's candidate_trimmed."""
    key = f"documents/{raw_id}.docx"
    try:
        data = r2_get(s3, bucket, key)
    except ClientError as e:
        return Inspection(
            raw_id=raw_id, raw_size=0, candidate=None,
            fixer_status="error", error=f"r2 get: {e.response['Error'].get('Code', 'unknown')}",
        )
    candidate, status = fixer.candidate_trimmed(data)
    return Inspection(raw_id=raw_id, raw_size=len(data), candidate=candidate, fixer_status=status)


def upsert_correction_row(
    conn, *, raw_id: str, corrected_id: str | None,
    status: str, reason: str | None,
    raw_size: int | None, corrected_size: int | None,
    is_corrected: bool,
) -> None:
    """Insert or update a document_corrections row. UPSERT so --retry-errors
    re-runs cleanly overwrite the prior error row."""
    sql = """
        INSERT INTO document_corrections (
            raw_id, corrected_id, status, reason,
            raw_file_size_bytes, corrected_file_size_bytes,
            corrected_at
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (raw_id) DO UPDATE SET
            corrected_id = EXCLUDED.corrected_id,
            status = EXCLUDED.status,
            reason = EXCLUDED.reason,
            raw_file_size_bytes = EXCLUDED.raw_file_size_bytes,
            corrected_file_size_bytes = EXCLUDED.corrected_file_size_bytes,
            inspected_at = NOW(),
            corrected_at = EXCLUDED.corrected_at
    """
    with conn.cursor() as cur:
        cur.execute(sql, (
            raw_id, corrected_id, status, reason,
            raw_size, corrected_size,
            "NOW()" if is_corrected else None,
        ))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--commit", action="store_true",
                    help="Write R2 objects and DB rows. Without this flag, runs as dry-run.")
    ap.add_argument("--batch", type=int, default=100,
                    help="DB batch size for raw_id selection (default 100).")
    ap.add_argument("--limit", type=int, default=None,
                    help="Cap total objects processed in this run.")
    ap.add_argument("--retry-errors", action="store_true",
                    help="Also revisit raw_ids with status='error' from prior runs.")
    ap.add_argument("--verbose", action="store_true",
                    help="Print per-file outcome to stderr.")
    args = ap.parse_args(argv)

    load_dotenv()

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("error: DATABASE_URL not set", file=sys.stderr)
        return 1
    bucket = os.environ.get("R2_BUCKET_NAME", "docx-corpus")
    for var in ("CLOUDFLARE_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"):
        if not os.environ.get(var):
            print(f"error: {var} not set", file=sys.stderr)
            return 1

    conn = open_db(database_url)
    conn.autocommit = False  # commit per-row in --commit mode for resumability
    s3 = open_r2()

    counts: dict[str, int] = {}
    last_progress = time.monotonic()
    total_processed = 0
    corrected_id_seen: dict[str, int] = {}  # for dup tracking in dry-run

    def emit_progress(force: bool = False) -> None:
        nonlocal last_progress
        now = time.monotonic()
        if not force and now - last_progress < 10:
            return
        last_progress = now
        summary = ", ".join(f"{k}={v}" for k, v in sorted(counts.items()))
        print(f"[{total_processed} processed] {summary}", file=sys.stderr)

    try:
        while args.limit is None or total_processed < args.limit:
            remaining = None if args.limit is None else args.limit - total_processed
            batch_size = min(args.batch, remaining) if remaining is not None else args.batch
            ids = select_batch(conn, batch_size, args.retry_errors)
            if not ids:
                break

            for raw_id in ids:
                ins = inspect(s3, bucket, raw_id)
                total_processed += 1

                if ins.fixer_status == "error":
                    counts["error"] = counts.get("error", 0) + 1
                    if args.commit:
                        upsert_correction_row(
                            conn, raw_id=raw_id, corrected_id=None,
                            status="error", reason=ins.error,
                            raw_size=None, corrected_size=None,
                            is_corrected=False,
                        )
                        conn.commit()
                    if args.verbose:
                        print(f"error {raw_id}: {ins.error}", file=sys.stderr)
                    emit_progress()
                    continue

                db_status, reason = map_status(ins.fixer_status)
                counts[db_status] = counts.get(db_status, 0) + 1

                corrected_id = None
                corrected_size = None
                if ins.candidate is not None:
                    corrected_id = hashlib.sha256(ins.candidate).hexdigest()
                    corrected_size = len(ins.candidate)
                    corrected_id_seen[corrected_id] = corrected_id_seen.get(corrected_id, 0) + 1

                if args.commit:
                    if ins.candidate is not None and corrected_id is not None:
                        # Write R2 object first; only insert mapping after success.
                        # If write succeeds and DB insert later fails, rerun
                        # recovers via HEAD check + insert.
                        target_key = f"documents/{corrected_id}.docx"
                        if not r2_object_exists(s3, bucket, target_key):
                            r2_put(s3, bucket, target_key, ins.candidate)
                    upsert_correction_row(
                        conn, raw_id=raw_id, corrected_id=corrected_id,
                        status=db_status, reason=reason,
                        raw_size=ins.raw_size, corrected_size=corrected_size,
                        is_corrected=(db_status == "corrected"),
                    )
                    conn.commit()

                if args.verbose:
                    detail = f" -> {corrected_id[:12]}..." if corrected_id else ""
                    extra = f" reason={reason}" if reason else ""
                    print(f"{db_status}{detail}{extra}: {raw_id}", file=sys.stderr)

                emit_progress()

        emit_progress(force=True)

        # Dup summary (especially relevant in dry-run; in --commit the data
        # is already in document_corrections for offline analysis)
        dups = {cid: n for cid, n in corrected_id_seen.items() if n > 1}
        if dups:
            print(f"\n{len(dups)} corrected_ids reached by multiple raw_ids "
                  f"(largest cluster: {max(dups.values())} raw_ids).", file=sys.stderr)
            print("This is expected when raw objects differed only in their WARC tail.",
                  file=sys.stderr)

        if not args.commit:
            print("\n(dry-run; pass --commit to write R2 objects and DB rows)", file=sys.stderr)
    finally:
        conn.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
