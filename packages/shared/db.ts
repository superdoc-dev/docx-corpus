import { SQL } from "bun";

export type DocumentStatus = "pending" | "downloading" | "validating" | "uploaded" | "failed";

export interface DocumentRecord {
  id: string; // SHA-256 hash
  source_url: string;
  crawl_id: string;
  original_filename: string | null;
  file_size_bytes: number | null;
  status: DocumentStatus;
  error_message: string | null;
  is_valid_docx: boolean | null;
  discovered_at: string;
  downloaded_at: string | null;
  uploaded_at: string | null;

  // Extraction metadata
  extracted_at: string | null;
  word_count: number | null;
  char_count: number | null;
  table_count: number | null;
  image_count: number | null;
  language: string | null;
  language_confidence: number | null;
  extraction_error: string | null;

  // Embedding data
  embedded_at: string | null;
  embedding_model: string | null;
  embedding: number[] | null;

  // Classification data
  cluster_id: number | null;
  cluster_label: string | null;
  classified_at: string | null;
}

export interface ExtractionData {
  id: string;
  word_count: number;
  char_count: number;
  table_count: number;
  image_count: number;
  language: string;
  language_confidence: number;
  extracted_at?: string;
  extraction_error?: string;
}

export interface EmbeddingData {
  id: string;
  embedding: number[];
  embedding_model: string;
  embedded_at?: string;
}

export interface ClassificationData {
  id: string;
  cluster_id: number;
  cluster_label?: string;
  classified_at?: string;
}

export interface DbClient {
  // Scraping methods (existing)
  upsertDocument(doc: Partial<DocumentRecord> & { id: string }): Promise<void>;
  getDocument(id: string): Promise<DocumentRecord | null>;
  getDocumentByUrl(url: string): Promise<DocumentRecord | null>;
  getUploadedUrls(): Promise<Set<string>>;
  getFailedUrls(): Promise<Set<string>>;
  getPendingDocuments(limit: number): Promise<DocumentRecord[]>;
  getDocumentsByStatus(status: DocumentStatus, limit?: number): Promise<DocumentRecord[]>;
  getStats(): Promise<{ status: string; count: number }[]>;
  getAllDocuments(limit?: number): Promise<DocumentRecord[]>;

  // Extraction methods (new)
  updateExtraction(data: ExtractionData): Promise<void>;
  updateExtractionError(id: string, error: string): Promise<void>;
  getUnextractedDocuments(limit: number): Promise<DocumentRecord[]>;
  getExtractedDocuments(limit: number): Promise<DocumentRecord[]>;

  // Embedding methods (new)
  updateEmbedding(data: EmbeddingData): Promise<void>;
  getUnembeddedDocuments(limit: number): Promise<DocumentRecord[]>;
  getEmbeddedDocuments(limit: number): Promise<DocumentRecord[]>;
  getDocumentsWithEmbeddings(limit: number): Promise<{ id: string; embedding: number[] }[]>;

  // Classification methods (new)
  updateClassification(data: ClassificationData): Promise<void>;
  updateClassificationBatch(data: ClassificationData[]): Promise<void>;
  getUnclassifiedDocuments(limit: number): Promise<DocumentRecord[]>;

  // Stats
  getExtractionStats(): Promise<{ extracted: number; pending: number; errors: number }>;
  getEmbeddingStats(): Promise<{ embedded: number; pending: number }>;
  getClassificationStats(): Promise<{ classified: number; pending: number; clusters: number }>;

  close(): Promise<void>;
}

