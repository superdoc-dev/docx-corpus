import { neon } from "@neondatabase/serverless";

interface Env {
  DATABASE_URL: string;
  CORS_ORIGIN: string;
}

interface DocumentRow {
  id: string;
  filename: string | null;
  document_type: string;
  document_topic: string;
  language: string | null;
  word_count: number | null;
  classification_confidence: number | null;
}

const TYPE_LABELS: Record<string, string> = {
  legal: "Legal", forms: "Forms", reports: "Reports", policies: "Policies",
  educational: "Educational", correspondence: "Correspondence", technical: "Technical",
  administrative: "Administrative", creative: "Creative", reference: "Reference",
  general: "General",
};

const TOPIC_LABELS: Record<string, string> = {
  government: "Government", education: "Education", healthcare: "Healthcare",
  finance: "Finance", legal_judicial: "Legal / Judicial", technology: "Technology",
  environment: "Environment", nonprofit: "Nonprofit", general: "General",
};

const LANG_NAMES: Record<string, string> = {
  en: "English", ru: "Russian", cs: "Czech", pl: "Polish", es: "Spanish",
  zh: "Chinese", lt: "Lithuanian", sk: "Slovak", de: "German", id: "Indonesian",
  fr: "French", pt: "Portuguese", ar: "Arabic", ja: "Japanese", ko: "Korean",
  it: "Italian", sv: "Swedish", nl: "Dutch", bg: "Bulgarian", tr: "Turkish",
  vi: "Vietnamese", th: "Thai", uk: "Ukrainian", ro: "Romanian", hu: "Hungarian",
  hr: "Croatian", fi: "Finnish", da: "Danish", nb: "Norwegian", el: "Greek",
  he: "Hebrew", hi: "Hindi",
};

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data: unknown, status: number, origin: string, cacheSeconds = 0): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...corsHeaders(origin),
  };
  if (cacheSeconds > 0) {
    headers["Cache-Control"] = `public, max-age=${cacheSeconds}`;
  }
  return new Response(JSON.stringify(data), { status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const reqOrigin = request.headers.get("Origin") || "";
    const origin = reqOrigin.startsWith("http://localhost") ? reqOrigin : (env.CORS_ORIGIN || "*");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, origin);
    }

    switch (url.pathname) {
      case "/stats":
        return handleStats(env, origin);
      case "/documents":
        return handleDocuments(url, env, origin);
      case "/manifest":
        return handleManifest(url, env, origin);
      default:
        return json({ error: "Not found" }, 404, origin);
    }
  },
};

// ---------- /api/stats ----------

