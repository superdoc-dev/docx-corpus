# Document Classification Pipeline

Classifies ~800K .docx documents using the [FineWeb-Edu / TnT-LLM](https://huggingface.co/spaces/HuggingFaceFW/blogpost-fineweb-v1) pattern:
LLM labels a small sample → train classifier → apply at scale.

## Two-Dimensional Taxonomy

Each document gets classified on two independent dimensions:

- **Document Type** (10 classes): legal, forms, reports, policies, educational, correspondence, technical, administrative, creative, reference
- **Topic** (9 classes): government, education, healthcare, finance, legal_judicial, technology, environment, nonprofit, general

See [`taxonomy.json`](taxonomy.json) for full definitions and examples.

## Pipeline Steps

### 1. Sample (`sample.py`)

Stratified sampling across languages, word count, and source domains.

```bash
python sample.py --total 3500 --output sampled_docs.jsonl
```

### 2. Label (`label.py`)

LLM classification with Claude. Supports resume — safe to interrupt and restart.

```bash
python label.py --input sampled_docs.jsonl --output labeled_docs.jsonl
python label.py --input sampled_docs.jsonl --output labeled_docs.jsonl --model claude-haiku-4-5 --parallel 5
```

### 3. Train (`train.py`)

Fine-tune xlm-roberta-base on labeled data. Trains two independent classifiers with class-weighted loss.

```bash
# Local training (CPU/MPS/CUDA)
python train.py --input labeled_docs.jsonl

# Cloud training on Modal GPU
python train.py --input labeled_docs.jsonl --modal
python train.py --input labeled_docs.jsonl --modal --gpu a10g
```

### 4. Classify (`classify.py`)

Apply trained models to the full corpus. Supports parallel cloud workers via Modal.

```bash
# Local inference
python classify.py --models-dir ./models

# Cloud inference with 20 parallel GPU workers
python classify.py --models-dir ./models --modal --workers 20
```

### 5. Evaluate (`evaluate.py`)

Check label quality or corpus classification distribution.

```bash
python evaluate.py labels --input labeled_docs.jsonl
python evaluate.py corpus
python evaluate.py corpus --languages en,ru
```

## Setup

```bash
pip install -e .
```

Required environment variables (`.env` in project root):
- `DATABASE_URL` — PostgreSQL connection string
- `ANTHROPIC_API_KEY` — For LLM labeling step only

### Modal Setup (optional, for cloud training/inference)

```bash
pip install modal
python -m modal setup
modal secret create docx-db DATABASE_URL="postgres://..."
```

## Key Files

| File | Purpose |
|------|---------|
| `taxonomy.json` | Two-dimensional taxonomy definition (source of truth) |
| `common.py` | Shared utilities: DB, text fetching, taxonomy loading |
| `sample.py` | Stratified document sampling from PostgreSQL |
| `label.py` | Async LLM labeling with Claude |
| `train.py` | Fine-tune classifiers (local or Modal) |
| `classify.py` | Batch inference on full corpus (local or Modal) |
| `evaluate.py` | Quality metrics and distribution analysis |

## Cost Estimate

- **Labeling**: ~3,500 docs × Claude Haiku ≈ $2-5
- **Training**: ~30 min on T4 GPU (~$0.30 on Modal, free tier covers it)
- **Inference**: ~800K docs with 20 Modal workers ≈ 75 min (~$12 or within free tier)
