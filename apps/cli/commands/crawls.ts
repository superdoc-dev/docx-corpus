import { loadConfig, hasCloudflareCredentials, listFilteredCrawls } from "@docx-corpus/scraper";
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

  const crawls = await listFilteredCrawls(config);

  if (crawls.length === 0) {
    console.log("No filtered crawls found in R2.");
    console.log("Run the cdx-filter Lambda first: cd apps/cdx-filter && ./invoke-all.sh CC-MAIN-2025-51");
    process.exit(0);
  }

  section(`Available crawls (${crawls.length})`);
  for (const crawl of crawls) {
    const sizeMb = (crawl.totalSize / (1024 * 1024)).toFixed(1);
    keyValue(crawl.id, `${crawl.files} files, ${sizeMb} MB`);
  }

  blank();
  console.log(`Scrape the latest: corpus scrape --crawl ${crawls[0].id}`);
}
