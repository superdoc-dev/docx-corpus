import { gunzipSync, spawn } from "bun";

const CC_DATA_URL = "https://data.commoncrawl.org";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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
  currentFile: number;
  currentFileName: string;
  found: number;
}

export type ProgressCallback = (progress: StreamProgress) => void;

/**
 * Get list of CDX index file paths for a crawl
 */
export async function getCdxPaths(crawlId: string): Promise<string[]> {
  const url = `${CC_DATA_URL}/crawl-data/${crawlId}/cc-index.paths.gz`;
  const response = await fetch(url);

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
 * Uses curl + gunzip for proper multi-member gzip handling
 */
export async function* streamCdxFile(
  cdxPath: string,
): AsyncGenerator<CdxRecord> {
  const url = `${CC_DATA_URL}/${cdxPath}`;

  // Use curl + gunzip to properly handle multi-member gzip and stream
  const proc = spawn({
    cmd: ["bash", "-c", `curl -s "${url}" | gunzip | grep "${DOCX_MIME}"`],
    stdout: "pipe",
    stderr: "pipe",
  });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Process complete lines
    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      // Parse CDX line: "surt timestamp {json}"
      const jsonStart = line.indexOf("{");
      if (jsonStart === -1) continue;

      try {
        const record = JSON.parse(line.slice(jsonStart)) as CdxRecord;

        // Only yield actual .docx files (not redirects)
        if (record.mime === DOCX_MIME && record.status === "200") {
          yield record;
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  // Process any remaining buffer
  if (buffer.trim()) {
    const jsonStart = buffer.indexOf("{");
    if (jsonStart !== -1) {
      try {
        const record = JSON.parse(buffer.slice(jsonStart)) as CdxRecord;
        if (record.mime === DOCX_MIME && record.status === "200") {
          yield record;
        }
      } catch {
        // Skip
      }
    }
  }

  await proc.exited;
}

/**
 * Stream .docx records from all CDX files in a crawl
 */
export async function* streamAllCdxFiles(
  crawlId: string,
  options: {
    limit?: number;
    maxFiles?: number;
    onProgress?: ProgressCallback;
  } = {},
): AsyncGenerator<CdxRecord> {
  const { limit = Infinity, maxFiles = Infinity, onProgress } = options;

  const paths = await getCdxPaths(crawlId);

  let yielded = 0;
  let filesProcessed = 0;

  for (const path of paths) {
    if (yielded >= limit || filesProcessed >= maxFiles) break;

    filesProcessed++;
    const filename = path.split("/").pop() || path;

    onProgress?.({
      totalFiles: paths.length,
      currentFile: filesProcessed,
      currentFileName: filename,
      found: yielded,
    });

    for await (const record of streamCdxFile(path)) {
      if (yielded >= limit) break;

      yield record;
      yielded++;
    }
  }
}
