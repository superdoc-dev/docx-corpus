import { describe, expect, test } from "bun:test";
import { findPattern, parseWarcRecord } from "../commoncrawl/warc";

describe("findPattern", () => {
  test("finds pattern at start of data", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    expect(findPattern(data, [1, 2])).toBe(0);
  });

  test("finds pattern in middle of data", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    expect(findPattern(data, [3, 4])).toBe(2);
  });

  test("finds pattern at end of data", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    expect(findPattern(data, [4, 5])).toBe(3);
  });

  test("returns -1 when pattern not found", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    expect(findPattern(data, [6, 7])).toBe(-1);
  });

  test("returns -1 for empty data", () => {
    const data = new Uint8Array([]);
    expect(findPattern(data, [1, 2])).toBe(-1);
  });

  test("finds single-byte pattern", () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(findPattern(data, [2])).toBe(1);
  });

  test("finds CRLF CRLF pattern", () => {
    const data = new Uint8Array([65, 13, 10, 13, 10, 66]); // A\r\n\r\nB
    expect(findPattern(data, [13, 10, 13, 10])).toBe(1);
  });

  test("handles pattern longer than data", () => {
    const data = new Uint8Array([1, 2]);
    expect(findPattern(data, [1, 2, 3, 4])).toBe(-1);
  });
});

describe("parseWarcRecord", () => {
  // Helper to build WARC record bytes
  function buildWarcRecord(options: {
    httpStatus?: number;
    contentType?: string;
    body?: Uint8Array | string;
  }): Uint8Array {
    const { httpStatus = 200, contentType = "text/plain", body = "" } = options;
    const bodyBytes = typeof body === "string" ? new TextEncoder().encode(body) : body;

    // WARC header ends with \r\n\r\n
    const warcHeader = `WARC/1.0\r\nWARC-Type: response\r\nContent-Length: 100\r\n\r\n`;
    // HTTP header ends with \r\n\r\n
    const httpHeader = `HTTP/1.1 ${httpStatus} OK\r\nContent-Type: ${contentType}\r\n\r\n`;

    const parts = [
      new TextEncoder().encode(warcHeader),
      new TextEncoder().encode(httpHeader),
      bodyBytes,
    ];

    const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }

  test("parses valid WARC record with HTTP 200", () => {
    const data = buildWarcRecord({
      httpStatus: 200,
      contentType: "application/octet-stream",
      body: "hello",
    });

    const result = parseWarcRecord(data);

    expect(result.httpStatus).toBe(200);
    expect(result.contentType).toBe("application/octet-stream");
    expect(new TextDecoder().decode(result.content)).toBe("hello");
  });

  test("parses HTTP 404 response", () => {
    const data = buildWarcRecord({ httpStatus: 404 });
    const result = parseWarcRecord(data);
    expect(result.httpStatus).toBe(404);
  });

  test("parses HTTP 500 response", () => {
    const data = buildWarcRecord({ httpStatus: 500 });
    const result = parseWarcRecord(data);
    expect(result.httpStatus).toBe(500);
  });

  test("extracts Content-Type case-insensitively", () => {
    // Build with lowercase content-type header
    const warcHeader = `WARC/1.0\r\nWARC-Type: response\r\n`;
    const httpHeader = `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n`;

    const parts = [
      new TextEncoder().encode(warcHeader),
      new Uint8Array([13, 10, 13, 10]),
      new TextEncoder().encode(httpHeader),
      new Uint8Array([13, 10, 13, 10]),
      new TextEncoder().encode("{}"),
    ];

    const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
    const data = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      data.set(part, offset);
      offset += part.length;
    }

    const result = parseWarcRecord(data);
    expect(result.contentType).toBe("application/json");
  });

  test("handles binary body content", () => {
    const binaryBody = new Uint8Array([0x00, 0xff, 0x50, 0x4b, 0x03, 0x04]);
    const data = buildWarcRecord({ body: binaryBody });

    const result = parseWarcRecord(data);

    expect(result.content).toEqual(binaryBody);
    expect(result.contentLength).toBe(binaryBody.length);
  });

  test("throws when WARC header separator missing", () => {
    // No \r\n\r\n after WARC headers
    const malformed = new TextEncoder().encode("WARC/1.0\r\nWARC-Type: response\r\n");

    expect(() => parseWarcRecord(malformed)).toThrow(
      "Invalid WARC record: no WARC header separator found",
    );
  });

  test("throws when HTTP header separator missing", () => {
    // Has WARC separator but no HTTP separator
    const warcPart = new TextEncoder().encode("WARC/1.0\r\nWARC-Type: response\r\n");
    const separator = new Uint8Array([13, 10, 13, 10]);
    const httpPart = new TextEncoder().encode("HTTP/1.1 200 OK\r\n");

    const data = new Uint8Array(warcPart.length + separator.length + httpPart.length);
    data.set(warcPart, 0);
    data.set(separator, warcPart.length);
    data.set(httpPart, warcPart.length + separator.length);

    expect(() => parseWarcRecord(data)).toThrow(
      "Invalid WARC record: no HTTP header separator found",
    );
  });

  test("handles empty body", () => {
    const data = buildWarcRecord({ body: "" });
    const result = parseWarcRecord(data);
    expect(result.content.length).toBe(0);
    expect(result.contentLength).toBe(0);
  });

  test("handles missing Content-Type header", () => {
    const warcHeader = `WARC/1.0\r\nWARC-Type: response\r\n`;
    const httpHeader = `HTTP/1.1 200 OK\r\n`;

    const parts = [
      new TextEncoder().encode(warcHeader),
      new Uint8Array([13, 10, 13, 10]),
      new TextEncoder().encode(httpHeader),
      new Uint8Array([13, 10, 13, 10]),
      new TextEncoder().encode("body"),
    ];

    const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
    const data = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      data.set(part, offset);
      offset += part.length;
    }

    const result = parseWarcRecord(data);
    expect(result.contentType).toBe("");
  });
});
