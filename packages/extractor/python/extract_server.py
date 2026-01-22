#!/usr/bin/env python3
"""Persistent DocX extraction server using Docling.

Reads file paths from stdin (one per line), outputs JSON per line to stdout.
This avoids the overhead of spawning a new Python process for each document.
"""
import json
import sys
import warnings
import logging
from pathlib import Path

# Suppress all warnings and logging from Docling and its dependencies
warnings.filterwarnings("ignore")
logging.disable(logging.CRITICAL)  # Disable all logging

import os
import contextlib

from docling.document_converter import DocumentConverter
from docling.datamodel.base_models import InputFormat
from docling_core.types.doc.labels import DocItemLabel

import langid


def detect_language(text: str, min_chars: int = 50) -> tuple[str, float]:
    """Detect language using langid. Returns (lang_code, confidence)."""
    if not text or len(text) < min_chars:
        return "unknown", 0.0

    try:
        lang, score = langid.classify(text[:2000])
        # Normalize confidence: langid scores are negative log-probs, typically -500 to -3000
        # Map to 0-1 where closer to 0 = higher confidence
        confidence = max(0.0, min(1.0, 1.0 + score / 3000))
        return lang, confidence
    except Exception:
        return "unknown", 0.0


@contextlib.contextmanager
def suppress_stderr():
    """Temporarily suppress stderr to hide Docling's verbose output."""
    with open(os.devnull, 'w') as devnull:
        old_stderr = sys.stderr
        sys.stderr = devnull
        try:
            yield
        finally:
            sys.stderr = old_stderr


def strip_image_data(extraction: dict) -> dict:
    """Remove base64 image data from extraction to reduce size."""
    if "pictures" in extraction:
        extraction["pictures"] = [
            {k: v for k, v in pic.items() if k != "image"}
            for pic in extraction["pictures"]
        ]
    return extraction


def smart_extract_text(doc) -> str:
    """Extract text without table markdown bloat.

    Docling's export_to_markdown() pads table cells with spaces for column alignment,
    which causes exponential growth when tables are nested (common in DOCX).
    This function extracts:
    1. Non-table content as markdown (preserves headings, lists, emphasis)
    2. Table cells as plain text (without markdown table formatting)
    """
    # Get non-table content as markdown
    non_table_labels = set(DocItemLabel) - {DocItemLabel.TABLE}
    non_table_content = doc.export_to_markdown(labels=non_table_labels)

    # Get table cell text directly (no markdown formatting)
    table_texts = []
    for table in doc.tables:
        rows = []
        for row in table.data.grid:
            cells = []
            for cell in row:
                # Use cell.text attribute if available, otherwise empty
                if hasattr(cell, 'text') and cell.text:
                    cells.append(cell.text)
            if cells:
                rows.append(' | '.join(cells))
        if rows:
            table_texts.append('\n'.join(rows))

    # Combine non-table content with table text
    if table_texts:
        return non_table_content + '\n\n' + '\n\n'.join(table_texts)
    return non_table_content


def extract(converter: DocumentConverter, file_path: str) -> dict:
    """Extract text and structure from a DOCX file using Docling."""
    result = converter.convert(file_path)

    # Use smart extraction to avoid table padding bloat
    text = smart_extract_text(result.document)

    # Detect language
    lang, lang_confidence = detect_language(text)

    # Get full structured extraction (stripped of image data)
    extraction = result.document.export_to_dict()
    extraction = strip_image_data(extraction)

    return {
        "text": text,
        "wordCount": len(text.split()),
        "charCount": len(text),
        "tableCount": len(extraction.get("tables", [])),
        "imageCount": len(extraction.get("pictures", [])),
        "language": lang,
        "languageConfidence": lang_confidence,
        "extraction": extraction,
    }


def main():
    # Signal that we're ready (after imports complete)
    print(json.dumps({"ready": True}), flush=True)

    # Initialize converter ONCE (restricted to DOCX only to avoid loading PDF models)
    converter = DocumentConverter(allowed_formats=[InputFormat.DOCX])

    # Signal that converter is initialized
    print(json.dumps({"initialized": True}), flush=True)

    # Read file paths from stdin, output JSON per line
    for line in sys.stdin:
        file_path = line.strip()
        if not file_path:
            continue

        try:
            if not Path(file_path).exists():
                print(json.dumps({"success": False, "error": f"File not found: {file_path}"}), flush=True)
                continue

            # Suppress stderr during extraction to hide Docling's verbose output
            with suppress_stderr():
                result = extract(converter, file_path)
            print(json.dumps({"success": True, **result}), flush=True)

        except Exception as e:
            print(json.dumps({"success": False, "error": str(e)}), flush=True)


if __name__ == "__main__":
    main()
