#!/usr/bin/env bun
/**
 * Generate static type/topic pages for SEO.
 *
 * Queries the database for per-type and per-topic breakdowns, then renders
 * static HTML pages using shared template functions ("components").
 *
 * Usage:
 *   bun run apps/web/scripts/generate-pages.ts
 *
 * Requires DATABASE_URL in environment (loaded automatically by Bun from .env).
 */

import { SQL } from "bun";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = new SQL({ url: DATABASE_URL });

const SITE = "https://docxcorp.us";
const OUT_DIR = new URL("../", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Labels & descriptions
// ---------------------------------------------------------------------------

const TYPE_META: Record<string, { label: string; desc: string }> = {
  legal: { label: "Legal", desc: "Contracts, agreements, legal notices, court filings, and compliance documentation." },
  forms: { label: "Forms", desc: "Application forms, registration forms, surveys, questionnaires, and fillable templates." },
  reports: { label: "Reports", desc: "Annual reports, research reports, progress reports, financial reports, and analysis documents." },
  policies: { label: "Policies", desc: "Policy documents, procedures, guidelines, handbooks, and organizational rules." },
  educational: { label: "Educational", desc: "Course materials, syllabi, assignments, lecture notes, and academic resources." },
  correspondence: { label: "Correspondence", desc: "Letters, memos, emails, notices, and formal communications." },
  technical: { label: "Technical", desc: "Technical documentation, specifications, API docs, user manuals, and engineering documents." },
  administrative: { label: "Administrative", desc: "Meeting minutes, agendas, organizational documents, and administrative records." },
  creative: { label: "Creative", desc: "Creative writing, marketing materials, brochures, newsletters, and promotional content." },
  reference: { label: "Reference", desc: "Reference materials, glossaries, directories, catalogs, and lookup documents." },
  general: { label: "General", desc: "General-purpose Word documents that span multiple categories." },
};

const TOPIC_META: Record<string, { label: string; desc: string }> = {
  government: { label: "Government", desc: "Documents from government agencies, public administration, and civic organizations." },
  education: { label: "Education", desc: "Documents from schools, universities, research institutions, and educational programs." },
  healthcare: { label: "Healthcare", desc: "Documents from hospitals, clinics, pharmaceutical companies, and health organizations." },
  finance: { label: "Finance", desc: "Documents from banks, investment firms, insurance companies, and financial institutions." },
  legal_judicial: { label: "Legal / Judicial", desc: "Documents from law firms, courts, regulatory bodies, and judicial institutions." },
  technology: { label: "Technology", desc: "Documents from tech companies, software firms, IT departments, and digital services." },
  environment: { label: "Environment", desc: "Documents related to environmental agencies, sustainability, and conservation efforts." },
  nonprofit: { label: "Nonprofit", desc: "Documents from NGOs, charities, foundations, and community organizations." },
  general: { label: "General", desc: "Documents from various sectors that span multiple topic categories." },
};

const LANG_NAMES: Record<string, string> = {
  en: "English", ru: "Russian", cs: "Czech", pl: "Polish", es: "Spanish",
  zh: "Chinese", lt: "Lithuanian", sk: "Slovak", de: "German", id: "Indonesian",
  fr: "French", pt: "Portuguese", ar: "Arabic", ja: "Japanese", ko: "Korean",
  it: "Italian", sv: "Swedish", nl: "Dutch", bg: "Bulgarian", tr: "Turkish",
  vi: "Vietnamese", th: "Thai", uk: "Ukrainian", ro: "Romanian", hu: "Hungarian",
  hr: "Croatian", fi: "Finnish", da: "Danish", nb: "Norwegian", el: "Greek",
  he: "Hebrew", hi: "Hindi", unknown: "Unknown",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FacetRow { id: string; count: number }
interface LangRow { code: string; count: number }
interface DocRow {
  id: string;
  filename: string | null;
  document_type: string;
  document_topic: string;
  language: string | null;
  word_count: number | null;
  classification_confidence: number | null;
}

interface PageData {
  kind: "type" | "topic";
  id: string;
  label: string;
  description: string;
  total: number;
  langCount: number;
  avgConfidence: number;
  languages: LangRow[];
  crossDimension: FacetRow[]; // topics for a type page, types for a topic page
  crossMeta: Record<string, { label: string }>;
  crossKind: "topic" | "type";
  siblings: FacetRow[];
  documents: DocRow[];
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

async function queryTypeStats(typeId: string) {
  const [[{ total, lang_count, avg_conf }], languages, topics, documents] = await Promise.all([
    sql<{ total: number; lang_count: number; avg_conf: number }[]>`
      SELECT COUNT(*)::int AS total,
             COUNT(DISTINCT language) FILTER (WHERE language IS NOT NULL)::int AS lang_count,
             ROUND(AVG(classification_confidence)::numeric, 1)::float AS avg_conf
      FROM documents
      WHERE document_type = ${typeId} AND status = 'uploaded'
    `,
    sql<LangRow[]>`
      SELECT COALESCE(NULLIF(language, 'unknown'), 'unknown') AS code, COUNT(*)::int AS count
      FROM documents
      WHERE document_type = ${typeId} AND status = 'uploaded'
      GROUP BY 1 ORDER BY count DESC LIMIT 8
    `,
    sql<FacetRow[]>`
      SELECT document_topic AS id, COUNT(*)::int AS count
      FROM documents
      WHERE document_type = ${typeId} AND document_topic IS NOT NULL
      GROUP BY 1 ORDER BY count DESC
    `,
    sql<DocRow[]>`
      SELECT id, original_filename AS filename, document_type, document_topic,
             language, word_count, classification_confidence
      FROM documents
      WHERE document_type = ${typeId} AND classification_confidence IS NOT NULL
      ORDER BY classification_confidence DESC
      LIMIT 10
    `,
  ]);
  return { total, langCount: lang_count, avgConfidence: avg_conf, languages, topics, documents };
}

async function queryTopicStats(topicId: string) {
  const [[{ total, lang_count, avg_conf }], languages, types, documents] = await Promise.all([
    sql<{ total: number; lang_count: number; avg_conf: number }[]>`
      SELECT COUNT(*)::int AS total,
             COUNT(DISTINCT language) FILTER (WHERE language IS NOT NULL)::int AS lang_count,
             ROUND(AVG(classification_confidence)::numeric, 1)::float AS avg_conf
      FROM documents
      WHERE document_topic = ${topicId} AND status = 'uploaded'
    `,
    sql<LangRow[]>`
      SELECT COALESCE(NULLIF(language, 'unknown'), 'unknown') AS code, COUNT(*)::int AS count
      FROM documents
      WHERE document_topic = ${topicId} AND status = 'uploaded'
      GROUP BY 1 ORDER BY count DESC LIMIT 8
    `,
    sql<FacetRow[]>`
      SELECT document_type AS id, COUNT(*)::int AS count
      FROM documents
      WHERE document_topic = ${topicId} AND document_type IS NOT NULL
      GROUP BY 1 ORDER BY count DESC
    `,
    sql<DocRow[]>`
      SELECT id, original_filename AS filename, document_type, document_topic,
             language, word_count, classification_confidence
      FROM documents
      WHERE document_topic = ${topicId} AND classification_confidence IS NOT NULL
      ORDER BY classification_confidence DESC
      LIMIT 10
    `,
  ]);
  return { total, langCount: lang_count, avgConfidence: avg_conf, languages, types, documents };
}

async function queryAllFacets() {
  const [types, topics] = await Promise.all([
    sql<FacetRow[]>`
      SELECT document_type AS id, COUNT(*)::int AS count
      FROM documents WHERE document_type IS NOT NULL
      GROUP BY 1 ORDER BY count DESC
    `,
    sql<FacetRow[]>`
      SELECT document_topic AS id, COUNT(*)::int AS count
      FROM documents WHERE document_topic IS NOT NULL
      GROUP BY 1 ORDER BY count DESC
    `,
  ]);
  return { types, topics };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function barWidth(count: number, max: number): number {
  return Math.max(4, Math.round((count / max) * 100));
}

function barClass(i: number): string {
  if (i === 0) return "bar-fill primary";
  if (i < 3) return "bar-fill muted";
  return "bar-fill light";
}

// ---------------------------------------------------------------------------
// Template: shared pieces
// ---------------------------------------------------------------------------

function sharedStyles(): string {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', system-ui, sans-serif; background: #fff; color: #2D2D2D; min-height: 100vh; }
    a { color: inherit; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 20px 48px; max-width: 1200px; margin: 0 auto; }
    .brand { font-size: 0.95rem; font-weight: 700; letter-spacing: -0.02em; }
    .brand a { text-decoration: none; color: #2D2D2D; }
    .brand .accent { color: #F97B6D; }
    .links { display: flex; gap: 24px; }
    .links a { text-decoration: none; color: #9CA3AF; font-size: 0.82rem; font-weight: 500; transition: color 0.15s; }
    .links a:hover { color: #2D2D2D; }
    .links a.active { color: #F97B6D; }
    .container { max-width: 1200px; margin: 0 auto; padding: 0 48px; }
    .breadcrumb { font-size: 0.78rem; color: #9CA3AF; padding: 16px 0 0; }
    .breadcrumb a { color: #9CA3AF; text-decoration: none; }
    .breadcrumb a:hover { color: #F97B6D; }
    .breadcrumb .sep { margin: 0 6px; }
    .hero { padding: 40px 0 48px; border-bottom: 1px solid #f0f0f0; margin-bottom: 40px; }
    .hero-kicker { font-size: 0.72rem; font-weight: 600; color: #F97B6D; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 12px; }
    .hero h1 { font-size: 2.4rem; font-weight: 800; letter-spacing: -0.04em; line-height: 1.1; margin-bottom: 16px; max-width: 700px; }
    .hero-description { font-size: 1rem; color: #6B7280; line-height: 1.7; max-width: 640px; margin-bottom: 12px; }
    .hero-by { font-size: 0.85rem; color: #9CA3AF; margin-bottom: 32px; }
    .hero-by a { color: #F97B6D; text-decoration: none; font-weight: 600; }
    .hero-by a:hover { text-decoration: underline; }
    .numbers { display: flex; gap: 48px; }
    .num-val { font-family: 'JetBrains Mono', monospace; font-size: 1.8rem; font-weight: 700; letter-spacing: -0.02em; }
    .num-label { font-size: 0.72rem; color: #9CA3AF; letter-spacing: 0.02em; }
    .section-label { font-size: 0.72rem; font-weight: 600; color: #9CA3AF; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 20px; }
    .stats-section { padding: 0 0 40px; border-bottom: 1px solid #f0f0f0; margin-bottom: 40px; }
    .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }
    .stat-card { border: 1px solid #f0f0f0; border-radius: 12px; padding: 24px; }
    .stat-card h3 { font-size: 0.82rem; font-weight: 600; color: #9CA3AF; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 16px; }
    .bar-chart { display: flex; flex-direction: column; gap: 10px; }
    .bar-row { display: flex; align-items: center; gap: 12px; }
    .bar-label { font-size: 0.78rem; font-weight: 500; width: 90px; flex-shrink: 0; text-align: right; }
    .bar-track { flex: 1; height: 24px; background: #f9fafb; border-radius: 4px; overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 4px; display: flex; align-items: center; padding-left: 8px; font-size: 0.68rem; font-weight: 600; color: white; font-family: 'JetBrains Mono', monospace; min-width: 20px; }
    .bar-fill.primary { background: #F97B6D; }
    .bar-fill.muted { background: #FDB5AD; }
    .bar-fill.light { background: #FDD8D4; color: #9CA3AF; }
    .related-section { padding: 0 0 40px; border-bottom: 1px solid #f0f0f0; margin-bottom: 40px; }
    .related-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
    .related-card { padding: 16px 20px; border: 1px solid #f0f0f0; border-radius: 8px; text-decoration: none; transition: border-color 0.15s; display: block; }
    .related-card:hover { border-color: #F97B6D; }
    .related-card .name { font-size: 0.85rem; font-weight: 600; margin-bottom: 4px; }
    .related-card .count { font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; color: #9CA3AF; }
    .explore-section { padding-bottom: 64px; }
    .explore-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
    .explore-count { font-size: 0.72rem; color: #9CA3AF; font-family: 'JetBrains Mono', monospace; }
    .btn-outline { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border: 1px solid #f0f0f0; border-radius: 6px; font-size: 0.78rem; font-weight: 600; text-decoration: none; background: white; transition: border-color 0.15s; }
    .btn-outline:hover { border-color: #F97B6D; }
    table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
    thead th { text-align: left; padding: 10px 12px; font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: #9CA3AF; border-bottom: 1px solid #f0f0f0; }
    tbody td { padding: 12px; border-bottom: 1px solid #fafafa; vertical-align: middle; }
    tbody tr:hover { background: #fafafa; }
    .url-cell { font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; color: #6B7280; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.68rem; font-weight: 600; }
    .badge-type { background: #FEF0EE; color: #F97B6D; }
    .badge-topic { background: #EEF2FF; color: #6366F1; }
    .badge-lang { background: #F0FDF4; color: #16A34A; }
    .badge-conf { background: #fef8f7; color: #F97B6D; font-family: 'JetBrains Mono', monospace; }
    .view-all-row { text-align: center; padding: 20px 0; }
    .view-all-row a { color: #F97B6D; text-decoration: none; font-weight: 600; font-size: 0.85rem; }
    .view-all-row a:hover { text-decoration: underline; }
    .cta-section { padding: 40px 0; border-bottom: 1px solid #f0f0f0; }
    .cta-box { background: #fef8f7; border: 1px solid #fdd8d4; border-radius: 12px; padding: 32px; display: flex; align-items: center; justify-content: space-between; }
    .cta-text h3 { font-size: 1.1rem; font-weight: 700; margin-bottom: 6px; }
    .cta-text p { font-size: 0.85rem; color: #6B7280; }
    .btn-primary { display: inline-flex; align-items: center; gap: 6px; padding: 10px 20px; background: #F97B6D; color: white; border: none; border-radius: 6px; font-size: 0.82rem; font-weight: 600; text-decoration: none; transition: background 0.15s; }
    .btn-primary:hover { background: #e8685a; }
    .site-footer { border-top: 1px solid #f0f0f0; padding: 24px 48px; margin-top: 0; display: flex; align-items: center; justify-content: space-between; font-size: 0.78rem; color: #9CA3AF; max-width: 1200px; margin: 0 auto; }
    .site-footer a { color: #9CA3AF; text-decoration: none; }
    .site-footer a:hover { text-decoration: underline; }
    @media (max-width: 768px) {
      header, .container { padding-left: 24px; padding-right: 24px; }
      .hero h1 { font-size: 1.8rem; }
      .numbers { gap: 24px; flex-wrap: wrap; }
      .stats-grid { grid-template-columns: 1fr; }
      .cta-box { flex-direction: column; gap: 16px; text-align: center; }
    }`;
}

function sharedHead(title: string, description: string, canonicalPath: string, kind: string, id: string): string {
  const url = `${SITE}${canonicalPath}`;
  return `
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${url}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="${SITE}/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${SITE}/og-image.png">
  <link rel="icon" type="image/x-icon" href="/public/favicon.ico">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>${sharedStyles()}</style>`;
}

function sharedHeader(activeKind: "type" | "topic"): string {
  return `
  <header>
    <div class="brand"><a href="/"><span class="accent">docx</span>-corpus</a></div>
    <nav class="links">
      <a href="/#explore">Explore</a>
      <a href="/types"${activeKind === "type" ? ' class="active"' : ""}>Types</a>
      <a href="/topics"${activeKind === "topic" ? ' class="active"' : ""}>Topics</a>
      <a href="https://github.com/superdoc-dev/docx-corpus" target="_blank">GitHub</a>
      <a href="https://huggingface.co/datasets/superdoc/docx-corpus" target="_blank">HuggingFace</a>
    </nav>
  </header>`;
}

function sharedFooter(): string {
  return `
  <div class="site-footer">
    <span>Built by <a href="https://superdoc.dev/?utm_source=docxcorp.us&utm_medium=referral&utm_campaign=footer">SuperDoc</a></span>
    <span>Takedown requests: <a href="mailto:help@docxcorp.us">help@docxcorp.us</a></span>
  </div>`;
}

// ---------------------------------------------------------------------------
// Template: bar chart component
// ---------------------------------------------------------------------------

function renderBarChart(title: string, items: { label: string; count: number }[]): string {
  if (items.length === 0) return "";
  const max = items[0].count;
  const rows = items.map((item, i) => `
      <div class="bar-row">
        <div class="bar-label">${esc(item.label)}</div>
        <div class="bar-track">
          <div class="${barClass(i)}" style="width: ${barWidth(item.count, max)}%">${fmt(item.count)}</div>
        </div>
      </div>`).join("");

  return `
    <div class="stat-card">
      <h3>${esc(title)}</h3>
      <div class="bar-chart">${rows}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Template: documents table component
// ---------------------------------------------------------------------------

function renderDocTable(docs: DocRow[], total: number, kind: string, id: string, label: string): string {
  const filterParam = kind === "type" ? `type=${id}` : `topic=${id}`;
  const rows = docs.map((d) => {
    const displayName = d.filename || `${d.id.slice(0, 12)}...docx`;
    const conf = d.classification_confidence != null
      ? `${(d.classification_confidence * 100).toFixed(1)}%`
      : "—";
    const topicLabel = TOPIC_META[d.document_topic]?.label || d.document_topic || "—";
    const typeLabel = TYPE_META[d.document_type]?.label || d.document_type || "—";
    const langName = d.language ? (LANG_NAMES[d.language] || d.language) : "—";

    return `
        <tr>
          <td class="url-cell" title="${esc(displayName)}">${esc(displayName)}</td>
          ${kind === "type"
            ? `<td><span class="badge badge-topic">${esc(topicLabel)}</span></td>`
            : `<td><span class="badge badge-type">${esc(typeLabel)}</span></td>`}
          <td><span class="badge badge-lang">${esc(d.language || "?")}</span> ${esc(langName)}</td>
          <td><span class="badge badge-conf">${conf}</span></td>
          <td>${d.word_count != null ? fmt(d.word_count) : "—"}</td>
        </tr>`;
  }).join("");

  const crossHeader = kind === "type" ? "Topic" : "Type";

  return `
    <section class="explore-section">
      <div class="section-label">Sample Documents</div>
      <div class="explore-header">
        <span class="explore-count">Showing ${docs.length} of ${fmt(total)} ${esc(label.toLowerCase())} documents</span>
        <a href="/?${filterParam}" class="btn-outline">View all in Explorer &rarr;</a>
      </div>
      <table>
        <thead>
          <tr>
            <th>Filename</th>
            <th>${crossHeader}</th>
            <th>Language</th>
            <th>Confidence</th>
            <th>Words</th>
          </tr>
        </thead>
        <tbody>${rows}
        </tbody>
      </table>
      <div class="view-all-row">
        <a href="/?${filterParam}">View all ${fmt(total)} documents &rarr;</a>
      </div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Template: siblings grid component
// ---------------------------------------------------------------------------

function renderSiblings(
  title: string,
  items: FacetRow[],
  currentId: string,
  kind: "type" | "topic",
  meta: Record<string, { label: string }>,
): string {
  const others = items.filter((item) => item.id !== currentId);
  if (others.length === 0) return "";

  const cards = others.map((item) => {
    const label = meta[item.id]?.label || item.id;
    const urlKind = kind === "type" ? "types" : "topics";
    return `
      <a href="/${urlKind}/${item.id}" class="related-card">
        <div class="name">${esc(label)}</div>
        <div class="count">${fmt(item.count)}</div>
      </a>`;
  }).join("");

  return `
    <section class="related-section">
      <div class="section-label">${esc(title)}</div>
      <div class="related-grid">${cards}
      </div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Template: full page
// ---------------------------------------------------------------------------

function renderPage(data: PageData): string {
  const {
    kind, id, label, description, total, langCount, avgConfidence,
    languages, crossDimension, crossMeta, crossKind, siblings, documents,
  } = data;

  const kindLabel = kind === "type" ? "Document Type" : "Document Topic";
  const kindPlural = kind === "type" ? "Types" : "Topics";
  const urlPrefix = kind === "type" ? "types" : "topics";
  const crossLabel = crossKind === "topic" ? "Top Topics" : "Top Types";
  const siblingTitle = `Other ${kindPlural}`;
  const filterParam = kind === "type" ? `type=${id}` : `topic=${id}`;

  const title = `${label} Word Documents — docx-corpus`;
  const metaDesc = `${fmt(total)}+ ${label.toLowerCase()} .docx files across ${langCount} languages. Open dataset for NLP and document processing research. Download from docx-corpus.`;

  const langItems = languages.map((l) => ({
    label: LANG_NAMES[l.code] || l.code,
    count: l.count,
  }));

  const crossItems = crossDimension.map((c) => ({
    label: crossMeta[c.id]?.label || c.id,
    count: c.count,
  }));

  return `<!DOCTYPE html>
<html lang="en">
<head>${sharedHead(title, metaDesc, `/${urlPrefix}/${id}`, kind, id)}
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Dataset",
    "name": "docx-corpus — ${esc(label)} Documents",
    "description": "${esc(metaDesc)}",
    "url": "${SITE}/${urlPrefix}/${id}",
    "isPartOf": { "@type": "Dataset", "name": "docx-corpus", "url": "${SITE}" },
    "license": "https://github.com/superdoc-dev/docx-corpus/blob/main/LICENSE",
    "creator": { "@type": "Organization", "name": "SuperDoc", "url": "https://superdoc.dev" },
    "keywords": ["docx", "${label.toLowerCase()}", "word documents", "dataset", "NLP", "document processing"]
  }
  </script>
</head>
<body>
  ${sharedHeader(kind)}
  <div class="container">
    <div class="breadcrumb">
      <a href="/">Home</a><span class="sep">/</span>
      <a href="/${urlPrefix}">${kindPlural}</a><span class="sep">/</span>
      ${esc(label)}
    </div>
    <section class="hero">
      <div class="hero-kicker">${esc(kindLabel)}</div>
      <h1>${esc(label)} Documents</h1>
      <p class="hero-description">
        A collection of ${fmt(total)}+ ${label.toLowerCase()} Word documents from the public web.
        ${esc(description)}
      </p>
      <p class="hero-by">Built by 🦋 <a href="https://superdoc.dev/?utm_source=docxcorp.us&utm_medium=referral&utm_campaign=hero">SuperDoc</a></p>
      <div class="numbers">
        <div><div class="num-val">${fmt(total)}</div><div class="num-label">documents</div></div>
        <div><div class="num-val">${langCount}</div><div class="num-label">languages</div></div>
        <div><div class="num-val">${avgConfidence}%</div><div class="num-label">avg confidence</div></div>
      </div>
    </section>
    <section class="stats-section">
      <div class="section-label">Distribution</div>
      <div class="stats-grid">
        ${renderBarChart("Top Languages", langItems)}
        ${renderBarChart(crossLabel, crossItems)}
      </div>
    </section>
    ${renderSiblings(siblingTitle, siblings, id, kind, kind === "type" ? TYPE_META : TOPIC_META)}
    ${renderDocTable(documents, total, kind, id, label)}
    <section class="cta-section">
      <div class="cta-box">
        <div class="cta-text">
          <h3>Download this subset</h3>
          <p>Get a manifest of all ${fmt(total)} ${label.toLowerCase()} documents for wget or curl.</p>
        </div>
        <a href="/?${filterParam}#download" class="btn-primary">Generate Manifest &darr;</a>
      </div>
    </section>
  </div>
  ${sharedFooter()}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Template: index page (lists all types or all topics)
// ---------------------------------------------------------------------------

function renderIndexPage(
  kind: "type" | "topic",
  items: FacetRow[],
  meta: Record<string, { label: string; desc: string }>,
): string {
  const kindPlural = kind === "type" ? "Types" : "Topics";
  const urlPrefix = kind === "type" ? "types" : "topics";
  const title = `Document ${kindPlural} — docx-corpus`;
  const description = `Browse all ${items.length} document ${kindPlural.toLowerCase()} in the docx-corpus dataset. ${fmt(items.reduce((s, i) => s + i.count, 0))}+ classified Word documents.`;

  const cards = items.map((item) => {
    const m = meta[item.id] || { label: item.id, desc: "" };
    return `
      <a href="/${urlPrefix}/${item.id}" class="index-card">
        <div class="index-card-label">${esc(m.label)}</div>
        <div class="index-card-count">${fmt(item.count)} documents</div>
        <div class="index-card-desc">${esc(m.desc)}</div>
      </a>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>${sharedHead(title, description, `/${urlPrefix}`, kind, "")}
  <style>
    .index-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; padding-bottom: 64px; }
    .index-card { padding: 24px; border: 1px solid #f0f0f0; border-radius: 12px; text-decoration: none; transition: border-color 0.15s; display: block; }
    .index-card:hover { border-color: #F97B6D; }
    .index-card-label { font-size: 1.1rem; font-weight: 700; margin-bottom: 4px; }
    .index-card-count { font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; color: #F97B6D; margin-bottom: 8px; }
    .index-card-desc { font-size: 0.82rem; color: #6B7280; line-height: 1.5; }
  </style>
</head>
<body>
  ${sharedHeader(kind)}
  <div class="container">
    <div class="breadcrumb">
      <a href="/">Home</a><span class="sep">/</span>
      ${kindPlural}
    </div>
    <section class="hero">
      <div class="hero-kicker">Browse by ${kind === "type" ? "document type" : "topic"}</div>
      <h1>Document ${kindPlural}</h1>
      <p class="hero-description">
        The docx-corpus dataset classifies documents into ${items.length} ${kindPlural.toLowerCase()}.
        Click on any ${kind} to explore its documents, language distribution, and download options.
      </p>
      <p class="hero-by">Built by 🦋 <a href="https://superdoc.dev/?utm_source=docxcorp.us&utm_medium=referral&utm_campaign=hero">SuperDoc</a></p>
    </section>
    <div class="index-grid">${cards}
    </div>
  </div>
  ${sharedFooter()}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------

function renderSitemap(types: FacetRow[], topics: FacetRow[]): string {
  const urls = [
    { loc: "/", priority: "1.0" },
    { loc: "/types", priority: "0.8" },
    { loc: "/topics", priority: "0.8" },
    ...types.map((t) => ({ loc: `/types/${t.id}`, priority: "0.7" })),
    ...topics.map((t) => ({ loc: `/topics/${t.id}`, priority: "0.7" })),
  ];

  const entries = urls.map((u) => `  <url>
    <loc>${SITE}${u.loc}</loc>
    <changefreq>weekly</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("Fetching data...");
  const { types, topics } = await queryAllFacets();

  // Generate type pages
  console.log(`Generating ${types.length} type pages...`);
  for (const type of types) {
    const stats = await queryTypeStats(type.id);
    const meta = TYPE_META[type.id] || { label: type.id, desc: "" };
    const html = renderPage({
      kind: "type",
      id: type.id,
      label: meta.label,
      description: meta.desc,
      total: stats.total,
      langCount: stats.langCount,
      avgConfidence: stats.avgConfidence,
      languages: stats.languages,
      crossDimension: stats.topics,
      crossMeta: TOPIC_META,
      crossKind: "topic",
      siblings: types,
      documents: stats.documents,
    });
    await Bun.write(`${OUT_DIR}types/${type.id}.html`, html);
    console.log(`  types/${type.id}.html (${fmt(stats.total)} docs)`);
  }

  // Generate topic pages
  console.log(`Generating ${topics.length} topic pages...`);
  for (const topic of topics) {
    const stats = await queryTopicStats(topic.id);
    const meta = TOPIC_META[topic.id] || { label: topic.id, desc: "" };
    const html = renderPage({
      kind: "topic",
      id: topic.id,
      label: meta.label,
      description: meta.desc,
      total: stats.total,
      langCount: stats.langCount,
      avgConfidence: stats.avgConfidence,
      languages: stats.languages,
      crossDimension: stats.types,
      crossMeta: TYPE_META,
      crossKind: "type",
      siblings: topics,
      documents: stats.documents,
    });
    await Bun.write(`${OUT_DIR}topics/${topic.id}.html`, html);
    console.log(`  topics/${topic.id}.html (${fmt(stats.total)} docs)`);
  }

  // Generate index pages
  console.log("Generating index pages...");
  await Bun.write(`${OUT_DIR}types/index.html`, renderIndexPage("type", types, TYPE_META));
  await Bun.write(`${OUT_DIR}topics/index.html`, renderIndexPage("topic", topics, TOPIC_META));
  console.log("  types/index.html");
  console.log("  topics/index.html");

  // Generate sitemap
  const sitemap = renderSitemap(types, topics);
  await Bun.write(`${OUT_DIR}sitemap.xml`, sitemap);
  console.log("  sitemap.xml");

  await sql.close();
  console.log("Done!");
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
