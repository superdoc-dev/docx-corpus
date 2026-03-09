# Document Classification Pipeline

Classifies ~800K .docx documents using the FineWeb-Edu / TnT-LLM pattern:
LLM labels a small sample → train ModernBERT classifier → apply at scale.

## Two-Dimensional Taxonomy

Each document gets classified on two independent dimensions:

- **Document Type** (10 classes): legal, forms, reports, policies, educational, correspondence, technical, administrative, creative, reference
- **Topic** (9 classes): government, education, healthcare, finance, legal_judicial, technology, environment, nonprofit, general

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

### 3. Evaluate Labels (`evaluate.py labels`)

Check label quality before training.

```bash
python evaluate.py labels --input labeled_docs.jsonl
```

### 4. Train (`train.py`)

Fine-tune ModernBERT on labeled data. Trains two independent classifiers.

```bash
python train.py --input labeled_docs.jsonl
python train.py --input labeled_docs.jsonl --epochs 5 --lr 2e-5 --output-dir ./models
```

### 5. Classify (`classify.py`)

Apply trained models to the full corpus.

```bash
python classify.py --models-dir ./models
python classify.py --models-dir ./models --batch-size 256 --dry-run --limit 100
```

### 6. Evaluate Corpus (`evaluate.py corpus`)

Check full corpus classification distribution.

```bash
python evaluate.py corpus
python evaluate.py corpus --languages en,ru
```

## Setup

```bash
pip install -r requirements.txt
```

Required environment variables (`.env` in project root):
- `DATABASE_URL` — PostgreSQL connection string
- `ANTHROPIC_API_KEY` — For LLM labeling step only

## Cost Estimate

- **Labeling**: ~3,500 docs × Claude Haiku ≈ $2-5
- **Training**: ~30 min on GPU (or ~2h on CPU)
- **Inference**: ~800K docs, ~200-500 docs/sec on GPU
