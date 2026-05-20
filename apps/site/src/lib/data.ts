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

// Per-facet descriptive copy. `description` is what's in this slice;
// `useCases` is what researchers do with it. Both feed the "What's in this slice"
// section on /types/[type] and /topics/[topic] - matters for SEO entity coverage
// and for user trust before download.
export interface FacetCopy { description: string; useCases: string; }

export const TYPE_COPY: Record<string, FacetCopy> = {
  legal: {
    description: 'Documents classified as legal in nature. Examples include statutes and regulations, court filings, terms of service, privacy policies, employment agreements, NDAs, licensing terms, regulatory filings, and standard contracts.',
    useCases: 'Useful for: contract classification benchmarks, named-entity recognition on legal text, multilingual legal NLP, retrieval-augmented generation over legal corpora, OOXML parsing of complex tabular and styled legal documents.',
  },
  forms: {
    description: 'Documents classified as forms or other structured data-collection artifacts. Examples include fillable forms, applications, registrations, surveys, ballots, and questionnaires.',
    useCases: 'Useful for: form-field extraction, structured-document parsing, intake automation training data, multilingual form understanding, accessibility audits of public forms.',
  },
  reports: {
    description: 'Documents classified as long-form reports presenting findings or analysis. Examples include annual reports, research papers, case studies, white papers, assessments, and evaluations.',
    useCases: 'Useful for: long-document summarization, citation extraction, financial-statement parsing, tabular-data benchmarks, retrieval-augmented Q&A over reports.',
  },
  policies: {
    description: 'Documents classified as establishing rules, procedures, or codes of conduct. Examples include privacy policies, employee handbooks, standard operating procedures, codes of conduct, and regulatory guidelines.',
    useCases: 'Useful for: policy classification, compliance NLP, change-detection between policy versions, multilingual policy retrieval, terms-of-service analysis.',
  },
  educational: {
    description: 'Documents classified as teaching or learning materials. Examples include syllabi, lesson plans, course outlines, study guides, worksheets, theses, and dissertations.',
    useCases: 'Useful for: education-domain NLP, curriculum classification, learning-objective extraction, multilingual academic text analysis.',
  },
  correspondence: {
    description: 'Documents classified as correspondence or announcements. Examples include letters, memos, press releases, notices, and newsletters.',
    useCases: 'Useful for: stylometric analysis, correspondence classification, named-entity recognition on organizational text, automated reply generation training.',
  },
  technical: {
    description: 'Documents classified as technical reference material. Examples include specifications, manuals, API documentation, standards, user guides, and datasheets.',
    useCases: 'Useful for: technical-documentation summarization, glossary extraction, specification parsing, retrieval over engineering corpora.',
  },
  administrative: {
    description: 'Documents classified as administrative or coordination artifacts. Examples include meeting minutes, agendas, attendance records, and other internal organizational documents.',
    useCases: 'Useful for: meeting-minutes summarization, attendance and decision tracking, civic-tech applications, audit-trail analysis.',
  },
  creative: {
    description: 'Brochures, marketing materials, proposals, presentation scripts, pitch decks, and other creative or persuasive documents.',
    useCases: 'Useful for: marketing-content analysis, brochure classification, style-transfer experiments, sentiment in promotional text.',
  },
  reference: {
    description: 'Product catalogs, directories, glossaries, FAQs, indexes, and other reference or lookup material.',
    useCases: 'Useful for: catalog-data extraction, glossary-building, FAQ retrieval, structured-lookup benchmarks.',
  },
};

export const TOPIC_COPY: Record<string, FacetCopy> = {
  government: {
    description: 'Documents classified as government in topic. Examples include public administration records, regulatory filings, agency policies and procedures, RFPs and tenders, meeting minutes and agendas, official forms and applications, public reports, civic notices, and judicial documents.',
    useCases: 'Useful for: civic-tech and govtech applications, public policy NLP, multilingual government text classification, retrieval over public records, document structure benchmarking on real-world forms and policy templates.',
  },
  education: {
    description: 'Documents classified as education in topic. Examples include course materials, syllabi, academic policies, research papers, and academic administrative documents.',
    useCases: 'Useful for: education-domain NLP, academic text analysis, multilingual curriculum data, retrieval over teaching materials.',
  },
  healthcare: {
    description: 'Documents classified as healthcare in topic. Examples include patient-information materials, clinical protocols, public health bulletins, and healthcare administrative documents.',
    useCases: 'Useful for: clinical-document NLP, patient-information accessibility, public-health text classification, multilingual healthcare communication analysis.',
  },
  finance: {
    description: 'Documents classified as finance in topic. Examples include annual reports, financial regulations, investor disclosures, insurance terms, and finance administrative documents.',
    useCases: 'Useful for: financial-document NLP, regulation classification, table-heavy parsing, multilingual financial communication analysis.',
  },
  legal_judicial: {
    description: 'Documents classified as legal or judicial in topic. Examples include court filings, judgments, legal opinions, judicial administrative documents, and law-firm publications.',
    useCases: 'Useful for: judicial NLP, case-law retrieval, court-filing classification, multilingual legal analysis.',
  },
  technology: {
    description: 'Documents classified as technology in topic. Examples include product documentation, API references, technology white papers, and technology administrative documents.',
    useCases: 'Useful for: technology-domain NLP, product-documentation analysis, technical-text classification.',
  },
  environment: {
    description: 'Documents classified as environment in topic. Examples include environmental impact assessments, sustainability reports, conservation policies, and environmental administrative documents.',
    useCases: 'Useful for: environmental-domain NLP, sustainability-report analysis, multilingual environmental policy retrieval.',
  },
  nonprofit: {
    description: 'Documents classified as nonprofit in topic. Examples include mission statements, annual reports, grant applications, board minutes, and nonprofit administrative documents.',
    useCases: 'Useful for: nonprofit-sector NLP, mission and impact analysis, grant-application classification.',
  },
  general: {
    description: 'Documents that did not fit cleanly into one of the other eight topics. Includes general-interest publications, multi-domain content, and organizational documents without a single dominant subject.',
    useCases: 'Useful for: general-purpose text classification, cross-sector retrieval, fall-back analysis when domain is unknown.',
  },
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
