import { gunzipSync } from "bun";
import type { RateLimiter } from "../rate-limiter";
import type { CdxRecord } from "./cdx-r2";

const WARC_BASE_URL = "https://data.commoncrawl.org";
const USER_AGENT = "docx-corpus/0.9 (https://github.com/superdoc-dev/docx-corpus)";

export interface WarcResult {
  content: Uint8Array;
  httpStatus: number;
  contentType: string;
  contentLength: number;
}

export interface FetchOptions {
  timeoutMs?: number;
  maxRetries?: number;
  rateLimiter?: RateLimiter;
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Download and extract content from a WARC record with retry logic
 */
export async function fetchWarcRecord(
  record: CdxRecord,
  options: FetchOptions = {},
): Promise<WarcResult> {
  const { timeoutMs = 45000, maxRetries = 3, rateLimiter } = options;

  const offset = parseInt(record.offset, 10);
  const length = parseInt(record.length, 10);
  const endOffset = offset + length - 1;

  const url = `${WARC_BASE_URL}/${record.filename}`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        headers: {
          Range: `bytes=${offset}-${endOffset}`,
          "User-Agent": USER_AGENT,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Handle rate limiting errors with retry
      if (response.status === 503 || response.status === 429) {
        rateLimiter?.reportError(response.status);
        if (attempt < maxRetries) {
          const delay = 2 ** attempt * 1000; // 1s, 2s, 4s
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw new HttpError(
          response.status,
          `WARC fetch failed after ${maxRetries} retries: ${response.status}`,
        );
      }

      if (!response.ok && response.status !== 206) {
        throw new HttpError(
          response.status,
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

      rateLimiter?.reportSuccess();
      return parseWarcRecord(buffer);
    } catch (err) {
      clearTimeout(timeoutId);

      // Don't retry on non-retryable errors
      if (err instanceof HttpError && err.status !== 503 && err.status !== 429) {
        throw err;
      }

      // Retry on network errors or timeout
      if (attempt < maxRetries) {
        const delay = 2 ** attempt * 1000;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      throw err;
    }
  }

  throw new Error("Unexpected: exhausted retries without returning or throwing");
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
