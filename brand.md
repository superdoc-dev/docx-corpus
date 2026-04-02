---
name: "docx-corpus"
tagline: "Every Word document on the public web. Classified and open."
version: 1
language: en
---

# docx-corpus

## Strategy

### Overview

docx-corpus is the largest open corpus of classified Word documents on the public web. It scrapes, validates, deduplicates, extracts, and classifies .docx files from Common Crawl — turning the raw internet into structured, research-ready data.

It started because SuperDoc needed to understand the real world. When you're building a document engine, you need to know what documents actually look like in the wild — not the ten files someone tested with, but hundreds of thousands of real documents from real organizations across the globe. What formatting do they use? What structures are common? What breaks? No dataset like that existed. So we built one — and open-sourced it, because the document processing community needs this infrastructure as much as we do.

What docx-corpus really does is make the invisible visible. There are millions of Word documents scattered across the public web — inside government portals, university servers, NGO websites, corporate compliance pages. Nobody had systematically collected, validated, and classified them. docx-corpus does exactly that: it turns chaos into a structured, queryable dataset that anyone can build on.

The problem it solves is foundational. The entire document AI research ecosystem is built on scanned images from the 1990s and PDFs. The world's most used document creation format — DOCX — has no serious research infrastructure. Researchers collect their own files ad hoc. Tool developers test against a handful of samples. Nobody knows what "normal" looks like at scale. docx-corpus fixes this.

**Before docx-corpus**: Researchers spend weeks collecting their own document files before they can begin work. Tool developers test against a dozen hand-picked samples. Benchmarks use 30-year-old tobacco litigation scans. Nobody has a clear picture of what real-world DOCX files look like.

**After docx-corpus**: 736K+ documents, classified by type and topic, in 46+ languages, with extracted text and embeddings — downloadable, searchable, and queryable through an API. Start your research today, not next month.

**Long-term ambition**: docx-corpus becomes the reference dataset for any work involving Word documents — the way ImageNet became the reference for vision and Common Crawl became the reference for text.

### Positioning

**Category**: Open research corpus for native Word documents — the missing dataset in document AI.

**What docx-corpus is NOT**:
- Not a document viewer or editor
- Not a SaaS product with a subscription
- Not a benchmark leaderboard
- Not a PDF dataset
- Not a synthetic or curated collection — these are real documents from real organizations

**Competitive landscape**:

The document research ecosystem has three layers:

1. **Scanned document benchmarks** (RVL-CDIP, IIT-CDIP, DocVQA) — 1990s tobacco litigation scans and document images. The standard benchmarks, but fundamentally limited: they represent documents as pictures, not as structured data.
2. **PDF corpora** (FinePDFs, SafeDocs, PDFA) — Large-scale PDF datasets for pretraining and security research. Well-funded, growing fast. PDF is treated as a first-class research format.
3. **General file corpora** (Govdocs1, NapierOne) — Mixed file-type collections for digital forensics. DOCX is a small fraction, uncurated, unclassified.

docx-corpus creates a fourth layer that didn't exist: **native DOCX research infrastructure**. The format people actually write in, finally treated as a first-class research subject.

**Structural differentiators**:
- **Only large-scale open DOCX corpus** — 736K+ documents. The next largest DOCX-specific collection is ~5,000 files.
- **Full pipeline, not just files** — Raw documents + extracted text + embeddings + classification labels. Most corpora offer one layer. This offers all four.
- **Real-world sourced** — Common Crawl-sourced from the actual public web, not synthetic generation or a single domain.
- **Classified** — 10 document types, 9 topics, 46+ languages. No other DOCX dataset has this structure.
- **Built by a DOCX company** — Maintained by SuperDoc, a team that builds DOCX tooling for a living. This isn't a side project.

**The territory docx-corpus owns**: The ground truth of what Word documents look like in the wild.

### Personality

**Dominant archetype**: The Infrastructure Builder — foundational, enabling, the thing everything else stands on. Does the work so others can do theirs.

