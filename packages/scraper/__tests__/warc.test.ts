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
  // Helper to build WARC record bytes with accurate WARC Content-Length
  // (the parser bounds httpData by this value, so test fixtures must be honest).
  function buildWarcRecord(options: {
    httpStatus?: number;
    contentType?: string;
    body?: Uint8Array | string;
    appendRecordTerminator?: boolean;
  }): Uint8Array {
    const { httpStatus = 200, contentType = "text/plain", body = "", appendRecordTerminator = false } = options;
    const bodyBytes = typeof body === "string" ? new TextEncoder().encode(body) : body;

    const httpHeader = `HTTP/1.1 ${httpStatus} OK\r\nContent-Type: ${contentType}\r\n\r\n`;
    const httpBytes = new TextEncoder().encode(httpHeader);
    const warcContentLength = httpBytes.length + bodyBytes.length;

    const warcHeader = `WARC/1.0\r\nWARC-Type: response\r\nContent-Length: ${warcContentLength}\r\n\r\n`;

    const parts: Uint8Array[] = [
      new TextEncoder().encode(warcHeader),
      httpBytes,
      bodyBytes,
    ];
    if (appendRecordTerminator) {
      parts.push(new Uint8Array([13, 10, 13, 10]));
    }

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

  test("respects HTTP Content-Length and excludes WARC record terminator", () => {
    // WARC records end with \r\n\r\n after the content block. If the parser
    // slices "everything after HTTP headers" it includes those 4 bytes. The
    // body itself is exactly HTTP Content-Length bytes; anything after is
    // record structure and must not appear in the returned content.
    const httpHeader = `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\n`;
    const body = "hello";
    const httpBytes = new TextEncoder().encode(httpHeader);
    const bodyBytes = new TextEncoder().encode(body);
    const warcContentLength = httpBytes.length + bodyBytes.length;
    const warcHeader = `WARC/1.0\r\nWARC-Type: response\r\nContent-Length: ${warcContentLength}\r\n\r\n`;

    const parts = [
      new TextEncoder().encode(warcHeader),
      httpBytes,
      bodyBytes,
      new Uint8Array([13, 10, 13, 10]), // WARC record terminator (outside Content-Length)
    ];
    const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
    const data = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      data.set(part, offset);
      offset += part.length;
    }

    const result = parseWarcRecord(data);
    expect(new TextDecoder().decode(result.content)).toBe("hello");
    expect(result.contentLength).toBe(5);
  });

  test("WARC Content-Length alone excludes record terminator (no HTTP Content-Length)", () => {
    // Responses without HTTP Content-Length (e.g. chunked Transfer-Encoding)
    // must still avoid pulling the WARC \r\n\r\n separator into the body.
    // The WARC content-block length is structural and bounds httpData.
    const httpHeader = `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n`;
    const body = "no-http-clen";
    const httpBytes = new TextEncoder().encode(httpHeader);
    const bodyBytes = new TextEncoder().encode(body);
    const warcContentLength = httpBytes.length + bodyBytes.length;
    const warcHeader = `WARC/1.0\r\nWARC-Type: response\r\nContent-Length: ${warcContentLength}\r\n\r\n`;

    const parts = [
      new TextEncoder().encode(warcHeader),
      httpBytes,
      bodyBytes,
      new Uint8Array([13, 10, 13, 10]), // WARC record terminator
    ];
    const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
    const data = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      data.set(part, offset);
      offset += part.length;
    }

    const result = parseWarcRecord(data);
    expect(new TextDecoder().decode(result.content)).toBe("no-http-clen");
  });

  test("falls back to slicing to end when no Content-Length present at all", () => {
    // Defensive: if WARC Content-Length is missing too (malformed input),
    // preserve legacy behaviour and take everything after HTTP headers.
    const warcHeader = `WARC/1.0\r\nWARC-Type: response\r\n\r\n`;
    const httpHeader = `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n`;
    const body = "no-clen-anywhere";

    const parts = [
      new TextEncoder().encode(warcHeader),
      new TextEncoder().encode(httpHeader),
      new TextEncoder().encode(body),
    ];
    const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
    const data = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      data.set(part, offset);
      offset += part.length;
    }

    const result = parseWarcRecord(data);
    expect(new TextDecoder().decode(result.content)).toBe("no-clen-anywhere");
  });

  test("falls back when Content-Length exceeds available data", () => {
    // Defensive: if a malformed WARC record claims Content-Length larger than
    // the buffer, don't read past the end. Fall back to slice-to-end.
    const warcHeader = `WARC/1.0\r\nWARC-Type: response\r\n\r\n`;
    const httpHeader = `HTTP/1.1 200 OK\r\nContent-Length: 9999999\r\n\r\n`;
    const body = "short";

    const parts = [
      new TextEncoder().encode(warcHeader),
      new TextEncoder().encode(httpHeader),
      new TextEncoder().encode(body),
    ];
    const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
    const data = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      data.set(part, offset);
      offset += part.length;
    }

    const result = parseWarcRecord(data);
    expect(new TextDecoder().decode(result.content)).toBe("short");
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
