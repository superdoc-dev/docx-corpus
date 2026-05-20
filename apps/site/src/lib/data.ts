import { neon } from '@neondatabase/serverless';

const DATABASE_URL = import.meta.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required at build time');
}

const sql = neon(DATABASE_URL);

export interface TypeFacet { id: string; label: string; count: number; }
export interface TopicFacet { id: string; label: string; count: number; }
export interface LanguageFacet { code: string; name: string; count: number; }

export const TYPE_LABELS: Record<string, string> = {
  legal: 'Legal',
  forms: 'Forms',
  reports: 'Reports',
  policies: 'Policies',
  educational: 'Educational',
  correspondence: 'Correspondence',
  technical: 'Technical',
  administrative: 'Administrative',
  creative: 'Creative',
  reference: 'Reference',
};

export const TOPIC_LABELS: Record<string, string> = {
  government: 'Government',
  education: 'Education',
  healthcare: 'Healthcare',
  finance: 'Finance',
  legal_judicial: 'Legal / Judicial',
  technology: 'Technology',
  environment: 'Environment',
  nonprofit: 'Nonprofit',
  general: 'General',
};

export async function getCorpusStats() {
  const [{ total }] = await sql`SELECT COUNT(*)::int AS total FROM documents WHERE document_type IS NOT NULL`;
  const [{ langs }] = await sql`SELECT COUNT(DISTINCT language)::int AS langs FROM documents WHERE document_type IS NOT NULL AND language IS NOT NULL`;
  return { totalClassified: total as number, languageCount: langs as number };
}

export async function getTypeFacets(): Promise<TypeFacet[]> {
  const rows = await sql`
    SELECT document_type AS id, COUNT(*)::int AS count
    FROM documents
    WHERE document_type IS NOT NULL
    GROUP BY document_type
    ORDER BY count DESC
  ` as { id: string; count: number }[];
  return rows.map(r => ({ id: r.id, label: TYPE_LABELS[r.id] ?? r.id, count: r.count }));
}

export async function getTopicFacets(): Promise<TopicFacet[]> {
  const rows = await sql`
    SELECT document_topic AS id, COUNT(*)::int AS count
    FROM documents
    WHERE document_topic IS NOT NULL
    GROUP BY document_topic
    ORDER BY count DESC
  ` as { id: string; count: number }[];
  return rows.map(r => ({ id: r.id, label: TOPIC_LABELS[r.id] ?? r.id, count: r.count }));
}

export async function getTopLanguages(limit = 20): Promise<LanguageFacet[]> {
  const rows = await sql`
    SELECT language AS code, COUNT(*)::int AS count
    FROM documents
    WHERE document_type IS NOT NULL AND language IS NOT NULL
    GROUP BY language
    ORDER BY count DESC
    LIMIT ${limit}
  ` as { code: string; count: number }[];
  return rows.map(r => ({ code: r.code, name: r.code, count: r.count }));
}

// Sample documents for a single type/topic facet. Ordered by confidence
// DESC so the most confidently labeled rows surface first.
export interface SampleDocument {
  id: string;
  filename: string | null;
  type: string;
  topic: string;
  language: string | null;
  confidence: number;
}

export async function getSamplesByType(typeId: string, limit = 5): Promise<SampleDocument[]> {
  return await sql`
    SELECT id, original_filename AS filename, document_type AS type,
           document_topic AS topic, language, classification_confidence AS confidence
    FROM documents
    WHERE document_type = ${typeId} AND document_topic IS NOT NULL
    ORDER BY classification_confidence DESC NULLS LAST
    LIMIT ${limit}
  ` as SampleDocument[];
}

export async function getSamplesByTopic(topicId: string, limit = 5): Promise<SampleDocument[]> {
  return await sql`
    SELECT id, original_filename AS filename, document_type AS type,
           document_topic AS topic, language, classification_confidence AS confidence
    FROM documents
    WHERE document_topic = ${topicId} AND document_type IS NOT NULL
    ORDER BY classification_confidence DESC NULLS LAST
    LIMIT ${limit}
  ` as SampleDocument[];
}

// Topic breakdown within a single type (and vice versa).
export async function getTopicsForType(typeId: string): Promise<TopicFacet[]> {
  const rows = await sql`
    SELECT document_topic AS id, COUNT(*)::int AS count
    FROM documents
    WHERE document_type = ${typeId} AND document_topic IS NOT NULL
    GROUP BY document_topic
    ORDER BY count DESC
  ` as { id: string; count: number }[];
  return rows.map(r => ({ id: r.id, label: TOPIC_LABELS[r.id] ?? r.id, count: r.count }));
}

