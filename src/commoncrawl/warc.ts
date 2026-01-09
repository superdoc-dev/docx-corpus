import { gunzipSync } from "bun";
import type { CdxRecord } from "./cdx-index";

const WARC_BASE_URL = "https://data.commoncrawl.org";

export interface WarcResult {
  content: Uint8Array;
  httpStatus: number;
  contentType: string;
  contentLength: number;
}

/**
 * Download and extract content from a WARC record
 */
export async function fetchWarcRecord(
  record: CdxRecord,
  options: { timeoutMs?: number } = {},
): Promise<WarcResult> {
  const { timeoutMs = 30000 } = options;

  const offset = parseInt(record.offset, 10);
  const length = parseInt(record.length, 10);
  const endOffset = offset + length - 1;

  const url = `${WARC_BASE_URL}/${record.filename}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        Range: `bytes=${offset}-${endOffset}`,
      },
      signal: controller.signal,
    });

    if (!response.ok && response.status !== 206) {
      throw new Error(
        `WARC fetch failed: ${response.status} ${response.statusText}`,
      );
    }

    const compressedBuffer = await response.arrayBuffer();

    // WARC files are gzip compressed - decompress first
    let buffer: Uint8Array;
    try {
      buffer = gunzipSync(new Uint8Array(compressedBuffer));
    } catch {
      // If decompression fails, try parsing as uncompressed
      buffer = new Uint8Array(compressedBuffer);
    }

    return parseWarcRecord(buffer);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Parse a WARC record and extract the HTTP response body
 *
 * WARC format:
 * ```
 * WARC/1.0
 * WARC-Type: response
 * WARC-Target-URI: https://...
 * Content-Length: ...
 * <blank line>
 * HTTP/1.1 200 OK
 * Content-Type: application/...
 * <blank line>
 * <body bytes>
 * ```
 */
export function parseWarcRecord(data: Uint8Array): WarcResult {
  const decoder = new TextDecoder("utf-8", { fatal: false });

  // Find the double CRLF that separates WARC headers from HTTP response
  const doubleCrlf = findPattern(data, [13, 10, 13, 10]); // \r\n\r\n
  if (doubleCrlf === -1) {
    throw new Error("Invalid WARC record: no WARC header separator found");
  }

  // Skip WARC headers, now we're at the HTTP response
  const httpStart = doubleCrlf + 4;
  const httpData = data.slice(httpStart);

  // Find the double CRLF that separates HTTP headers from body
  const httpHeaderEnd = findPattern(httpData, [13, 10, 13, 10]);
  if (httpHeaderEnd === -1) {
    throw new Error("Invalid WARC record: no HTTP header separator found");
  }

  // Parse HTTP headers
  const httpHeaders = decoder.decode(httpData.slice(0, httpHeaderEnd));
  const httpLines = httpHeaders.split("\r\n");

  // Parse status line: "HTTP/1.1 200 OK"
  const statusMatch = httpLines[0].match(/HTTP\/[\d.]+\s+(\d+)/);
  const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : 0;

  // Find Content-Type header
  let contentType = "";
  for (const line of httpLines) {
    const match = line.match(/^Content-Type:\s*(.+)/i);
    if (match) {
      contentType = match[1].trim();
      break;
    }
  }

  // Extract body (after HTTP headers)
  const bodyStart = httpHeaderEnd + 4;
  const content = httpData.slice(bodyStart);

  return {
    content,
    httpStatus,
    contentType,
    contentLength: content.length,
  };
}

/**
 * Find a byte pattern in a Uint8Array
 */
export function findPattern(data: Uint8Array, pattern: number[]): number {
  outer: for (let i = 0; i <= data.length - pattern.length; i++) {
    for (let j = 0; j < pattern.length; j++) {
      if (data[i + j] !== pattern[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}
