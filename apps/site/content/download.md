---
title: "Download docx-corpus: Hugging Face, REST API, manifest, and code examples"
description: "Three ways to access docx-corpus: Hugging Face Parquet dataset, REST API with faceted filters, and bulk URL manifests. Working examples for Python, curl, and wget."
canonicalPath: /download
status: draft
lastVerified: 2026-05-19
primaryQuery: "download docx dataset"
secondaryQueries:
  - "huggingface docx dataset"
  - "docx corpus api"
  - "bulk download word documents"
---

# Download

Three access paths. Pick by use case.

| Use case | Path |
|---|---|
| Bulk metadata + extracted text for ML training | [Hugging Face](#hugging-face) |
| Programmatic filtering, faceted browse, exact counts | [REST API](#rest-api) |
| Bulk .docx files by filter (any subset, full corpus) | [Manifest + wget/curl](#manifest) |
| Single document | `https://docxcorp.us/documents/{id}.docx` |

All three return the same underlying classified subset (736,242 documents). The full uploaded set, including unclassified rows, is only in the database, not in any public endpoint.

## Hugging Face

```python
from datasets import load_dataset

ds = load_dataset("superdoc-dev/docx-corpus", split="train")
print(ds[0])
```

Returned fields per row: `id`, `filename`, `type`, `topic`, `language`, `word_count`, `confidence`, `url`. The `url` points at the raw .docx; extracted text is at `https://docxcorp.us/extracted/{id}.txt`.

License: [ODC-BY 1.0](https://opendatacommons.org/licenses/by/1-0/) (metadata). Individual document copyright remains with the original author.

## REST API

Base URL: `https://api.docxcorp.us`

### `GET /stats`

Corpus-wide counters: total documents, language list, type/topic breakdowns with counts and percentages. No parameters. 5-minute cache.

```bash
curl https://api.docxcorp.us/stats | jq '.hero'
```

### `GET /documents`

Paginated, filterable. Returns rows plus faceted counts (so the UI can show option counts that update with active filters).

| Param | Default | Notes |
|---|---|---|
| `type` | (any) | One of the 10 document types |
| `topic` | (any) | One of the 9 topics |
| `lang` | (any) | ISO 639-1 code |
| `min_confidence` | `0` | 0.0 - 1.0, inclusive lower bound |
| `page` | `1` | 1-indexed |
| `limit` | `25` | Max 100 |

```bash
# First page of high-confidence legal documents in English
curl "https://api.docxcorp.us/documents?type=legal&lang=en&min_confidence=0.8"
```

Response shape:

```json
{
  "documents": [
    {
      "id": "...",
      "filename": "...",
      "type": "legal",
      "topic": "government",
      "language": "en",
      "word_count": 1234,
      "confidence": 0.95
    }
  ],
  "total": 12345,
  "page": 1,
  "pages": 124,
  "facets": {
    "types":     [{"id": "legal",      "label": "Legal",      "count": 12345}],
    "topics":    [{"id": "government", "label": "Government", "count":  4567}],
    "languages": [{"code": "en", "name": "English", "count": 9012, "percentage": 33.3}]
  }
}
```

`facets.languages` is capped at the top 20 entries with `percentage` computed against the filtered set; the other two facets return all values matching the active (excluding-own-dimension) filters.

Rows are ordered by `classification_confidence DESC NULLS LAST` so the most confidently labeled documents appear first.

### `GET /manifest`

Returns a newline-delimited text file of .docx URLs matching the given filters. Same filter params as `/documents` (no pagination; capped at 2,000,000 rows). Use this when you want to download files in bulk.

```bash
# Manifest of English legal documents, classified at 0.8+ confidence
curl "https://api.docxcorp.us/manifest?type=legal&lang=en&min_confidence=0.8" -o manifest.txt
wc -l manifest.txt
```

Filename is auto-named based on the filters: `docx-corpus-legal-en-manifest.txt`.

## Manifest + wget/curl

Once you have a manifest, bulk-download with standard tools:

```bash
# wget, one file at a time, into ./corpus/
wget -i manifest.txt -P ./corpus/

# wget, parallel (4 concurrent)
xargs -n 1 -P 4 -a manifest.txt wget -q -P ./corpus/

# curl, write each to a hash-named file
xargs -n 1 curl -OJL < manifest.txt
```

Files are content-addressed: `{sha256}.docx`. Two URLs pointing at the same bytes deduplicate to one file on disk because they share an ID.

For the full classified set, fetch the empty manifest:

```bash
curl "https://api.docxcorp.us/manifest" -o all-manifest.txt
# ~736K URLs, plain text, ~73 MB
```

## Programmatic patterns

### Page through everything in Python

```python
import requests

url = "https://api.docxcorp.us/documents"
page = 1
while True:
    r = requests.get(url, params={"limit": 100, "page": page})
    r.raise_for_status()
    data = r.json()
    if not data["documents"]:
        break
    for doc in data["documents"]:
        ...  # do something with each row
    page += 1
```

### Stream extracted text without downloading .docx

```python
import requests
for doc_id in doc_ids:
    text = requests.get(f"https://docxcorp.us/extracted/{doc_id}.txt").text
    ...
```

The extracted text endpoint is cached at the edge and returns `X-Robots-Tag: noindex`, so it doesn't pollute search results.

The API accepts one value per dimension. For multi-value filters, query each value separately or concatenate per-value manifests.

## Rate limits

The API is unmetered and behind Cloudflare. Free, no signup, no API key. For full-corpus pulls, use the Hugging Face dataset rather than paging through `/documents`. If your pipeline will fetch heavily on a schedule, email [help@docxcorp.us](mailto:help@docxcorp.us) first.

## See also

- [/dataset](/dataset) - schema, coverage, license
- [/classification](/classification) - what the labels mean
- [/quality](/quality) - confidence distribution, limitations

---

Built by [SuperDoc](https://superdoc.dev/?utm_source=docxcorp.us&utm_medium=referral&utm_campaign=download) - DOCX editing and tooling.