export async function createDb(databaseUrl: string): Promise<DbClient> {
  const sql = new SQL({ url: databaseUrl });

  return {
    // ==================== Scraping Methods ====================

    async upsertDocument(doc: Partial<DocumentRecord> & { id: string }) {
      const columns = Object.keys(doc).filter(
        (k) => doc[k as keyof typeof doc] !== undefined && k !== "embedding"
      );
      const values = columns.map((k) => doc[k as keyof typeof doc]);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");

      const hasRequiredFields = "source_url" in doc && "crawl_id" in doc;

      if (hasRequiredFields) {
        const updateColumns = columns.filter((k) => k !== "id");
        const updateClauses = updateColumns
          .map((key) => `${key} = EXCLUDED.${key}`)
          .join(", ");

        await sql.unsafe(
          `INSERT INTO documents (${columns.join(", ")}) VALUES (${placeholders})
           ON CONFLICT (id) DO UPDATE SET ${updateClauses}`,
          values as unknown[]
        );
      } else {
        const updateColumns = columns.filter((k) => k !== "id");
        if (updateColumns.length === 0) return;

        const setClauses = updateColumns
          .map((key, i) => `${key} = $${i + 2}`)
          .join(", ");
        const updateValues = [doc.id, ...updateColumns.map((k) => doc[k as keyof typeof doc])];

        await sql.unsafe(
          `UPDATE documents SET ${setClauses} WHERE id = $1`,
          updateValues
        );
      }
    },

    async getDocument(id: string) {
      const rows = await sql<DocumentRecord[]>`
        SELECT * FROM documents WHERE id = ${id}
      `;
      return rows[0] || null;
    },

    async getDocumentByUrl(url: string) {
      const rows = await sql<DocumentRecord[]>`
        SELECT * FROM documents WHERE source_url = ${url}
      `;
      return rows[0] || null;
    },

    async getUploadedUrls() {
      const rows = await sql<{ source_url: string }[]>`
        SELECT source_url FROM documents WHERE status = 'uploaded'
      `;
      return new Set(rows.map((r) => r.source_url));
    },

    async getFailedUrls() {
      const rows = await sql<{ source_url: string }[]>`
        SELECT source_url FROM documents WHERE status = 'failed'
      `;
      return new Set(rows.map((r) => r.source_url));
    },

    async getPendingDocuments(limit: number) {
      return sql<DocumentRecord[]>`
        SELECT * FROM documents WHERE status = 'pending' LIMIT ${limit}
      `;
    },

    async getDocumentsByStatus(status: DocumentStatus, limit = 100) {
      return sql<DocumentRecord[]>`
        SELECT * FROM documents WHERE status = ${status} LIMIT ${limit}
      `;
    },

    async getStats() {
      return sql<{ status: string; count: number }[]>`
        SELECT status, COUNT(*)::int as count FROM documents GROUP BY status
      `;
    },

    async getAllDocuments(limit = 1000) {
      return sql<DocumentRecord[]>`
        SELECT * FROM documents LIMIT ${limit}
      `;
    },

    // ==================== Extraction Methods ====================

    async updateExtraction(data: ExtractionData) {
      const extractedAt = data.extracted_at || new Date().toISOString();
      await sql`
        UPDATE documents SET
          extracted_at = ${extractedAt},
          word_count = ${data.word_count},
          char_count = ${data.char_count},
          table_count = ${data.table_count},
          image_count = ${data.image_count},
          language = ${data.language},
          language_confidence = ${data.language_confidence},
          extraction_error = NULL
        WHERE id = ${data.id}
      `;
    },

    async updateExtractionError(id: string, error: string) {
      // Note: We don't set extracted_at so failed docs will be retried
      await sql`
        UPDATE documents SET
          extraction_error = ${error}
        WHERE id = ${id}
      `;
    },

    async getUnextractedDocuments(limit: number) {
      // Get docs that haven't been extracted yet (excludes previously failed ones)
      return sql<DocumentRecord[]>`
        SELECT * FROM documents
        WHERE status = 'uploaded'
          AND extracted_at IS NULL
          AND extraction_error IS NULL
        ORDER BY uploaded_at ASC
        LIMIT ${limit}
      `;
    },

    async getExtractedDocuments(limit: number) {
      return sql<DocumentRecord[]>`
        SELECT * FROM documents
        WHERE extracted_at IS NOT NULL
          AND extraction_error IS NULL
        ORDER BY extracted_at DESC
        LIMIT ${limit}
      `;
    },

    // ==================== Embedding Methods ====================

    async updateEmbedding(data: EmbeddingData) {
      const embeddedAt = data.embedded_at || new Date().toISOString();
      // pgvector expects array as string: '[0.1, 0.2, ...]'
      const embeddingStr = `[${data.embedding.join(",")}]`;
      await sql.unsafe(
        `UPDATE documents SET
          embedded_at = $1,
          embedding_model = $2,
          embedding = $3::vector
        WHERE id = $4`,
        [embeddedAt, data.embedding_model, embeddingStr, data.id]
      );
    },

    async getUnembeddedDocuments(limit: number) {
      return sql<DocumentRecord[]>`
        SELECT * FROM documents
        WHERE extracted_at IS NOT NULL
          AND extraction_error IS NULL
          AND embedded_at IS NULL
        ORDER BY extracted_at ASC
        LIMIT ${limit}
      `;
    },

    async getEmbeddedDocuments(limit: number) {
      return sql<DocumentRecord[]>`
        SELECT * FROM documents
        WHERE embedded_at IS NOT NULL
        ORDER BY embedded_at DESC
        LIMIT ${limit}
      `;
    },

    async getDocumentsWithEmbeddings(limit: number) {
      const rows = await sql<{ id: string; embedding: string }[]>`
        SELECT id, embedding::text FROM documents
        WHERE embedded_at IS NOT NULL
        LIMIT ${limit}
      `;
      // Parse embedding from pgvector string format '[0.1, 0.2, ...]'
      return rows.map((r) => ({
        id: r.id,
        embedding: JSON.parse(r.embedding) as number[],
      }));
    },

    // ==================== Classification Methods ====================

    async updateClassification(data: ClassificationData) {
      const classifiedAt = data.classified_at || new Date().toISOString();
      await sql`
        UPDATE documents SET
          cluster_id = ${data.cluster_id},
          cluster_label = ${data.cluster_label || null},
          classified_at = ${classifiedAt}
        WHERE id = ${data.id}
      `;
    },

    async updateClassificationBatch(data: ClassificationData[]) {
      const classifiedAt = new Date().toISOString();
      for (const d of data) {
        await sql`
          UPDATE documents SET
            cluster_id = ${d.cluster_id},
            cluster_label = ${d.cluster_label || null},
            classified_at = ${classifiedAt}
          WHERE id = ${d.id}
        `;
      }
    },

    async getUnclassifiedDocuments(limit: number) {
      return sql<DocumentRecord[]>`
        SELECT * FROM documents
        WHERE embedded_at IS NOT NULL
          AND classified_at IS NULL
        ORDER BY embedded_at ASC
        LIMIT ${limit}
      `;
    },

    // ==================== Stats ====================

    async getExtractionStats() {
      const result = await sql<{ extracted: number; pending: number; errors: number }[]>`
        SELECT
          COUNT(*) FILTER (WHERE extracted_at IS NOT NULL AND extraction_error IS NULL)::int as extracted,
          COUNT(*) FILTER (WHERE status = 'uploaded' AND extracted_at IS NULL)::int as pending,
          COUNT(*) FILTER (WHERE extraction_error IS NOT NULL)::int as errors
        FROM documents
      `;
      return result[0];
    },

    async getEmbeddingStats() {
      const result = await sql<{ embedded: number; pending: number }[]>`
        SELECT
          COUNT(*) FILTER (WHERE embedded_at IS NOT NULL)::int as embedded,
          COUNT(*) FILTER (WHERE extracted_at IS NOT NULL AND extraction_error IS NULL AND embedded_at IS NULL)::int as pending
        FROM documents
      `;
      return result[0];
    },

    async getClassificationStats() {
      const result = await sql<{ classified: number; pending: number; clusters: number }[]>`
        SELECT
          COUNT(*) FILTER (WHERE classified_at IS NOT NULL)::int as classified,
          COUNT(*) FILTER (WHERE embedded_at IS NOT NULL AND classified_at IS NULL)::int as pending,
          COUNT(DISTINCT cluster_id) FILTER (WHERE cluster_id IS NOT NULL)::int as clusters
        FROM documents
      `;
      return result[0];
    },

    async close() {
      await sql.close();
    },
  };
}
