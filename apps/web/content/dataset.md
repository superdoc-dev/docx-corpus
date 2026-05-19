---
title: "docx-corpus dataset: 736K classified Word documents from the public web"
description: "Schema, coverage, and access methods for docx-corpus. 736K classified .docx files from Common Crawl, plus 365K additional uploaded files not yet in the classified browser/API set. Open dataset for document AI research."
canonicalPath: /dataset
status: draft
lastVerified: 2026-05-19
primaryQuery: "docx dataset"
secondaryQueries:
  - "document corpus"
  - "word document dataset"
  - "open dataset for document AI"
---

# docx-corpus dataset

docx-corpus is an open dataset of real Word documents collected from Common Crawl. Each document is validated, deduplicated by content hash, has text extracted, and is labeled by document type and topic with a fine-tuned XLM-RoBERTa classifier.

## What's in it

Live numbers (verified 2026-05-19). Hero totals come from [api.docxcorp.us/stats](https://api.docxcorp.us/stats); the pipeline-gap breakdown, duplicate/failed counts, and word-count statistics come from direct database queries.

| Bucket | Count |
|---|---:|
| Total documents uploaded | 1,101,537 |
| Classified (type + topic + language) | 736,242 |
| Extracted, awaiting classification | 267,539 |
| Uploaded, awaiting extraction | 93,440 |
| Extracted with empty text (skipped) | 4,316 |
| Duplicate records (cross-crawl) | 241,993 |
| Failed records (WARC error, invalid .docx) | 117,862 |

The classified subset is what the browser, the API, and the Hugging Face dataset expose by default. The extracted and awaiting-extraction uploaded buckets are pipeline backlog and move into the classified set as extraction and classification catch up. Failed, duplicate, and empty-text rows stay in the database for accounting and do not reach the classified set under the current pipeline.

## Per-document schema

Each classified row exposes:

| Field | Type | Description |
|---|---|---|
| `id` | string | SHA-256 of the raw .docx bytes; also the storage key (`documents/{id}.docx`) |
| `filename` | string | Original filename as observed in the source URL |
| `document_type` | enum (10) | Form/structure label. See [classification](/classification). |
| `document_topic` | enum (9) | Subject domain label. See [classification](/classification). |
| `language` | ISO 639-1 | Detected by lingua. 76 distinct values present. |
| `word_count` | integer | Words in extracted text. Median 566, mean 2,795. |
| `classification_confidence` | float | `min(type_conf, topic_conf)`. See [quality](/quality) for distribution. |
| `url` | string | `https://docxcorp.us/documents/{id}.docx` |

The extracted text for any classified document is available at `https://docxcorp.us/extracted/{id}.txt`. Raw .docx and extracted text both return `X-Robots-Tag: noindex` so they don't compete with the dataset pages in search.

## Coverage

| Dimension | Count |
|---|---:|
| Document types | 10 |
| Topics | 9 |
| Distinct languages detected | 76 |
| Common Crawl snapshots | 3+ (varies by snapshot, see scraper logs) |

Top 5 languages in the classified subset (out of 76):

| Lang | Documents | Share |
|---|---:|---:|
| en | 245,018 | 33.3% |
| ru | 57,879 | 7.9% |
| cs | 50,709 | 6.9% |
| pl | 38,546 | 5.2% |
| es | 36,442 | 4.9% |

The dataset is multilingual but English-dominant. Smaller-language documents are present but underrepresented relative to web traffic. Top languages in the uploaded-but-not-yet-classified set differ slightly; see [/quality](/quality) for the per-bucket breakdown.

## How to access

| Method | Best for | See |
|---|---|---|
| Hugging Face dataset | Bulk download, Parquet, `datasets` library | [/download](/download) |
| REST API at api.docxcorp.us | Programmatic queries, faceted filters | [/download](/download) |
| Manifest endpoint | Bulk .docx URL list for `wget` / `curl` | [/download](/download) |
| Per-doc URL | One file at a time | `https://docxcorp.us/documents/{id}.docx` |

## License

Dataset metadata is licensed under [ODC-BY 1.0](https://opendatacommons.org/licenses/by/1-0/). The pipeline source code is MIT-licensed. Individual document contents retain their original copyright; the dataset is a metadata index plus a content-addressed mirror.

If you need a document removed from the corpus, email [help@docxcorp.us](mailto:help@docxcorp.us) with the URL or hash.

## Citing

> docx-corpus (2026). Open corpus of classified Word documents from the public web. [https://docxcorp.us](https://docxcorp.us). Built by SuperDoc.

## See also

- [/classification](/classification) - taxonomy, labeling, model, training procedure
- [/quality](/quality) - validation rules, dedup, confidence distribution, known limitations
- [/download](/download) - Hugging Face, API endpoints, manifest, code examples

---

Built by [SuperDoc](https://superdoc.dev/?utm_source=docxcorp.us&utm_medium=referral&utm_campaign=dataset) - DOCX editing and tooling.
