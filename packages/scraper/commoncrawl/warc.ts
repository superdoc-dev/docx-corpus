import { gunzipSync } from "bun";
import type { RateLimiter } from "../rate-limiter";
import type { CdxRecord } from "./cdx-r2";

const WARC_BASE_URL = "https://data.commoncrawl.org";
const USER_AGENT = "docx-corpus (https://github.com/superdoc-dev/docx-corpus)";

export interface WarcResult {
  content: Uint8Array;
  httpStatus: number;
  contentType: string;
  contentLength: number;
}

export interface FetchOptions {
  timeoutMs?: number;
  maxRetries?: number;
  maxBackoffMs?: number;
  rateLimiter?: RateLimiter;
  onError?: (status: number, url: string, message: string) => void;
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
  const { timeoutMs = 45000, maxRetries = 10, maxBackoffMs = 60000, rateLimiter, onError } = options;

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

      // 403 = IP blocked for 24h, fail fast (unrecoverable)
      if (response.status === 403) {
        throw new HttpError(
          403,
          `WARC fetch blocked (403 Forbidden) - IP likely blocked for 24h. URL: ${record.url}`,
        );
      }

      // Handle rate limiting errors with retry
      if (response.status === 503 || response.status === 429) {
        rateLimiter?.reportError(response.status);
        const statusText = response.status === 429 ? "Too Many Requests" : "Service Unavailable";
        onError?.(response.status, record.url, `${response.status} ${statusText} - backing off`);
        if (attempt < maxRetries) {
          const baseDelay = Math.min(2 ** attempt * 1000, maxBackoffMs);
          const jitter = Math.random() * 0.3 * baseDelay; // 0-30% jitter
          const delay = baseDelay + jitter;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw new HttpError(
          response.status,
          `WARC fetch failed after ${maxRetries} retries: ${response.status}`,
        );
      }

      if (!response.ok && response.status !== 206) {
        onError?.(response.status, record.url, `${response.status} ${response.statusText}`);
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
        const baseDelay = Math.min(2 ** attempt * 1000, maxBackoffMs);
        const jitter = Math.random() * 0.3 * baseDelay;
        const delay = baseDelay + jitter;
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

  // Parse the WARC headers we care about. The WARC Content-Length is
  // mandatory per spec and bounds the WARC content block; the trailing
  // record separator (\r\n\r\n) sits OUTSIDE this length. Bounding by
  // WARC Content-Length first means the record terminator can't leak
  // into the body even when no HTTP Content-Length is present.
  const warcHeaderText = decoder.decode(data.slice(0, doubleCrlf));
  let warcContentLength: number | null = null;
  for (const line of warcHeaderText.split("\r\n")) {
    const m = line.match(/^Content-Length:\s*(\d+)/i);
    if (m) {
      warcContentLength = parseInt(m[1], 10);
      break;
    }
  }

  // Bound the HTTP region by WARC Content-Length when present and sane.
  // If absent or invalid, fall back to slicing through end of buffer
  // (legacy behaviour; preserves backwards-compat with malformed inputs).
  const httpStart = doubleCrlf + 4;
  const availableFromHttpStart = data.length - httpStart;
  const warcBlockEnd =
    warcContentLength !== null &&
    warcContentLength >= 0 &&
    warcContentLength <= availableFromHttpStart
      ? httpStart + warcContentLength
      : data.length;
  const httpData = data.slice(httpStart, warcBlockEnd);

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

  // Find Content-Type and Content-Length headers
  let contentType = "";
  let httpContentLength: number | null = null;
  for (const line of httpLines) {
    const ctMatch = line.match(/^Content-Type:\s*(.+)/i);
    if (ctMatch && !contentType) contentType = ctMatch[1].trim();
    const clMatch = line.match(/^Content-Length:\s*(\d+)/i);
    if (clMatch && httpContentLength === null) httpContentLength = parseInt(clMatch[1], 10);
  }

  // Extract body. Within the WARC-bounded httpData, prefer HTTP
  // Content-Length when present (exact entity body, matches CC's
  // payload digest). Otherwise slice to the end of the bounded block
  // (chunked or no-Content-Length responses still avoid the WARC
  // record separator because httpData was already bounded above).
  const bodyStart = httpHeaderEnd + 4;
  const availableInHttp = httpData.length - bodyStart;
  const sliceEnd =
    httpContentLength !== null &&
    httpContentLength >= 0 &&
    httpContentLength <= availableInHttp
      ? bodyStart + httpContentLength
      : httpData.length;
  const content = httpData.slice(bodyStart, sliceEnd);

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
