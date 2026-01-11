import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, type DbClient } from "../storage/db";

describe("db", () => {
  let db: DbClient;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "db-test-"));
    db = await createDb(tempDir);
    await db.init();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("upsertDocument", () => {
    test("inserts new document", async () => {
      await db.upsertDocument({
        id: "abc123",
        source_url: "https://example.com/doc.docx",
        crawl_id: "CC-MAIN-2025-01",
        status: "pending",
      });

      const doc = await db.getDocument("abc123");
      expect(doc).not.toBeNull();
      expect(doc?.source_url).toBe("https://example.com/doc.docx");
      expect(doc?.crawl_id).toBe("CC-MAIN-2025-01");
      expect(doc?.status).toBe("pending");
    });

    test("updates existing document", async () => {
      await db.upsertDocument({
        id: "abc123",
        source_url: "https://example.com/doc.docx",
        crawl_id: "CC-MAIN-2025-01",
        status: "pending",
      });

      await db.upsertDocument({
        id: "abc123",
        status: "uploaded",
        file_size_bytes: 1024,
      });

      const doc = await db.getDocument("abc123");
      expect(doc?.status).toBe("uploaded");
      expect(doc?.file_size_bytes).toBe(1024);
      // Original fields preserved
      expect(doc?.source_url).toBe("https://example.com/doc.docx");
    });

    test("converts is_valid_docx true to 1 and back", async () => {
      await db.upsertDocument({
        id: "abc123",
        source_url: "https://example.com/doc.docx",
        crawl_id: "CC-MAIN-2025-01",
        is_valid_docx: true,
      });

      const doc = await db.getDocument("abc123");
      expect(doc?.is_valid_docx).toBe(true);
    });

    test("converts is_valid_docx false to 0 and back", async () => {
      await db.upsertDocument({
        id: "abc123",
        source_url: "https://example.com/doc.docx",
        crawl_id: "CC-MAIN-2025-01",
        is_valid_docx: false,
      });

      const doc = await db.getDocument("abc123");
      expect(doc?.is_valid_docx).toBe(false);
    });

    test("preserves is_valid_docx null", async () => {
      await db.upsertDocument({
        id: "abc123",
        source_url: "https://example.com/doc.docx",
        crawl_id: "CC-MAIN-2025-01",
      });

      const doc = await db.getDocument("abc123");
      expect(doc?.is_valid_docx).toBeNull();
    });

    test("can update is_valid_docx from true to false", async () => {
      await db.upsertDocument({
        id: "abc123",
        source_url: "https://example.com/doc.docx",
        crawl_id: "CC-MAIN-2025-01",
        is_valid_docx: true,
      });

      await db.upsertDocument({
        id: "abc123",
        is_valid_docx: false,
      });

      const doc = await db.getDocument("abc123");
      expect(doc?.is_valid_docx).toBe(false);
    });
  });

  describe("getDocument", () => {
    test("returns null for non-existent document", async () => {
      const doc = await db.getDocument("nonexistent");
      expect(doc).toBeNull();
    });
  });

  describe("getDocumentByUrl", () => {
    test("finds document by source URL", async () => {
      await db.upsertDocument({
        id: "abc123",
        source_url: "https://example.com/doc.docx",
        crawl_id: "CC-MAIN-2025-01",
      });

      const doc = await db.getDocumentByUrl("https://example.com/doc.docx");
      expect(doc?.id).toBe("abc123");
    });

    test("returns null for non-existent URL", async () => {
      const doc = await db.getDocumentByUrl("https://nonexistent.com/doc.docx");
      expect(doc).toBeNull();
    });
  });

  describe("getDocumentsByStatus", () => {
    test("filters by status", async () => {
      await db.upsertDocument({
        id: "doc1",
        source_url: "https://example.com/1.docx",
        crawl_id: "CC-MAIN-2025-01",
        status: "pending",
      });
      await db.upsertDocument({
        id: "doc2",
        source_url: "https://example.com/2.docx",
        crawl_id: "CC-MAIN-2025-01",
        status: "uploaded",
      });
      await db.upsertDocument({
        id: "doc3",
        source_url: "https://example.com/3.docx",
        crawl_id: "CC-MAIN-2025-01",
        status: "pending",
      });

      const pending = await db.getDocumentsByStatus("pending");
      expect(pending.length).toBe(2);
      expect(pending.every((d) => d.status === "pending")).toBe(true);
    });

    test("respects limit", async () => {
      for (let i = 0; i < 10; i++) {
        await db.upsertDocument({
          id: `doc${i}`,
          source_url: `https://example.com/${i}.docx`,
          crawl_id: "CC-MAIN-2025-01",
          status: "pending",
        });
      }

      const docs = await db.getDocumentsByStatus("pending", 3);
      expect(docs.length).toBe(3);
    });
  });

  describe("getPendingDocuments", () => {
    test("returns only pending documents", async () => {
      await db.upsertDocument({
        id: "doc1",
        source_url: "https://example.com/1.docx",
        crawl_id: "CC-MAIN-2025-01",
        status: "pending",
      });
      await db.upsertDocument({
        id: "doc2",
        source_url: "https://example.com/2.docx",
        crawl_id: "CC-MAIN-2025-01",
        status: "uploaded",
      });

      const pending = await db.getPendingDocuments(10);
      expect(pending.length).toBe(1);
      expect(pending[0].id).toBe("doc1");
    });
  });

  describe("getAllDocuments", () => {
    test("returns all documents up to limit", async () => {
      for (let i = 0; i < 5; i++) {
        await db.upsertDocument({
          id: `doc${i}`,
          source_url: `https://example.com/${i}.docx`,
          crawl_id: "CC-MAIN-2025-01",
          status: "pending",
        });
      }

      const all = await db.getAllDocuments(3);
      expect(all.length).toBe(3);
    });
  });

  describe("getStats", () => {
    test("returns counts grouped by status", async () => {
      await db.upsertDocument({
        id: "doc1",
        source_url: "https://example.com/1.docx",
        crawl_id: "CC-MAIN-2025-01",
        status: "pending",
      });
      await db.upsertDocument({
        id: "doc2",
        source_url: "https://example.com/2.docx",
        crawl_id: "CC-MAIN-2025-01",
        status: "uploaded",
      });
      await db.upsertDocument({
        id: "doc3",
        source_url: "https://example.com/3.docx",
        crawl_id: "CC-MAIN-2025-01",
        status: "uploaded",
      });

      const stats = await db.getStats();
      const pending = stats.find((s) => s.status === "pending");
      const uploaded = stats.find((s) => s.status === "uploaded");

      expect(pending?.count).toBe(1);
      expect(uploaded?.count).toBe(2);
    });

    test("returns empty array for empty database", async () => {
      const stats = await db.getStats();
      expect(stats).toEqual([]);
    });
  });
});
