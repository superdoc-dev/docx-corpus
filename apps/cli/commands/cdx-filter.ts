import {
  loadConfig,
  hasCloudflareCredentials,
  listFilteredCrawls,
  getAllCrawlIds,
  invokeCdxFilter,
} from "@docx-corpus/scraper";
import { header, section, keyValue, blank } from "@docx-corpus/shared";

const HELP = `
corpus cdx-filter - Filter Common Crawl indexes for .docx URLs via Lambda

Usage
  corpus cdx-filter [options]

With no flags, shows available vs already-filtered crawls.
Pass --crawl or --all to invoke the Lambda and process new crawls.

Options
  --crawl <id>      Filter a specific crawl (e.g. CC-MAIN-2026-08)
  --all             Filter all missing crawls
  --latest <n>      Filter the latest N missing crawls (default: 1)
  --region <r>      AWS region for Lambda (default: us-east-1)
  --concurrency <n> Parallel Lambda invocations per crawl (default: 10)
  --help, -h        Show this help

Environment Variables
  AWS_REGION / AWS_PROFILE    AWS credentials for Lambda invocation
  CLOUDFLARE_ACCOUNT_ID       Cloudflare account ID (for R2 lookup)
  R2_ACCESS_KEY_ID            R2 access key
  R2_SECRET_ACCESS_KEY        R2 secret key

Examples
  corpus cdx-filter                          # Show missing crawls
  corpus cdx-filter --crawl CC-MAIN-2026-08  # Filter one crawl
  corpus cdx-filter --latest 3               # Filter 3 newest missing
  corpus cdx-filter --all                    # Filter everything missing
`;

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

export async function runCdxFilter(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }

  const config = loadConfig();
  const crawlId = parseFlag(args, "--crawl");
  const filterAll = args.includes("--all");
  const latest = parseFlag(args, "--latest");
  const region = parseFlag(args, "--region") || "us-east-1";
  const concurrency = parseInt(parseFlag(args, "--concurrency") || "10", 10);

  header("docx-corpus", "cdx-filter");

  // Fetch available crawls from Common Crawl API
  console.log("Fetching crawl index from Common Crawl...");
  const allCrawlIds = await getAllCrawlIds();
  console.log(`Found ${allCrawlIds.length} crawls available\n`);

  // If filtering a specific crawl, just do it
  if (crawlId) {
    if (!allCrawlIds.includes(crawlId)) {
      console.error(`Unknown crawl ID: ${crawlId}`);
      console.error("Use 'corpus cdx-filter' to see available crawls");
      process.exit(1);
    }

    section(`Filtering ${crawlId}`);
    const result = await invokeCdxFilter(crawlId, { region, concurrency });
    console.log(`Queued ${result.invoked} Lambda invocations for ${crawlId}`);
    blank();
    console.log("Monitor progress: aws logs tail /aws/lambda/cdx-filter --follow --region us-east-1");
    return;
  }

  // Compare against what's already filtered in R2
  if (!hasCloudflareCredentials(config)) {
    console.error("Cloudflare R2 credentials required to check filtered crawls");
    console.error("Set CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY");
    process.exit(1);
  }

  const filtered = await listFilteredCrawls(config);
  const filteredIds = new Set(filtered.map((c) => c.id));
  const missing = allCrawlIds.filter((id) => !filteredIds.has(id));

  section(`Crawl status (${allCrawlIds.length} total)`);
  keyValue("Filtered", `${filtered.length} crawls`);
  keyValue("Missing", `${missing.length} crawls`);
  blank();

  if (missing.length > 0) {
    section("Missing crawls (newest first)");
    for (const id of missing.slice(0, 20)) {
      console.log(`  ${id}`);
    }
    if (missing.length > 20) {
      console.log(`  ... and ${missing.length - 20} more`);
    }
    blank();
  }

  // If --all or --latest, process missing crawls
  if (!filterAll && !latest) {
    if (missing.length > 0) {
      console.log("To filter missing crawls:");
      console.log(`  corpus cdx-filter --latest 1       # newest missing`);
      console.log(`  corpus cdx-filter --all            # all ${missing.length} missing`);
      console.log(`  corpus cdx-filter --crawl ${missing[0]}  # specific crawl`);
    }
    return;
  }

  const toProcess = filterAll ? missing : missing.slice(0, parseInt(latest || "1", 10));

  section(`Filtering ${toProcess.length} crawl${toProcess.length > 1 ? "s" : ""}`);
  for (const id of toProcess) {
    console.log(`\nProcessing ${id}...`);
    const result = await invokeCdxFilter(id, { region, concurrency });
    console.log(`  Queued ${result.invoked} Lambda invocations`);
  }

  blank();
  console.log(`Done! ${toProcess.length} crawl(s) queued for filtering.`);
  console.log("Monitor: aws logs tail /aws/lambda/cdx-filter --follow --region us-east-1");
}
