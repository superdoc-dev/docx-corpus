import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export type DocumentStatus =
  | "pending"
  | "downloading"
  | "validating"
  | "uploaded"
  | "failed";

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
  benchmark_score: number | null;
  benchmark_version: string | null;
  benchmarked_at: string | null;
}

export interface DbClient {
  init(): Promise<void>;
  upsertDocument(doc: Partial<DocumentRecord> & { id: string }): Promise<void>;
  getDocument(id: string): Promise<DocumentRecord | null>;
  getDocumentByUrl(url: string): Promise<DocumentRecord | null>;
  getPendingDocuments(limit: number): Promise<DocumentRecord[]>;
  getDocumentsByStatus(
    status: DocumentStatus,
    limit?: number,
  ): Promise<DocumentRecord[]>;
  getStats(): Promise<{ status: string; count: number }[]>;
  getAllDocuments(limit?: number): Promise<DocumentRecord[]>;
}

export async function createDb(basePath: string): Promise<DbClient> {
  await mkdir(basePath, { recursive: true });
  const dbPath = join(basePath, "corpus.db");
  const db = new Database(dbPath);

  function getDocument(id: string): DocumentRecord | null {
    const row = db.query("SELECT * FROM documents WHERE id = ?").get(id) as any;
    return row ? normalizeRow(row) : null;
  }

  return {
    async init() {
      db.run(`
        CREATE TABLE IF NOT EXISTS documents (
          id TEXT PRIMARY KEY,
          source_url TEXT NOT NULL,
          crawl_id TEXT NOT NULL,
          original_filename TEXT,
          file_size_bytes INTEGER,
          status TEXT DEFAULT 'pending',
          error_message TEXT,
          is_valid_docx INTEGER,
          discovered_at TEXT DEFAULT (datetime('now')),
          downloaded_at TEXT,
          uploaded_at TEXT,
          benchmark_score REAL,
          benchmark_version TEXT,
          benchmarked_at TEXT
        )
      `);

      db.run(`CREATE INDEX IF NOT EXISTS idx_status ON documents(status)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_crawl ON documents(crawl_id)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_url ON documents(source_url)`);
    },

    async upsertDocument(doc: Partial<DocumentRecord> & { id: string }) {
      const existing = getDocument(doc.id);

      if (existing) {
        // Update
        const updates: string[] = [];
        const values: (string | number | null)[] = [];

        for (const [key, value] of Object.entries(doc)) {
          if (key !== "id" && value !== undefined) {
            updates.push(`${key} = ?`);
            const v = key === "is_valid_docx" ? (value ? 1 : 0) : value;
            values.push(v as string | number | null);
          }
        }

        if (updates.length > 0) {
          values.push(doc.id);
          db.run(
            `UPDATE documents SET ${updates.join(", ")} WHERE id = ?`,
            values,
          );
        }
      } else {
        // Insert
        const columns = Object.keys(doc).filter(
          (k) => doc[k as keyof typeof doc] !== undefined,
        );
        const placeholders = columns.map(() => "?").join(", ");
        const values = columns.map((k) => {
          const val = doc[k as keyof typeof doc];
          const v = k === "is_valid_docx" ? (val ? 1 : 0) : val;
          return v as string | number | null;
        });

        db.run(
          `INSERT INTO documents (${columns.join(", ")}) VALUES (${placeholders})`,
          values,
        );
      }
    },

    async getDocument(id: string) {
      return getDocument(id);
    },

    async getDocumentByUrl(url: string) {
      const row = db
        .query("SELECT * FROM documents WHERE source_url = ?")
        .get(url) as any;
      return row ? normalizeRow(row) : null;
    },

    async getPendingDocuments(limit: number) {
      const rows = db
        .query("SELECT * FROM documents WHERE status = 'pending' LIMIT ?")
        .all(limit) as any[];
      return rows.map(normalizeRow);
    },

    async getDocumentsByStatus(status: DocumentStatus, limit = 100) {
      const rows = db
        .query("SELECT * FROM documents WHERE status = ? LIMIT ?")
        .all(status, limit) as any[];
      return rows.map(normalizeRow);
    },

    async getStats() {
      const rows = db
        .query(
          "SELECT status, COUNT(*) as count FROM documents GROUP BY status",
        )
        .all() as any[];
      return rows;
    },

    async getAllDocuments(limit = 1000) {
      const rows = db
        .query("SELECT * FROM documents LIMIT ?")
        .all(limit) as any[];
      return rows.map(normalizeRow);
    },
  };
}

function normalizeRow(row: any): DocumentRecord {
  return {
    ...row,
    is_valid_docx:
      row.is_valid_docx === 1 ? true : row.is_valid_docx === 0 ? false : null,
  };
}
