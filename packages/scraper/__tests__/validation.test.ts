import { describe, expect, test } from "bun:test";
import { computeHash, extractFilename, validateDocx } from "../validation";

describe("validateDocx", () => {
  // Helper to create minimal valid DOCX-like data
  function createValidDocxBytes(): Uint8Array {
    // ZIP magic bytes + enough content to pass validation (>100 bytes)
    const zipMagic = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const content = new TextEncoder().encode(
      "[Content_Types].xml word/document.xml padding to make it over one hundred bytes of total size which is the minimum",
    );
    const result = new Uint8Array(zipMagic.length + content.length);
    result.set(zipMagic, 0);
    result.set(content, zipMagic.length);
    return result;
  }

  test("accepts valid DOCX with required markers", () => {
    const data = createValidDocxBytes();
    const result = validateDocx(data);
    expect(result.isValid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("rejects file smaller than 100 bytes", () => {
    const data = new Uint8Array(50);
    const result = validateDocx(data);
    expect(result.isValid).toBe(false);
    expect(result.error).toContain("too small");
  });

  test("rejects file with wrong magic bytes", () => {
    // Not a ZIP file
    const data = new Uint8Array(150);
    data.set(new TextEncoder().encode("NOT_A_ZIP_FILE"), 0);
    const result = validateDocx(data);
    expect(result.isValid).toBe(false);
    expect(result.error).toContain("wrong magic bytes");
  });

  test("rejects ZIP missing [Content_Types].xml", () => {
    const zipMagic = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const content = new TextEncoder().encode(
      "word/document.xml but no content types marker here padding for size",
    );
    const data = new Uint8Array(zipMagic.length + content.length + 50);
    data.set(zipMagic, 0);
    data.set(content, zipMagic.length);

    const result = validateDocx(data);
    expect(result.isValid).toBe(false);
    expect(result.error).toContain("[Content_Types].xml");
  });

  test("rejects ZIP missing word/document.xml", () => {
    const zipMagic = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const content = new TextEncoder().encode(
      "[Content_Types].xml but no document marker here padding to exceed size limit and make it over one hundred bytes total",
    );
    const data = new Uint8Array(zipMagic.length + content.length);
    data.set(zipMagic, 0);
    data.set(content, zipMagic.length);

    const result = validateDocx(data);
    expect(result.isValid).toBe(false);
    expect(result.error).toContain("word/document");
  });

  test("accepts word/document without .xml suffix", () => {
    // The code checks for "word/document" as fallback
    const zipMagic = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const content = new TextEncoder().encode(
      "[Content_Types].xml word/document padding to make this long enough over one hundred bytes for size validation",
    );
    const data = new Uint8Array(zipMagic.length + content.length);
    data.set(zipMagic, 0);
    data.set(content, zipMagic.length);

    const result = validateDocx(data);
    expect(result.isValid).toBe(true);
  });

  test("handles binary data with embedded null bytes", () => {
    const zipMagic = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const textPart = new TextEncoder().encode("[Content_Types].xml word/document.xml");
    const data = new Uint8Array(150);
    data.set(zipMagic, 0);
    // Insert some null bytes
    data.set(new Uint8Array([0, 0, 0]), zipMagic.length);
    data.set(textPart, zipMagic.length + 3);

    const result = validateDocx(data);
    expect(result.isValid).toBe(true);
  });
});

describe("extractFilename", () => {
  test("extracts simple filename from URL", () => {
    expect(extractFilename("https://example.com/doc.docx")).toBe("doc.docx");
  });

  test("extracts filename from URL with path", () => {
    expect(extractFilename("https://example.com/files/reports/doc.docx")).toBe("doc.docx");
  });

  test("decodes URL-encoded filename", () => {
    expect(extractFilename("https://example.com/my%20doc.docx")).toBe("my doc.docx");
  });

  test("decodes complex URL encoding", () => {
    expect(extractFilename("https://example.com/file%26name%3D1.docx")).toBe("file&name=1.docx");
  });

  test("handles URL with query parameters", () => {
    // URL.pathname strips query params, so only the filename is returned
    expect(extractFilename("https://example.com/doc.docx?v=1")).toBe("doc.docx");
  });

  test("returns unknown.docx for URL without path", () => {
    expect(extractFilename("https://example.com/")).toBe("unknown.docx");
  });

  test("returns unknown.docx for invalid URL", () => {
    expect(extractFilename("not a valid url")).toBe("unknown.docx");
  });

  test("handles URL with trailing slash", () => {
    expect(extractFilename("https://example.com/files/")).toBe("unknown.docx");
  });

  test("handles URL with just domain", () => {
    expect(extractFilename("https://example.com")).toBe("unknown.docx");
  });
});

describe("computeHash", () => {
  test("produces consistent hash for same input", async () => {
    const data = new TextEncoder().encode("test data");
    const hash1 = await computeHash(data);
    const hash2 = await computeHash(data);
    expect(hash1).toBe(hash2);
  });

  test("produces different hash for different input", async () => {
    const data1 = new TextEncoder().encode("test data 1");
    const data2 = new TextEncoder().encode("test data 2");
    const hash1 = await computeHash(data1);
    const hash2 = await computeHash(data2);
    expect(hash1).not.toBe(hash2);
  });

  test("produces 64-character hex string", async () => {
    const data = new TextEncoder().encode("test");
    const hash = await computeHash(data);
    expect(hash.length).toBe(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("handles empty data", async () => {
    const data = new Uint8Array(0);
    const hash = await computeHash(data);
    // SHA-256 of empty string is known
    expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("handles binary data with null bytes", async () => {
    const data = new Uint8Array([0x00, 0x00, 0xff, 0xff]);
    const hash = await computeHash(data);
    expect(hash.length).toBe(64);
  });

  test("handles large data", async () => {
    const data = new Uint8Array(1024 * 1024); // 1MB
    data.fill(0x42);
    const hash = await computeHash(data);
    expect(hash.length).toBe(64);
  });
});