**Attributes the brand transmits**:
- Rigorous
- Open
- Comprehensive
- Foundational
- Unpretentious
- Methodical

**What docx-corpus IS**:
- Research infrastructure, built in the open
- The boring but essential layer that makes interesting work possible
- Rigorous about data quality, generous about access
- A gift from a company that needed this data to a community that needs it too
- The kind of dataset researchers cite in their papers

**What docx-corpus is NOT**:
- A startup chasing metrics
- A product with a growth strategy
- A shiny demo
- A "platform" or "ecosystem"
- Impressive on the surface and hollow underneath

### Promise

docx-corpus gives you the largest classified collection of real Word documents on the public web.
Every document is validated, deduplicated, and classified — ready for research, not cleanup.
The data is open. The pipeline is open. The code is open.

**Base message**: docx-corpus is the open dataset that document processing research has been missing — 736K+ real-world Word documents, classified and ready to use.

**Synthesizing phrase**: docx-corpus exists because the world's most used document format deserved a real dataset.

### Guardrails

**Tone summary**: Direct. Technical. Matter-of-fact. Dry. No hype.

**What the brand cannot be**:
- A marketing vehicle for SuperDoc
- A project that overstates its coverage or accuracy
- A dataset that claims to be more than it is
- A brand that uses the word "revolutionary" or "game-changing"
- Anything that sounds like a pitch deck

**Litmus test**: If it sounds like a startup announcement, it's wrong. If it sounds like a README, it's right.

---

## Voice

### Identity

We build open data infrastructure for document processing. Not a product. Not a service. A dataset and a pipeline that anyone can use.

We started docx-corpus because we needed it ourselves. SuperDoc builds a DOCX engine, and to build a good one, you need to understand what real documents look like at scale — not the ten files you tested with, but the full spectrum of what people actually create in Word. We went looking for a large, classified corpus of .docx files and found nothing. So we built one. And we open-sourced it, because the gap isn't just ours — it belongs to the entire document processing community.

We are not a product company trying to monetize data. We are not building a platform. We scraped the web, validated the documents, classified them, and put them on HuggingFace. Use them. Build on them. Cite us if you want.

**Essence**: The missing dataset.

### Tagline & Slogans

**Primary tagline**: Every Word document on the public web. Classified and open.
_Use on homepage hero, GitHub README, HuggingFace dataset card._

**Alternatives**:
- The largest open corpus of classified Word documents.
- Real documents. Real web. Open data.
- 736K+ Word documents. Classified. Open.

**Slogans for different contexts**:
- Research context: "The DOCX dataset that document AI has been missing."
- Developer context: "736K+ .docx files. 10 types. 9 topics. 46+ languages. One API call."
- Data science context: "Real-world Word documents. Pre-extracted. Pre-classified. Pre-embedded."
- Open source context: "Open data. Open pipeline. Open code."
- SuperDoc context: "Built by SuperDoc — DOCX editing and tooling. Given to the community."

### Message Pillars

**Scale**
- 736K+ documents from 3+ Common Crawl snapshots. The largest DOCX-specific dataset in existence.
- Not a sample. Not a subset. A comprehensive scrape of the public web.

**Classification**
- 10 document types: legal, forms, reports, policies, educational, correspondence, technical, administrative, creative, reference.
- 9 topics: government, education, healthcare, finance, legal/judicial, technology, environment, nonprofit, general.
- 46+ languages detected and labeled.

**Openness**
- Full dataset on HuggingFace. API at api.docxcorp.us. Source code on GitHub.
- No gatekeeping. No registration walls. No "request access."

**Quality**
- Every document validated as real DOCX. Content-addressed deduplication. Text extracted via Docling.
- This is not a raw dump — it's a curated pipeline with documented methodology.

**Real-world**
- Sourced from real organizations: governments, universities, NGOs, corporations.
- Not synthetic. Not from a single domain. Not hand-picked. The actual web.

### Phrases

