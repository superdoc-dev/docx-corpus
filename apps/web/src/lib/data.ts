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
