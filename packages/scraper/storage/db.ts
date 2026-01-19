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
}

export interface DbClient {
  upsertDocument(doc: Partial<DocumentRecord> & { id: string }): Promise<void>;
  getDocument(id: string): Promise<DocumentRecord | null>;
  getDocumentByUrl(url: string): Promise<DocumentRecord | null>;
  getPendingDocuments(limit: number): Promise<DocumentRecord[]>;
  getDocumentsByStatus(status: DocumentStatus, limit?: number): Promise<DocumentRecord[]>;
  getStats(): Promise<{ status: string; count: number }[]>;
  getAllDocuments(limit?: number): Promise<DocumentRecord[]>;
  close(): Promise<void>;
}

export async function createDb(databaseUrl: string): Promise<DbClient> {
  const sql = new SQL({ url: databaseUrl });

  return {
    async upsertDocument(doc: Partial<DocumentRecord> & { id: string }) {
      const columns = Object.keys(doc).filter(
        (k) => doc[k as keyof typeof doc] !== undefined
      );
      const values = columns.map((k) => doc[k as keyof typeof doc]);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");

      // Check if this looks like an insert (has required fields) or update (partial)
      const hasRequiredFields = "source_url" in doc && "crawl_id" in doc;

      if (hasRequiredFields) {
        // Full insert with ON CONFLICT for atomic upsert
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
        // Partial update - only update specified fields
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

    async close() {
      await sql.close();
    },
  };
}
