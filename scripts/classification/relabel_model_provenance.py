# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "psycopg2-binary>=2.9.0",
#     "python-dotenv>=1.0.0",
# ]
# ///
"""
One-off backfill: rename mislabeled `classification_model` values.

Historical context: earlier versions of `classify.py` hardcoded the
`classification_model` column to `modernbert-*` regardless of what base
model actually ran. The training pipeline has always used
`xlm-roberta-base` (see `train.py:43`), so the existing rows are tagged
with a model name that never produced them.

This script renames those rows to match the new `{base_model}-{taxonomy_version}`
format that `classify.py` now writes for new rows. Rows from other
labellers (e.g. `claude-sonnet-4-*` LLM training samples) are left alone.

Usage:
    uv run scripts/classification/relabel_model_provenance.py --dry-run
    uv run scripts/classification/relabel_model_provenance.py --apply
"""

import argparse
import os
import sys

import psycopg2
from dotenv import load_dotenv


RENAMES = {
    # old value -> new value
    "modernbert-2.0.0": "xlm-roberta-base-2.0.0",
    "modernbert-v2": "xlm-roberta-base-v2",
}


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--dry-run", action="store_true", help="show counts, do not write")
    group.add_argument("--apply", action="store_true", help="execute the UPDATEs")
    args = parser.parse_args()

    load_dotenv()
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        sys.exit("ERROR: DATABASE_URL not set")

    conn = psycopg2.connect(database_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT classification_model, COUNT(*) FROM documents "
                "WHERE classification_model IS NOT NULL "
                "GROUP BY classification_model ORDER BY COUNT(*) DESC"
            )
            print("Current distribution:")
            for model, count in cur.fetchall():
                marker = " (will be renamed)" if model in RENAMES else ""
                print(f"  {model:40s} {count:>12,}{marker}")
            print()

            for old, new in RENAMES.items():
                if args.dry_run:
                    cur.execute(
                        "SELECT COUNT(*) FROM documents WHERE classification_model = %s",
                        (old,),
                    )
                    (n,) = cur.fetchone()
                    print(f"[dry-run] would update {n:,} rows: {old!r} -> {new!r}")
                else:
                    cur.execute(
                        "UPDATE documents SET classification_model = %s WHERE classification_model = %s",
                        (new, old),
                    )
                    print(f"updated {cur.rowcount:,} rows: {old!r} -> {new!r}")

            if args.apply:
                conn.commit()
                print("committed")
            else:
                print("\ndry-run only. re-run with --apply to commit.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
