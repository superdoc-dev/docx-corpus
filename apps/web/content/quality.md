---
title: "Quality, validation, and known limitations of docx-corpus"
description: "How docx-corpus validates .docx files, deduplicates by content hash, distributes classification confidence, and where the dataset is weakest. First-class limitations."
canonicalPath: /quality
status: draft
lastVerified: 2026-05-19
primaryQuery: "docx dataset quality"
secondaryQueries:
  - "document classification confidence"
  - "common crawl docx coverage"
  - "docx corpus methodology"
---

# Quality

This page is for researchers deciding whether docx-corpus is fit for their task. It documents validation rules, deduplication, the confidence distribution, and the limitations we know about. If you find one we don't list, email [help@docxcorp.us](mailto:help@docxcorp.us).

## Validation

Every file that enters the corpus passes these checks (in [`packages/scraper/validation.ts`](https://github.com/superdoc-dev/docx-corpus/blob/main/packages/scraper/validation.ts)):

1. Minimum size: at least 100 bytes.
2. ZIP magic bytes: starts with `PK\x03\x04`.
3. Contains `[Content_Types].xml`.
4. Contains `word/document.xml` (or `word/document` for older variants).

Files that fail any check are stored as `failed` records (URL hash, no content) so re-runs don't re-fetch them. Failed count is 117,862 (current).

## Deduplication

Storage is content-addressed. The document ID is the SHA-256 of the raw .docx bytes; the storage key is `documents/{id}.docx`. Two URLs that point to byte-identical files collapse to one storage record.

When a duplicate is detected, the second URL is preserved as a `duplicate` record (`dup-{sha256(url+crawlId)}`) that points back to the canonical content hash. This keeps a 1:1 mapping between CDX URLs and database rows per crawl, without storing the bytes twice.

Current dedup outcome: 241,993 duplicate records pointing at 1,101,537 unique-content uploads.

This is exact-content dedup only. **Near-duplicates** (same template with different filled-in fields, or the same document re-saved by Word with minor metadata changes) are NOT detected. Researchers building dedup-sensitive benchmarks should re-dedup at the text level themselves.

## Classification confidence

The `classification_confidence` field is `min(type_confidence, topic_confidence)` from the two XLM-RoBERTa classifiers. Distribution across the 736,242 classified documents (verified 2026-05-19):

| Range | Count | Share |
|---|---:|---:|
| 0.9 - 1.0 | 366,389 | 49.8% |
| 0.8 - 0.9 | 108,863 | 14.8% |
| 0.7 - 0.8 | 74,462 | 10.1% |
| 0.6 - 0.7 | 67,280 | 9.1% |
| 0.5 - 0.6 | 64,795 | 8.8% |
| 0.4 - 0.5 | 39,678 | 5.4% |
| 0.3 - 0.4 | 13,127 | 1.8% |
| 0.2 - 0.3 | 1,596 | 0.2% |
| 0.1 - 0.2 | 52 | <0.01% |

Half the corpus is at 0.9+ confidence. About 14% sits below 0.6. For tasks where label noise matters, filter on `min_confidence=0.7` (76% of the corpus) or `0.8` (65%).

The classifier was not calibrated against a held-out human-annotated test set. The confidence score is the softmax probability from the model, not a probability of correctness. Treat it as a relative ranking, not a calibrated probability.

## Coverage

### Sources

Documents come from Common Crawl WARC archives. Coverage inherits Common Crawl's coverage of the public web: heavy on government, education, and large public-facing sites; thin on intranets, paywalled content, and short-lived web pages.

### Languages

76 distinct languages were detected by lingua. The top 5 (en, ru, cs, pl, es) make up 55% of the corpus. The long tail (down to fewer than 100 documents) covers regional and minority languages, but reliability of the lang code drops on very short documents.

`unknown` is its own bucket (103,869 documents, ~9.4% of total) where lingua couldn't make a confident call, typically very short or symbol-heavy documents.

### Document length

| Statistic | Value |
|---|---:|
| Min word count | 1 |
| Median word count | 566 |
| Mean word count | 2,795 |
| Max word count | 15,811,488 |

The mean is pulled by a long tail of very large documents (legal compendia, technical manuals). The median is the better summary of "what a typical document looks like."

Documents with `word_count = 0` (4,316 records) extracted as zero words even though the .docx itself was valid. The records have not been sampled to classify the causes.

## Pipeline gaps

The 365K-document gap between "uploaded" (1.1M) and "classified" (736K) breaks down as:

| Bucket | Count | What it is |
|---|---:|---|
| Extracted, awaiting classification | 267,539 | Text exists, classifier hasn't run on these rows yet |
| Uploaded, awaiting extraction | 93,440 | File on R2, extraction pipeline hasn't processed them |
| Extracted with empty text | 4,316 | Extraction returned zero words; root causes not yet sampled |

This gap is operational, not a quality decision. As extraction and classification batches run, the classified set will grow.

## Known limitations

1. **Source bias.** Common Crawl reflects what's publicly linked, not what's privately authored. Government and education domains over-publish .docx, so they're over-represented. Intranets and content behind login are absent.
2. **Topic skew.** `government` (33%) and `education` (25%) dominate. Filter and sample if you need balance.
3. **English-heavy.** English is 33% of the classified subset. Smaller languages are present but small in share.
4. **No human evaluation set.** Classification accuracy is bounded by the LLM labeler (Claude Haiku 4.5). No human-annotated test set has been published.
5. **Near-duplicate templates not collapsed.** Exact byte-identical duplicates are removed; near-duplicates (same template, different fields) remain.
6. **Language detection on short docs.** Lingua is reliable on full text and less so on short, mixed-language, or symbol-heavy content (hence the `unknown` bucket).
7. **Word counts cover extracted text only.** Text inside images or scanned content is not counted.
8. **License covers the metadata, not the originals.** Individual document copyright stays with the author. The corpus is a metadata index plus content-addressed mirror, distributed under ODC-BY.

See [/classification](/classification) for model caveats and [/dataset](/dataset) for schema and access.

---

Built by [SuperDoc](https://superdoc.dev/?utm_source=docxcorp.us&utm_medium=referral&utm_campaign=quality) - DOCX editing and tooling.