async function handleStats(env: Env, origin: string): Promise<Response> {
  const sql = neon(env.DATABASE_URL);

  const [heroRows, typeRows, topicRows, langRows] = await Promise.all([
    sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(DISTINCT language) FILTER (WHERE language IS NOT NULL)::int AS languages,
        ROUND(AVG(classification_confidence)::numeric, 2)::float AS avg_confidence,
        COUNT(*) FILTER (WHERE document_type IS NOT NULL)::int AS classified
      FROM documents
      WHERE status = 'uploaded'
    `,
    sql`
      SELECT document_type AS id, COUNT(*)::int AS count
      FROM documents WHERE document_type IS NOT NULL
      GROUP BY document_type ORDER BY count DESC
    `,
    sql`
      SELECT document_topic AS id, COUNT(*)::int AS count
      FROM documents WHERE document_topic IS NOT NULL
      GROUP BY document_topic ORDER BY count DESC
    `,
    sql`
      SELECT
        COALESCE(NULLIF(language, 'unknown'), 'unknown') AS code,
        SUM(count)::int AS count
      FROM (
        SELECT COALESCE(language, 'unknown') AS language, COUNT(*) AS count
        FROM documents WHERE status = 'uploaded'
        GROUP BY language
      ) sub
      GROUP BY COALESCE(NULLIF(language, 'unknown'), 'unknown')
      ORDER BY count DESC
      LIMIT 20
    `,
  ]);

  const hero = heroRows[0];
  const totalClassified = typeRows.reduce((s: number, t: { count: number }) => s + t.count, 0);

  return json({
    hero: {
      total_documents: hero.total,
      languages: hero.languages,
      types: typeRows.length,
      topics: topicRows.length,
      avg_confidence: hero.avg_confidence,
    },
    types: typeRows.map((t: { id: string; count: number }) => ({
      id: t.id,
      label: TYPE_LABELS[t.id] || t.id,
      count: t.count,
      percentage: Math.round((1000 * t.count) / totalClassified) / 10,
    })),
    topics: topicRows.map((t: { id: string; count: number }) => ({
      id: t.id,
      label: TOPIC_LABELS[t.id] || t.id,
      count: t.count,
      percentage: Math.round((1000 * t.count) / totalClassified) / 10,
    })),
    languages: langRows.map((l: { code: string; count: number }) => ({
      code: l.code,
      name: LANG_NAMES[l.code] || l.code,
      count: l.count,
      percentage: Math.round((1000 * l.count) / hero.total) / 10,
    })),
  }, 200, origin, 300); // cache 5 minutes
}

// ---------- shared filter builder ----------

function buildFilters(url: URL): { where: string; params: unknown[]; paramIndex: number } {
  const type = url.searchParams.get("type") || "";
  const topic = url.searchParams.get("topic") || "";
  const lang = url.searchParams.get("lang") || "";
  const minConf = parseFloat(url.searchParams.get("min_confidence") || "0");

  const conditions: string[] = ["document_type IS NOT NULL"];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (type) {
    conditions.push(`document_type = $${paramIndex}`);
    params.push(type);
    paramIndex++;
  }
  if (topic) {
    conditions.push(`document_topic = $${paramIndex}`);
    params.push(topic);
    paramIndex++;
  }
  if (lang) {
    conditions.push(`language = $${paramIndex}`);
    params.push(lang);
    paramIndex++;
  }
  if (minConf > 0) {
    conditions.push(`classification_confidence >= $${paramIndex}`);
    params.push(minConf);
    paramIndex++;
  }

  return { where: conditions.join(" AND "), params, paramIndex };
}

// Build filters excluding one dimension (for facet counts)
function buildFiltersExcluding(url: URL, exclude: string): { where: string; params: unknown[] } {
  const type = exclude === "type" ? "" : (url.searchParams.get("type") || "");
  const topic = exclude === "topic" ? "" : (url.searchParams.get("topic") || "");
  const lang = exclude === "lang" ? "" : (url.searchParams.get("lang") || "");
  const minConf = parseFloat(url.searchParams.get("min_confidence") || "0");

  const conditions: string[] = ["document_type IS NOT NULL"];
  const params: unknown[] = [];
  let i = 1;

  if (type) { conditions.push(`document_type = $${i}`); params.push(type); i++; }
  if (topic) { conditions.push(`document_topic = $${i}`); params.push(topic); i++; }
  if (lang) { conditions.push(`language = $${i}`); params.push(lang); i++; }
  if (minConf > 0) { conditions.push(`classification_confidence >= $${i}`); params.push(minConf); i++; }

  return { where: conditions.join(" AND "), params };
}

// ---------- /documents ----------

async function handleDocuments(url: URL, env: Env, origin: string): Promise<Response> {
  try {
    const sql = neon(env.DATABASE_URL);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "25", 10)));
    const offset = (page - 1) * limit;
    const { where, params, paramIndex } = buildFilters(url);

    // Facet queries: exclude own dimension so all options remain visible with counts
    const typeFacet = buildFiltersExcluding(url, "type");
    const topicFacet = buildFiltersExcluding(url, "topic");
    const langFacet = buildFiltersExcluding(url, "lang");

    const [countResult, rows, typeCounts, topicCounts, langCounts] = await Promise.all([
      sql.query(`SELECT COUNT(*)::int AS total FROM documents WHERE ${where}`, params),
      sql.query(
        `SELECT id, original_filename AS filename, document_type, document_topic,
                language, word_count, classification_confidence
         FROM documents WHERE ${where}
         ORDER BY classification_confidence DESC NULLS LAST
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        [...params, limit, offset]
      ),
      sql.query(
        `SELECT document_type AS id, COUNT(*)::int AS count
         FROM documents WHERE ${typeFacet.where}
         GROUP BY document_type ORDER BY count DESC`,
        typeFacet.params
      ),
      sql.query(
        `SELECT document_topic AS id, COUNT(*)::int AS count
         FROM documents WHERE ${topicFacet.where}
         GROUP BY document_topic ORDER BY count DESC`,
        topicFacet.params
      ),
      sql.query(
        `SELECT COALESCE(NULLIF(language, 'unknown'), 'unknown') AS code, COUNT(*)::int AS count
         FROM documents WHERE ${langFacet.where}
         GROUP BY COALESCE(NULLIF(language, 'unknown'), 'unknown')
         ORDER BY count DESC LIMIT 20`,
        langFacet.params
      ),
    ]);

    const total = countResult[0].total as number;
    const documents = (rows as DocumentRow[]).map((r) => ({
      id: r.id,
      filename: r.filename,
      type: r.document_type,
      topic: r.document_topic,
      language: r.language,
      word_count: r.word_count,
      confidence: r.classification_confidence,
    }));

    const langTotal = (langCounts as { code: string; count: number }[]).reduce((s, l) => s + l.count, 0);
    const facets = {
      types: (typeCounts as { id: string; count: number }[]).map(t => ({
        id: t.id, label: TYPE_LABELS[t.id] || t.id, count: t.count,
      })),
      topics: (topicCounts as { id: string; count: number }[]).map(t => ({
        id: t.id, label: TOPIC_LABELS[t.id] || t.id, count: t.count,
      })),
      languages: (langCounts as { code: string; count: number }[]).map(l => ({
        code: l.code,
        name: LANG_NAMES[l.code] || l.code,
        count: l.count,
        percentage: Math.round((1000 * l.count) / langTotal) / 10,
      })),
    };

    return json({ documents, total, page, pages: Math.ceil(total / limit), facets }, 200, origin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("handleDocuments error:", message);
    return json({ error: "Internal server error" }, 500, origin);
  }
}

// ---------- /manifest ----------

const R2_BASE = "https://docxcorp.us/documents/";

async function handleManifest(url: URL, env: Env, origin: string): Promise<Response> {
  try {
    const sql = neon(env.DATABASE_URL);
    const { where, params, paramIndex } = buildFilters(url);
    const rows = await sql.query(
      `SELECT id FROM documents WHERE ${where} ORDER BY id LIMIT $${paramIndex}`,
      [...params, 100000]
    ) as { id: string }[];

    const body = rows.map((r) => `${R2_BASE}${r.id}.docx`).join("\n") + "\n";

    // Build a descriptive filename
    const parts = ["docx-corpus"];
    const type = url.searchParams.get("type");
    const topic = url.searchParams.get("topic");
    const lang = url.searchParams.get("lang");
    if (type) parts.push(type);
    if (topic) parts.push(topic);
    if (lang) parts.push(lang);
    const filename = `${parts.join("-")}-manifest.txt`;

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        ...corsHeaders(origin),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("handleManifest error:", message);
    return json({ error: "Internal server error" }, 500, origin);
  }
}
