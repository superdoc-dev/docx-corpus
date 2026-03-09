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

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = env.CORS_ORIGIN || "*";

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === "/api/documents" && request.method === "GET") {
      return handleDocuments(url, env, origin);
    }

    return json({ error: "Not found" }, 404, origin);
  },
};

async function handleDocuments(
  url: URL,
  env: Env,
  origin: string
): Promise<Response> {
  const sql = neon(env.DATABASE_URL);

  const q = url.searchParams.get("q")?.trim() || "";
  const type = url.searchParams.get("type") || "";
  const topic = url.searchParams.get("topic") || "";
  const lang = url.searchParams.get("lang") || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "25", 10)));
  const offset = (page - 1) * limit;

  // Build WHERE clauses
  const conditions: string[] = ["document_type IS NOT NULL"];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (q) {
    conditions.push(`original_filename ILIKE $${paramIndex}`);
    params.push(`%${q}%`);
    paramIndex++;
  }
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

  const where = conditions.join(" AND ");

  // Count query
  const countResult = await sql(
    `SELECT COUNT(*)::int AS total FROM documents WHERE ${where}`,
    params
  );
  const total = countResult[0].total as number;

  // Data query
  const rows = await sql(
    `SELECT
      id,
      original_filename AS filename,
      document_type,
      document_topic,
      language,
      word_count,
      classification_confidence
    FROM documents
    WHERE ${where}
    ORDER BY classification_confidence DESC NULLS LAST
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset]
  );

  const documents = (rows as DocumentRow[]).map((r) => ({
    id: r.id,
    filename: r.filename,
    type: r.document_type,
    topic: r.document_topic,
    language: r.language,
    word_count: r.word_count,
    confidence: r.classification_confidence,
  }));

  return json(
    {
      documents,
      total,
      page,
      pages: Math.ceil(total / limit),
    },
    200,
    origin
  );
}
