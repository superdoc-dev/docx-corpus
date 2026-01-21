#!/usr/bin/env python3
"""Single-file DOCX extraction using Docling. Outputs JSON to stdout."""
import json
import sys
from pathlib import Path


def extract(file_path: str) -> dict:
    """Extract text and structure from a DOCX file using Docling."""
    from docling.document_converter import DocumentConverter

    converter = DocumentConverter()
    result = converter.convert(file_path)

    # Export as markdown for text extraction
    text = result.document.export_to_markdown()

    # Get full structured extraction (raw, no stripping)
    extraction = result.document.export_to_dict()

    return {
        "text": text,
        "wordCount": len(text.split()),
        "charCount": len(text),
        "tableCount": len(extraction.get("tables", [])),
        "imageCount": len(extraction.get("pictures", [])),
        "extraction": extraction,
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No file path provided"}), file=sys.stderr)
        sys.exit(1)

    file_path = sys.argv[1]

    if not Path(file_path).exists():
        print(json.dumps({"error": f"File not found: {file_path}"}), file=sys.stderr)
        sys.exit(1)

    try:
        result = extract(file_path)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
