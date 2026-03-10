import { LambdaClient, InvokeCommand, InvocationType } from "@aws-sdk/client-lambda";
import type { Config } from "../config";

const CDX_PATHS_URL = (crawlId: string) =>
  `https://data.commoncrawl.org/crawl-data/${crawlId}/cc-index.paths.gz`;

const COLLINFO_URL = "https://index.commoncrawl.org/collinfo.json";

export interface CdxFilterResult {
  crawlId: string;
  totalPaths: number;
  invoked: number;
}

/**
 * Fetch all available crawl IDs from Common Crawl's index API.
 */
export async function getAllCrawlIds(): Promise<string[]> {
  const res = await fetch(COLLINFO_URL);
  if (!res.ok) throw new Error(`Failed to fetch crawl list: ${res.status}`);
  const data = (await res.json()) as { id: string }[];
  return data.map((c) => c.id);
}

/**
 * Fetch CDX index paths for a given crawl ID.
 * Returns the list of S3 keys (e.g. "crawl-data/CC-MAIN-2026-08/indexes/cdx-00001.gz").
 */
async function fetchCdxPaths(crawlId: string): Promise<string[]> {
  const res = await fetch(CDX_PATHS_URL(crawlId));
  if (!res.ok) throw new Error(`Failed to fetch CDX paths for ${crawlId}: ${res.status}`);

  const buffer = await res.arrayBuffer();
  const decompressed = Bun.gunzipSync(new Uint8Array(buffer));
  const text = new TextDecoder().decode(decompressed);

  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Invoke the cdx-filter Lambda for a single crawl.
 * Fires async (Event) invocations in parallel batches.
 */
export async function invokeCdxFilter(
  crawlId: string,
  options: { region?: string; concurrency?: number; functionName?: string } = {},
): Promise<CdxFilterResult> {
  const region = options.region || "us-east-1";
  const concurrency = options.concurrency || 10;
  const functionName = options.functionName || "cdx-filter";

  const lambda = new LambdaClient({ region });
  const paths = await fetchCdxPaths(crawlId);

  console.log(`  Found ${paths.length} CDX files for ${crawlId}`);

  // Invoke in batches to avoid overwhelming Lambda
  let invoked = 0;
  for (let i = 0; i < paths.length; i += concurrency) {
    const batch = paths.slice(i, i + concurrency);
    await Promise.all(
      batch.map((cdxPath) =>
        lambda.send(
          new InvokeCommand({
            FunctionName: functionName,
            InvocationType: InvocationType.Event,
            Payload: JSON.stringify({ cdxPath, crawlId }),
          }),
        ),
      ),
    );
    invoked += batch.length;
    process.stdout.write(`\r  Invoked ${invoked}/${paths.length} lambdas`);
  }
  console.log(); // newline after progress

  return { crawlId, totalPaths: paths.length, invoked };
}
