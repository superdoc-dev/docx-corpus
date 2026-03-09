"""
Shared utilities for the classification pipeline.
DB connection, text fetching, and common helpers.
"""

import json
import os
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

import psycopg2
from dotenv import load_dotenv

# Load .env from project root
env_path = Path(__file__).parent.parent.parent / ".env"
load_dotenv(env_path)

TEXT_BASE_URL = "https://docxcorp.us/extracted"


def get_db_connection():
    """Create a connection to the PostgreSQL database."""
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise ValueError("DATABASE_URL environment variable not set")
    return psycopg2.connect(database_url)


def load_taxonomy(path: Optional[str] = None) -> dict:
    """Load taxonomy from JSON file."""
    if path is None:
        path = Path(__file__).parent / "taxonomy.json"
    with open(path) as f:
        return json.load(f)


def fetch_document_text(doc_id: str, max_chars: int = 2000) -> str:
    """Fetch extracted text for a document from public URL."""
    url = f"{TEXT_BASE_URL}/{doc_id}.txt"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "docx-classifier/2.0"})
        with urllib.request.urlopen(req, timeout=15) as response:
            text = response.read().decode("utf-8")
            return text[:max_chars]
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return ""
        return ""
    except Exception:
        return ""


def fetch_documents_text_parallel(
    doc_ids: list[str], max_chars: int = 2000, max_workers: int = 20
) -> dict[str, str]:
    """Fetch text for multiple documents in parallel."""
    results = {}

    def fetch_one(doc_id: str) -> tuple[str, str]:
        return doc_id, fetch_document_text(doc_id, max_chars)

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        for doc_id, text in executor.map(fetch_one, doc_ids):
            results[doc_id] = text

    return results


def get_extraction_stats_by_language() -> list[dict]:
    """Get document counts per language for extracted docs."""
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT
                    language,
                    COUNT(*)::int as count,
                    ROUND(AVG(word_count))::int as avg_words
                FROM documents
                WHERE extracted_at IS NOT NULL
                  AND extraction_error IS NULL
                  AND language IS NOT NULL
                ORDER BY count DESC
            """)
            return [
                {"language": row[0], "count": row[1], "avg_words": row[2]}
                for row in cur.fetchall()
            ]
    finally:
        conn.close()


def save_labels_to_db(labels: list[dict], batch_size: int = 500) -> int:
    """
    Save classification labels to the database.

    Each label dict: {id, document_type, document_topic, confidence, model}
    """
    conn = get_db_connection()
    total = 0
    try:
        with conn.cursor() as cur:
            for i in range(0, len(labels), batch_size):
                batch = labels[i : i + batch_size]
                for label in batch:
                    cur.execute(
                        """
                        UPDATE documents SET
                            document_type = %s,
                            document_topic = %s,
                            classification_confidence = %s,
                            classification_model = %s
                        WHERE id = %s
                        """,
                        (
                            label["document_type"],
                            label["document_topic"],
                            label["confidence"],
                            label["model"],
                            label["id"],
                        ),
                    )
                    total += 1
                conn.commit()
    finally:
        conn.close()
    return total
