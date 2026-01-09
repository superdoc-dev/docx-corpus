import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, spawn } from "bun";

const CC_DATA_URL = "https://data.commoncrawl.org";
const USER_AGENT =
  "docx-corpus/0.9 (https://github.com/superdoc-dev/docx-corpus)";
export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Parse a CDX line and extract the record if it's a valid .docx
 * CDX format: "surt timestamp {json}"
 * Returns null for invalid lines or non-docx records
 */
export function parseCdxLine(line: string): CdxRecord | null {
  if (!line.trim()) return null;

  const jsonStart = line.indexOf("{");
  if (jsonStart === -1) return null;

  try {
    const record = JSON.parse(line.slice(jsonStart)) as CdxRecord;

    // Only return actual .docx files (not redirects)
    if (record.mime === DOCX_MIME && record.status === "200") {
      return record;
    }
    return null;
  } catch {
    return null;
  }
}

export interface CdxRecord {
  url: string;
  mime: string;
  status: string;
  digest: string;
  length: string;
  offset: string;
  filename: string;
}

export interface StreamProgress {
  totalFiles: number;
  completedFiles: number;
  currentFile?: string;
}

export interface FileProgress {
  filename: string;
  bytesDownloaded: number;
  bytesTotal: number;
  recordsFound: number;
}

export type ProgressCallback = (progress: StreamProgress) => void;
export type FileProgressCallback = (progress: FileProgress) => void;

/**
 * Get list of CDX index file paths for a crawl
 */
export async function getCdxPaths(crawlId: string): Promise<string[]> {
  const url = `${CC_DATA_URL}/crawl-data/${crawlId}/cc-index.paths.gz`;
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch CDX paths: ${response.status}`);
  }

  const compressed = new Uint8Array(await response.arrayBuffer());
  const decompressed = gunzipSync(compressed);
  const text = new TextDecoder().decode(decompressed);

  return text.trim().split("\n").filter(Boolean);
}

/**
 * Stream .docx records from a single CDX index file
 * Uses fetch for download progress + gunzip subprocess for multi-member gzip
 */
export async function* streamCdxFile(
  cdxPath: string,
  options?: {
    cacheDir?: string;
    verbose?: boolean;
    onFileProgress?: FileProgressCallback;
  },
): AsyncGenerator<CdxRecord> {
  const filename = cdxPath.split("/").pop() || cdxPath;
  const cacheDir = options?.cacheDir;
  const verbose = options?.verbose;
  const onFileProgress = options?.onFileProgress;
  const cacheFile = cacheDir ? `${cacheDir}/${filename}.txt` : null;

  // Check cache first
  if (cacheFile && existsSync(cacheFile)) {
    const lines = readFileSync(cacheFile, "utf-8").split("\n");
    let recordsFound = 0;
    for (const line of lines) {
      if (line.trim()) {
        recordsFound++;
        yield JSON.parse(line) as CdxRecord;
      }
    }
    onFileProgress?.({
      filename,
      bytesDownloaded: 1,
      bytesTotal: 1,
      recordsFound,
    });
    return;
  }

  const url = `${CC_DATA_URL}/${cdxPath}`;
  const records: CdxRecord[] = [];

  if (verbose) {
    console.log(`  [verbose] Fetching: ${url}`);
  }

  // Get content length first
  const headRes = await fetch(url, {
    method: "HEAD",
    headers: { "User-Agent": USER_AGENT },
  });
  const bytesTotal = parseInt(headRes.headers.get("content-length") || "0", 10);

  // Start download
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch CDX: ${response.status}`);
  }

  // Spawn gunzip to handle multi-member gzip
  const gunzip = spawn({
    cmd: ["gunzip"],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  let bytesDownloaded = 0;
  let recordsFound = 0;

  // Pipe download to gunzip while tracking progress
  const downloadReader = response.body.getReader();
  let downloadAborted = false;
  (async () => {
    try {
      while (!downloadAborted) {
        const { done, value } = await downloadReader.read();
        if (done) break;
        bytesDownloaded += value.length;
        gunzip.stdin.write(value);
        onFileProgress?.({
          filename,
          bytesDownloaded,
          bytesTotal,
          recordsFound,
        });
      }
      gunzip.stdin.end();
    } catch {
      // Download cancelled or error
    }
  })();

  // Read decompressed output from gunzip
  const reader = gunzip.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullyConsumed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.includes(DOCX_MIME)) continue;
        const record = parseCdxLine(line);
        if (record) {
          recordsFound++;
          if (cacheFile) records.push(record);
          onFileProgress?.({
            filename,
            bytesDownloaded,
            bytesTotal,
            recordsFound,
          });
          yield record;
        }
      }
    }

    // Process remaining buffer
    if (buffer.includes(DOCX_MIME)) {
      const lastRecord = parseCdxLine(buffer);
      if (lastRecord) {
        recordsFound++;
        if (cacheFile) records.push(lastRecord);
        yield lastRecord;
      }
    }

    fullyConsumed = true;
  } finally {
    downloadAborted = true;
    downloadReader.cancel().catch(() => {});
    gunzip.kill();
    await gunzip.exited;

    // Cache if fully consumed
    if (fullyConsumed && cacheFile && cacheDir && records.length > 0) {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        cacheFile,
        records.map((r) => JSON.stringify(r)).join("\n"),
      );
    }
  }
}

/**
 * Stream .docx records from all CDX files in a crawl
 */
export async function* streamAllCdxFiles(
  crawlId: string,
  options: {
    limit?: number;
    onProgress?: ProgressCallback;
    cacheDir?: string;
    verbose?: boolean;
  } = {},
): AsyncGenerator<CdxRecord> {
  const { limit = Infinity, onProgress, cacheDir, verbose } = options;

  if (verbose) {
    console.log(`  [verbose] Fetching CDX paths for ${crawlId}...`);
  }

  const paths = await getCdxPaths(crawlId);

  if (verbose) {
    console.log(`  [verbose] Found ${paths.length} CDX index files`);
  }

  let yielded = 0;
  let completedFiles = 0;

  for (const path of paths) {
    if (yielded >= limit) break;

    for await (const record of streamCdxFile(path, { cacheDir, verbose })) {
      if (yielded >= limit) break;

      yield record;
      yielded++;
    }

    completedFiles++;
    onProgress?.({
      totalFiles: paths.length,
      completedFiles,
    });
  }
}
