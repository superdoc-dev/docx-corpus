import type { APIRoute } from 'astro';
import { absoluteUrl, routes } from '../lib/routes';
import { getTypeFacets, getTopicFacets, getCorpusStats } from '../lib/data';

// Generated llms.txt for AI assistants per https://llmstxt.org
// Built at deploy time from live counts so AI consumers see current numbers.

export const GET: APIRoute = async () => {
  const [types, topics, stats] = await Promise.all([
    getTypeFacets(),
    getTopicFacets(),
    getCorpusStats(),
  ]);

  const body = `# docx-corpus

> Every Word document on the public web. Classified and open.

The largest open corpus of classified Word documents. ${stats.totalClassified.toLocaleString()} real .docx files from the public web, classified into ${types.length} document types and ${topics.length} topics across ${stats.languageCount} languages. Built for document processing research, NLP benchmarking, and training models that work with real-world Word documents.

Documents are classified using fine-tuned XLM-RoBERTa text classifiers. See ${absoluteUrl(routes.classification())} for full methodology and ${absoluteUrl(routes.quality())} for the confidence distribution.

Built by [SuperDoc](https://superdoc.dev) - DOCX editing and tooling.

## Reference pages

- [Dataset](${absoluteUrl(routes.dataset())}): schema, coverage, access methods, license
- [Classification](${absoluteUrl(routes.classification())}): taxonomy, model, training procedure
- [Quality](${absoluteUrl(routes.quality())}): validation, dedup, confidence distribution, known limitations
- [Download](${absoluteUrl(routes.download())}): Hugging Face, REST API, manifest, code examples

## Document types

${types.map(t => `- [${t.label}](${absoluteUrl(routes.type(t.id))}): ${t.count.toLocaleString()} documents`).join('\n')}

## Topics

${topics.map(t => `- [${t.label}](${absoluteUrl(routes.topic(t.id))}): ${t.count.toLocaleString()} documents`).join('\n')}

## Links

- Homepage: ${absoluteUrl(routes.home())}
- GitHub: https://github.com/superdoc-dev/docx-corpus
- HuggingFace: https://huggingface.co/datasets/superdoc-dev/docx-corpus
- API: https://api.docxcorp.us
- Takedown requests: help@docxcorp.us
`;

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