- "The world's most used document format had no dataset. Now it does."
- "Scraped from the web. Classified by machine. Open to everyone."
- "736K documents. Zero gatekeeping."
- "We built the dataset we couldn't find."
- "Real documents from real organizations — not synthetic, not hand-picked."
- "The boring infrastructure that makes interesting research possible."
- "Documents are authored in Word but researched as images. That's the gap."

### Tonal Rules

1. State facts. Numbers over adjectives. "736K+ documents" not "a massive collection."
2. README energy. Write like you're documenting a tool, not selling a product.
3. No marketing vocabulary. If the word appears in a SaaS landing page template, don't use it.
4. Dry over enthusiastic. Understatement signals confidence.
5. Mechanism over claim. "Content-addressed deduplication via SHA-256" not "advanced deduplication technology."
6. Acknowledge limitations. "Classification confidence averages 82%" not "highly accurate classification."
7. Use real terminology. "Common Crawl WARC archives" not "web data sources."
8. One sentence, one fact. Don't overload.
9. Developer-native language. Assume the reader knows what an API is.
10. Let the data speak. The numbers are impressive enough without embellishment.

**Identity boundaries**:
- We are not a startup. We are an open data project maintained by a company that builds DOCX tooling.
- We are not selling anything. The dataset is free.
- We are not a research group publishing papers. We build infrastructure so research groups can.
- We are not competing with PDF corpora. We fill the gap they don't cover.
- We are not in the business of impressions. We are in the business of data.

| We Say | We Never Say |
|---|---|
| "736K+ classified DOCX files" | "The world's most comprehensive document intelligence platform" |
| "Scraped from Common Crawl" | "Powered by cutting-edge web mining technology" |
| "Open dataset on HuggingFace" | "Democratizing access to document data" |
| "10 document types, 9 topics" | "Rich multi-dimensional classification taxonomy" |
| "Built by SuperDoc — DOCX editing and tooling" | "Backed by industry-leading document technology" |
| "Download the dataset" | "Get started on your document AI journey" |
| "Classification averages 82% confidence" | "State-of-the-art classification accuracy" |
| "We needed this data. You probably do too." | "Unlock the power of document intelligence" |

---

## Visual

### Colors

**Primary — Coral**
`#F97B6D` — Signature accent. Links, highlights, badge backgrounds, the "docx" half of the two-tone wordmark.

**Text — Charcoal**
`#2D2D2D` — Headings, body copy, the "corpus" half of the wordmark.

**Supporting palette**:
| Role | Hex | Usage |
|---|---|---|
| Muted | `#9CA3AF` | Secondary text, metadata, counts |
| Background | `#FFFFFF` | Page background, cards |
| Dark background | `#18181B` | Dark mode surfaces |
| Dark text | `#E5E5E5` | Dark mode body text |
| Border | `#E5E7EB` | Dividers, card borders |

**Colors to avoid**: SuperDoc Blue (`#1355FF`) — docx-corpus has its own identity. Neon colors, gradients, or anything that signals "product." The palette is warm and muted — coral punctuates, neutrals carry.

### Typography

**Display / Body — Inter**
Weights: Regular (400), Semibold (600)
Usage: Wordmark, headings, body text, all UI. System sans-serif fallback.

**Monospace — JetBrains Mono**
Weight: Regular (400)
Usage: Code snippets, CLI commands, API examples, document IDs, hash values.

### Style

**Design keywords**: Systematic. Clean. Data-dense. Functional. Restrained. Academic.

**Reference brands**: Linear (craft and restraint), Resend (developer-first clarity), Vercel (infrastructure confidence), Raycast (functional beauty), Arc (opinionated design that earns trust).

**Anti-reference brands**: Salesforce (enterprise bloat, confusing UI, everything is a "platform"), Jira (complexity worship, configuration over convention, vendor lock-in aesthetic).

**Direction**: The visual identity communicates research infrastructure, not product marketing. Dense data tables over hero images. Monospace where it matters. Generous whitespace, flat surfaces, no decoration. The design should feel like a well-maintained research dataset's documentation page — clear, navigable, trustworthy. Coral adds warmth to what would otherwise be austere. The confidence comes from the data, not the design.
