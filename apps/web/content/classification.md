---
title: "How docx-corpus classifies Word documents: taxonomy, model, and procedure"
description: "Two-dimensional taxonomy of 10 document types and 9 topics. Trained from a 3,500-document Claude-labeled sample using a fine-tuned XLM-RoBERTa classifier. Full methodology."
canonicalPath: /classification
status: draft
lastVerified: 2026-05-19
primaryQuery: "document classification taxonomy"
secondaryQueries:
  - "docx classification"
  - "xlm-roberta document classifier"
  - "document type taxonomy"
---

# Classification

docx-corpus uses a two-dimensional taxonomy. Every classified document has one document_type label (its form/structure) and one document_topic label (its subject domain). The labels are independent; a `legal` document can have any topic, and a `government` topic can have any document_type.

Taxonomy version: `docx-corpus-v2` (2.0.0). Source: [scripts/classification/taxonomy.json](https://github.com/superdoc-dev/docx-corpus/blob/main/scripts/classification/taxonomy.json).

## Document types (10)

Form or structure of the document.

| ID | Label | Examples |
|---|---|---|
| `legal` | Legal Documents | contracts, NDAs, terms, regulations, statutes |
| `forms` | Forms & Applications | applications, registrations, surveys, ballots |
| `reports` | Reports & Analysis | annual reports, research papers, case studies, white papers |
| `policies` | Policies & Procedures | privacy policies, employee handbooks, SOPs |
| `educational` | Educational Materials | syllabi, lesson plans, theses, dissertations |
| `correspondence` | Correspondence | letters, memos, press releases, newsletters |
| `technical` | Technical Documentation | manuals, API docs, specifications, datasheets |
| `administrative` | Administrative Documents | meeting minutes, agendas, organizational docs |
| `creative` | Creative & Marketing | brochures, proposals, marketing plans, presentation scripts, pitch decks |
| `reference` | Reference & Catalogs | product catalogs, directories, glossaries, FAQs, indexes |

## Topics (9)

Subject domain of the document.

`government`, `education`, `healthcare`, `finance`, `legal_judicial`, `technology`, `environment`, `nonprofit`, `general`.

The `general` topic is the catch-all when no domain-specific label fits. Full descriptions and examples live in `taxonomy.json`.

## Pipeline

The classification pipeline follows the [FineWeb-Edu](https://huggingface.co/spaces/HuggingFaceFW/blogpost-fineweb-v1) pattern: an LLM labels a small sample, that sample trains a lightweight classifier, and the classifier runs over the full corpus.

```
sample.py    -> stratified sample of 3,500 documents
label.py     -> Claude Haiku 4.5 labels each one (type + topic)
train.py     -> fine-tune xlm-roberta-base on the labels
classify.py  -> apply trained classifiers to every extracted document
```

### Sampling

`scripts/classification/sample.py` draws a stratified sample from the database:

- Default total: 3,500 documents
- Languages: en, ru, cs, pl, es (proportional to corpus distribution)
- Stratification: word-count terciles (small / medium / large) plus source-domain diversity
- Seed: 42 (reproducible)

The goal is coverage of length and source, not random uniform sampling. A 10K-word policy doc and a 50-word memo both need to be representable.

### LLM labeling

`scripts/classification/label.py` calls Claude Haiku 4.5 for each sampled document. The prompt includes the full taxonomy with descriptions and examples. The labeler returns `(document_type, document_topic, confidence_per_dim)`.

Async, rate-limited, resumable. Output is a JSONL file used as training input.

### Classifier training

`scripts/classification/train.py` fine-tunes `xlm-roberta-base` with these defaults:

| Hyperparameter | Value |
|---|---|
| Base model | `xlm-roberta-base` (multilingual) |
| Epochs | 5 |
| Learning rate | 2e-5 |
| Batch size | 16 |
| Max token length | 512 |
| Validation split | 15% |
| Loss | Cross-entropy with class weights for class imbalance |

Two independent classifiers are trained: one for `document_type` (10 classes), one for `document_topic` (9 classes). Both share the same base model and training data.

Class weights are computed from the label distribution so that small classes (e.g. `creative`, `reference`) don't get drowned out by `legal` and `forms`.

Training supports `--modal` for cloud GPUs (T4 default, configurable). Models are persisted to `./models/{dimension}/best/`.

### Inference at scale

`scripts/classification/classify.py` loads both trained classifiers and runs them over every extracted document.

- Local mode: single device (CUDA / MPS / CPU)
- Cloud mode: `--modal --workers 20` fans out across parallel containers (~160 docs/sec aggregate)
- Resumable: already-classified documents are skipped on restart
- Writes back to the `documents` table: `document_type`, `document_topic`, `classification_confidence`, `classification_model`

The `classification_model` column records `{base_model}-{taxonomy_version}` (e.g. `xlm-roberta-base-2.0.0`) so future taxonomy revisions or model swaps can be distinguished.

The two dimensions are independent so a government privacy policy can be `(policies, government)` and a finance handbook can be `(policies, finance)`. 90 combinations are possible; the API exposes filters for any subset.

## Known limitations

- **Labeler ceiling.** Claude Haiku 4.5 is the upper bound on accuracy. No independent human-annotated evaluation set has been published with this release, so absolute classifier accuracy is unmeasured against a human baseline.
- **English-trained, multilingual-applied.** The training sample is drawn from 5 languages (en, ru, cs, pl, es). The classifier is run over 76 languages because `xlm-roberta-base` is multilingual, but accuracy on languages outside the training set has not been measured here.
- **Topic skew.** `government` and `education` dominate the topic distribution (~58% combined). This reflects the public web (.gov, .edu domains over-publish .docx), not a sampling choice.
- **Hard cases.** Documents that span types (e.g. a "report" that's mostly tables and forms) get a single label. The confidence score helps you filter these.

See [/quality](/quality) for confidence distributions and the rest of the dataset's limitations.

## Reproducing this

Code in [scripts/classification/](https://github.com/superdoc-dev/docx-corpus/tree/main/scripts/classification). Run order: `sample.py` -> `label.py` -> `train.py` -> `classify.py`. Pipeline notes in [CLAUDE.md](https://github.com/superdoc-dev/docx-corpus/blob/main/scripts/classification/CLAUDE.md).

---

Built by [SuperDoc](https://superdoc.dev/?utm_source=docxcorp.us&utm_medium=referral&utm_campaign=classification) - DOCX editing and tooling.
