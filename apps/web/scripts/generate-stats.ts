#!/usr/bin/env bun
/**
 * Generate static stats.json for the docxcorp.us landing page.
 *
 * Queries Neon Postgres for aggregate counts, type/topic distributions,
 * language breakdown, and a sample of documents. Output is written to
 * apps/web/data/stats.json and deployed alongside the HTML.
 *
 * Usage:
 *   bun run apps/web/scripts/generate-stats.ts
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

// ---------- queries ----------

async function heroStats() {
  const [row] = await sql<{
    total: number;
    languages: number;
    avg_confidence: number;
    classified: number;
  }[]>`
    SELECT
      COUNT(*)::int                                                         AS total,
      COUNT(DISTINCT language) FILTER (WHERE language IS NOT NULL)::int     AS languages,
      ROUND(AVG(classification_confidence)::numeric, 2)::float             AS avg_confidence,
      COUNT(*) FILTER (WHERE document_type IS NOT NULL)::int               AS classified
    FROM documents
    WHERE status = 'uploaded'
  `;
  return row;
}

async function typeDistribution() {
  return sql<{ id: string; count: number }[]>`
    SELECT document_type AS id, COUNT(*)::int AS count
    FROM documents
    WHERE document_type IS NOT NULL
    GROUP BY document_type
    ORDER BY count DESC
  `;
}

async function topicDistribution() {
  return sql<{ id: string; count: number }[]>`
    SELECT document_topic AS id, COUNT(*)::int AS count
    FROM documents
    WHERE document_topic IS NOT NULL
    GROUP BY document_topic
    ORDER BY count DESC
  `;
}

async function languageDistribution() {
  return sql<{ code: string; count: number }[]>`
    SELECT
      COALESCE(NULLIF(language, 'unknown'), 'unknown') AS code,
      SUM(cnt)::int AS count
    FROM (
      SELECT COALESCE(language, 'unknown') AS language, COUNT(*) AS cnt
      FROM documents
      WHERE status = 'uploaded'
      GROUP BY language
    ) sub
    GROUP BY COALESCE(NULLIF(language, 'unknown'), 'unknown')
    ORDER BY count DESC
    LIMIT 20
  `;
}

async function sampleDocuments() {
  return sql<{
    id: string;
    filename: string | null;
    document_type: string;
    document_topic: string;
    language: string;
    word_count: number | null;
    classification_confidence: number;
  }[]>`
    SELECT
      id,
      original_filename AS filename,
      document_type,
      document_topic,
      language,
      word_count,
      classification_confidence
    FROM documents
    WHERE document_type IS NOT NULL
      AND classification_confidence IS NOT NULL
    ORDER BY RANDOM()
    LIMIT 25
  `;
}

// ---------- type labels ----------

const TYPE_LABELS: Record<string, string> = {
  legal: "Legal",
  forms: "Forms",
  reports: "Reports",
  policies: "Policies",
  educational: "Educational",
  correspondence: "Correspondence",
  technical: "Technical",
  administrative: "Administrative",
  creative: "Creative",
  reference: "Reference",
  general: "General",
};

const TOPIC_LABELS: Record<string, string> = {
  government: "Government",
  education: "Education",
  healthcare: "Healthcare",
  finance: "Finance",
  legal_judicial: "Legal / Judicial",
  technology: "Technology",
  environment: "Environment",
  nonprofit: "Nonprofit",
  general: "General",
};

const LANG_NAMES: Record<string, string> = {
  en: "English",
  ru: "Russian",
  cs: "Czech",
  pl: "Polish",
  es: "Spanish",
  zh: "Chinese",
  lt: "Lithuanian",
  sk: "Slovak",
  de: "German",
  id: "Indonesian",
  fr: "French",
  pt: "Portuguese",
  ar: "Arabic",
  ja: "Japanese",
  ko: "Korean",
  it: "Italian",
  sv: "Swedish",
  nl: "Dutch",
  bg: "Bulgarian",
  tr: "Turkish",
  vi: "Vietnamese",
  th: "Thai",
  uk: "Ukrainian",
  ro: "Romanian",
  hu: "Hungarian",
  hr: "Croatian",
  fi: "Finnish",
  da: "Danish",
  nb: "Norwegian",
  el: "Greek",
  he: "Hebrew",
  hi: "Hindi",
  unknown: "Unknown",
};

// ---------- main ----------

async function main() {
  console.log("Querying database...");

  const [hero, types, topics, languages, samples] = await Promise.all([
    heroStats(),
    typeDistribution(),
    topicDistribution(),
    languageDistribution(),
    sampleDocuments(),
  ]);

  const totalClassified = types.reduce((sum, t) => sum + t.count, 0);

  const stats = {
    generated_at: new Date().toISOString(),
    hero: {
      total_documents: hero.total,
      languages: hero.languages,
      types: types.length,
      topics: topics.length,
      avg_confidence: hero.avg_confidence,
    },
    types: types.map((t) => ({
      id: t.id,
      label: TYPE_LABELS[t.id] || t.id,
      count: t.count,
      percentage: Math.round((1000 * t.count) / totalClassified) / 10,
    })),
    topics: topics.map((t) => ({
      id: t.id,
      label: TOPIC_LABELS[t.id] || t.id,
      count: t.count,
      percentage: Math.round((1000 * t.count) / totalClassified) / 10,
    })),
    languages: languages.map((l) => ({
      code: l.code,
      name: LANG_NAMES[l.code] || l.code,
      count: l.count,
      percentage: Math.round((1000 * l.count) / hero.total) / 10,
    })),
    sample_documents: samples.map((d) => ({
      id: d.id,
      filename: d.filename,
      type: d.document_type,
      topic: d.document_topic,
      language: d.language,
      word_count: d.word_count,
      confidence: d.classification_confidence,
    })),
  };

  const outPath = new URL("../data/stats.json", import.meta.url).pathname;
  await Bun.write(outPath, JSON.stringify(stats, null, 2));

  console.log(`Written to ${outPath}`);
  console.log(`  Documents: ${stats.hero.total_documents.toLocaleString()}`);
  console.log(`  Languages: ${stats.hero.languages}`);
  console.log(`  Types: ${stats.types.length} (${totalClassified.toLocaleString()} classified)`);
  console.log(`  Topics: ${stats.topics.length}`);
  console.log(`  Avg confidence: ${stats.hero.avg_confidence}`);
  console.log(`  Sample docs: ${stats.sample_documents.length}`);

  await sql.close();
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
