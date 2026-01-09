import { describe, expect, test } from "bun:test";
import { DOCX_MIME, parseCdxLine } from "../commoncrawl/cdx-index";

describe("parseCdxLine", () => {
  const validRecord = {
    url: "https://example.com/doc.docx",
    mime: DOCX_MIME,
    status: "200",
    digest: "ABC123",
    length: "1000",
    offset: "500",
    filename: "crawl-data/segment/warc.gz",
  };

  test("parses valid CDX line with docx mime type", () => {
    const line = `com,example)/doc.docx 20250101000000 ${JSON.stringify(validRecord)}`;
    const result = parseCdxLine(line);

    expect(result).not.toBeNull();
    expect(result?.url).toBe("https://example.com/doc.docx");
    expect(result?.mime).toBe(DOCX_MIME);
    expect(result?.status).toBe("200");
  });

  test("returns null for empty line", () => {
    expect(parseCdxLine("")).toBeNull();
    expect(parseCdxLine("   ")).toBeNull();
    expect(parseCdxLine("\n")).toBeNull();
  });

  test("returns null for line without JSON", () => {
    expect(parseCdxLine("com,example)/doc.docx 20250101000000")).toBeNull();
    expect(parseCdxLine("just some text")).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    const line = `com,example)/doc.docx 20250101000000 {invalid json}`;
    expect(parseCdxLine(line)).toBeNull();
  });

  test("returns null for non-200 status", () => {
    const redirectRecord = { ...validRecord, status: "301" };
    const line = `com,example)/doc.docx 20250101000000 ${JSON.stringify(redirectRecord)}`;
    expect(parseCdxLine(line)).toBeNull();
  });

  test("returns null for 404 status", () => {
    const notFoundRecord = { ...validRecord, status: "404" };
    const line = `com,example)/doc.docx 20250101000000 ${JSON.stringify(notFoundRecord)}`;
    expect(parseCdxLine(line)).toBeNull();
  });

  test("returns null for non-docx mime type", () => {
    const pdfRecord = { ...validRecord, mime: "application/pdf" };
    const line = `com,example)/doc.pdf 20250101000000 ${JSON.stringify(pdfRecord)}`;
    expect(parseCdxLine(line)).toBeNull();
  });

  test("returns null for HTML mime type", () => {
    const htmlRecord = { ...validRecord, mime: "text/html" };
    const line = `com,example)/page.html 20250101000000 ${JSON.stringify(htmlRecord)}`;
    expect(parseCdxLine(line)).toBeNull();
  });

  test("handles JSON at start of line", () => {
    // Edge case: line is just JSON
    const line = JSON.stringify(validRecord);
    const result = parseCdxLine(line);
    expect(result).not.toBeNull();
    expect(result?.url).toBe("https://example.com/doc.docx");
  });

  test("extracts all record fields correctly", () => {
    const line = `com,example)/doc.docx 20250101000000 ${JSON.stringify(validRecord)}`;
    const result = parseCdxLine(line);

    expect(result).toEqual(validRecord);
  });
});
