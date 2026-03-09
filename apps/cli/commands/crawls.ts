import { loadConfig, hasCloudflareCredentials } from "@docx-corpus/scraper";
import {
  S3Client,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { header, section, keyValue, blank } from "@docx-corpus/shared";

const HELP = `
corpus crawls - List available CDX-filtered crawls from R2

Usage
  corpus crawls [options]

Lists all Common Crawl indexes that have been pre-filtered by the
cdx-filter Lambda. These are ready to scrape.

Options
  --help, -h    Show this help

Environment Variables
  CLOUDFLARE_ACCOUNT_ID   Cloudflare account ID (required)
  R2_ACCESS_KEY_ID        R2 access key (required)
  R2_SECRET_ACCESS_KEY    R2 secret key (required)
  R2_BUCKET_NAME          R2 bucket (default: docx-corpus)

Examples
  corpus crawls
`;

interface CrawlInfo {
  id: string;
  files: number;
  totalSize: number;
}

export async function runCrawls(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }

  const config = loadConfig();

  if (!hasCloudflareCredentials(config)) {
    console.error("Error: Cloudflare R2 credentials are required");
    console.error("Set CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY");
    process.exit(1);
  }

  header("docx-corpus", "crawls");

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${config.cloudflare.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.cloudflare.r2AccessKeyId,
      secretAccessKey: config.cloudflare.r2SecretAccessKey,
    },
  });

  // List all objects under cdx-filtered/
  const crawls = new Map<string, CrawlInfo>();
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: config.cloudflare.r2BucketName,
        Prefix: "cdx-filtered/",
        ContinuationToken: continuationToken,
      })
    );

    for (const obj of response.Contents || []) {
      if (!obj.Key) continue;
      // Key format: cdx-filtered/CC-MAIN-2025-51/part-00001.jsonl
      const parts = obj.Key.split("/");
      if (parts.length < 3) continue;

      const crawlId = parts[1];
      if (!crawls.has(crawlId)) {
        crawls.set(crawlId, { id: crawlId, files: 0, totalSize: 0 });
      }
      const info = crawls.get(crawlId)!;
      info.files++;
      info.totalSize += obj.Size || 0;
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  if (crawls.size === 0) {
    console.log("No filtered crawls found in R2.");
    console.log("Run the cdx-filter Lambda first: cd apps/cdx-filter && ./invoke-all.sh CC-MAIN-2025-51");
    process.exit(0);
  }

  // Sort by crawl ID (newest first)
  const sorted = [...crawls.values()].sort((a, b) => b.id.localeCompare(a.id));

  section(`Available crawls (${sorted.length})`);
  for (const crawl of sorted) {
    const sizeMb = (crawl.totalSize / (1024 * 1024)).toFixed(1);
    keyValue(crawl.id, `${crawl.files} files, ${sizeMb} MB`);
  }

  blank();
  console.log(`Scrape the latest: corpus scrape --crawl ${sorted[0].id}`);
}
