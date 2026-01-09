const CDX_BASE_URL = "https://index.commoncrawl.org";

/**
 * Get a list of available Common Crawl indexes
 */
export async function listCrawls(): Promise<string[]> {
  const response = await fetch(`${CDX_BASE_URL}/collinfo.json`);

  if (!response.ok) {
    throw new Error(`Failed to list crawls: ${response.status}`);
  }

  const data = (await response.json()) as Array<{ id: string; name: string }>;
  return data.map((c) => c.id);
}

/**
 * Get the latest crawl ID
 */
export async function getLatestCrawl(): Promise<string> {
  const crawls = await listCrawls();
  // Crawls are sorted newest first
  return crawls[0];
}
