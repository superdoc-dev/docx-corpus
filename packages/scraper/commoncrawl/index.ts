const COLLINFO_URL = "https://index.commoncrawl.org/collinfo.json";

interface CrawlInfo {
  id: string;
  name: string;
}

async function fetchCrawlList(): Promise<CrawlInfo[]> {
  const res = await fetch(COLLINFO_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch crawl list: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as CrawlInfo[];
}

export async function getLatestCrawlId(): Promise<string> {
  const data = await fetchCrawlList();
  if (data.length === 0) {
    throw new Error("No crawls available");
  }
  return data[0].id;
}

export async function getCrawlIds(count: number): Promise<string[]> {
  if (!Number.isFinite(count) || count < 1) {
    throw new Error(`Invalid crawl count: ${count}`);
  }
  const data = await fetchCrawlList();
  return data.slice(0, count).map((c) => c.id);
}