export async function getTypesForTopic(topicId: string): Promise<TypeFacet[]> {
  const rows = await sql`
    SELECT document_type AS id, COUNT(*)::int AS count
    FROM documents
    WHERE document_topic = ${topicId} AND document_type IS NOT NULL
    GROUP BY document_type
    ORDER BY count DESC
  ` as { id: string; count: number }[];
  return rows.map(r => ({ id: r.id, label: TYPE_LABELS[r.id] ?? r.id, count: r.count }));
}

// Per-facet language breakdown with API-style percentages (denominator =
// sum of the top-N languages for the facet, matching what the API returns
// in /documents.facets.languages). The caller can show the denominator.
export interface FacetLanguage { code: string; count: number; percentage: number; }
export interface FacetLanguageResult { languages: FacetLanguage[]; denominator: number; distinct: number; }

async function getLanguagesForFacet(
  column: 'document_type' | 'document_topic',
  value: string,
  limit = 20,
): Promise<FacetLanguageResult> {
  // Top-N for display
  const rowsQuery = column === 'document_type'
    ? sql`
        SELECT language AS code, COUNT(*)::int AS count
        FROM documents
        WHERE document_type = ${value} AND language IS NOT NULL
        GROUP BY language
        ORDER BY count DESC
        LIMIT ${limit}
      `
    : sql`
        SELECT language AS code, COUNT(*)::int AS count
        FROM documents
        WHERE document_topic = ${value} AND language IS NOT NULL
        GROUP BY language
        ORDER BY count DESC
        LIMIT ${limit}
      `;
  const distinctQuery = column === 'document_type'
    ? sql`SELECT COUNT(DISTINCT language)::int AS n FROM documents WHERE document_type = ${value} AND language IS NOT NULL`
    : sql`SELECT COUNT(DISTINCT language)::int AS n FROM documents WHERE document_topic = ${value} AND language IS NOT NULL`;

  const [rows, distinctRow] = await Promise.all([rowsQuery, distinctQuery]);
  const top = rows as { code: string; count: number }[];
  const denominator = top.reduce((s, r) => s + r.count, 0);
  const languages = top.map(r => ({
    code: r.code,
    count: r.count,
    percentage: Math.round((1000 * r.count) / denominator) / 10,
  }));
  return { languages, denominator, distinct: (distinctRow as { n: number }[])[0].n };
}

export async function getLanguagesForType(typeId: string, limit = 20): Promise<FacetLanguageResult> {
  return getLanguagesForFacet('document_type', typeId, limit);
}
export async function getLanguagesForTopic(topicId: string, limit = 20): Promise<FacetLanguageResult> {
  return getLanguagesForFacet('document_topic', topicId, limit);
}

// Confidence histogram: 8 ranges from below-0.3 to 0.9-1.0.
// Counts are computed against the full classified set.
export interface HistogramBin { range: string; count: number; pct: number; }

export async function getConfidenceHistogram(): Promise<HistogramBin[]> {
  const rows = await sql`
    SELECT
      CASE
        WHEN classification_confidence >= 0.9 THEN '0.9-1.0'
        WHEN classification_confidence >= 0.8 THEN '0.8-0.9'
        WHEN classification_confidence >= 0.7 THEN '0.7-0.8'
        WHEN classification_confidence >= 0.6 THEN '0.6-0.7'
        WHEN classification_confidence >= 0.5 THEN '0.5-0.6'
        WHEN classification_confidence >= 0.4 THEN '0.4-0.5'
        WHEN classification_confidence >= 0.3 THEN '0.3-0.4'
        ELSE 'below 0.3'
      END AS bucket,
      COUNT(*)::int AS count
    FROM documents
    WHERE document_type IS NOT NULL AND classification_confidence IS NOT NULL
    GROUP BY bucket
  ` as { bucket: string; count: number }[];

  // Order high to low for display
  const order = ['0.9-1.0', '0.8-0.9', '0.7-0.8', '0.6-0.7', '0.5-0.6', '0.4-0.5', '0.3-0.4', 'below 0.3'];
  const byBucket = Object.fromEntries(rows.map(r => [r.bucket, r.count]));
  const total = rows.reduce((s, r) => s + r.count, 0);
  return order
    .filter(b => byBucket[b] !== undefined)
    .map(b => ({
      range: b,
      count: byBucket[b],
      pct: Math.round((1000 * byBucket[b]) / total) / 10,
    }));
}
