import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

const CDX_BASE_URL = "https://index.commoncrawl.org";
const CACHE_FILE = "crawls.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Get a list of available Common Crawl indexes
 */
export async function listCrawls(options?: {
  cacheDir?: string;
  noCache?: boolean;
}): Promise<string[]> {
  const { cacheDir, noCache } = options || {};
  const cacheFile = cacheDir ? `${cacheDir}/${CACHE_FILE}` : null;

  // Check cache first
  if (cacheFile && !noCache && existsSync(cacheFile)) {
    const stat = statSync(cacheFile);
    const age = Date.now() - stat.mtimeMs;
    if (age < CACHE_TTL_MS) {
      return JSON.parse(readFileSync(cacheFile, "utf-8"));
    }
  }

  const response = await fetch(`${CDX_BASE_URL}/collinfo.json`);

  if (!response.ok) {
    throw new Error(`Failed to list crawls: ${response.status}`);
  }

  const data = (await response.json()) as Array<{ id: string; name: string }>;
  const crawls = data.map((c) => c.id);

  // Write cache
  if (cacheFile && cacheDir) {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(crawls));
  }

  return crawls;
}

/**
 * Get the latest crawl ID
 */
export async function getLatestCrawl(options?: {
  cacheDir?: string;
  noCache?: boolean;
}): Promise<string> {
  const crawls = await listCrawls(options);
  // Crawls are sorted newest first
  return crawls[0];
}
