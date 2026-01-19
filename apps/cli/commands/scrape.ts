import { scrape, loadConfig, getCrawlIds, VERSION } from "@docx-corpus/scraper";

interface ParsedFlags {
  batchSize?: number;
  crawlIds?: string[];
  crawlCount?: number;
  verbose?: boolean;
  force?: boolean;
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--batch" && args[i + 1]) {
      flags.batchSize = parseInt(args[++i], 10);
    } else if (arg === "--crawl" && args[i + 1]) {
      const value = args[++i];
      // Bare number = count of latest crawls
      if (/^\d+$/.test(value)) {
        flags.crawlCount = parseInt(value, 10);
        flags.crawlIds = undefined;
      } else if (value.includes(",")) {
        // Comma-separated list
        flags.crawlIds = value
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        flags.crawlCount = undefined;
      } else {
        // Single crawl ID
        flags.crawlIds = [value];
        flags.crawlCount = undefined;
      }
    } else if (arg === "--verbose" || arg === "-v") {
      flags.verbose = true;
    } else if (arg === "--force" || arg === "-f") {
      flags.force = true;
    }
  }

  return flags;
}

const HELP = `
corpus scrape - Download .docx files from Common Crawl

Usage
  corpus scrape [options]

Options
  --batch <n>     Limit to n documents per crawl (default: all)
  --crawl <spec>  Crawl(s) to process (default: latest)
                    <n>         Latest n crawls (e.g., --crawl 3)
                    <id>        Single crawl ID
                    <id>,<id>   Comma-separated list
  --force         Re-process URLs already in database
  --verbose       Show detailed logs for debugging

Environment Variables
  CRAWL_ID             Common Crawl index ID (e.g., CC-MAIN-2025-51)
  CONCURRENCY          Parallel WARC file downloads (default: 5)
  RATE_LIMIT_RPS       WARC requests per second (default: 50)

Examples
  corpus scrape --crawl 3 --batch 100
  corpus scrape --crawl CC-MAIN-2025-51
  corpus scrape --crawl CC-MAIN-2025-51,CC-MAIN-2025-48
`;

export async function runScrape(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }

  const flags = parseFlags(args);
  const config = loadConfig();

  // Resolve crawl IDs from flags
  let crawlIds: string[] | undefined;
  if (flags.crawlCount !== undefined) {
    if (flags.crawlCount < 1) {
      console.error("Error: --crawl count must be at least 1");
      process.exit(1);
    }
    crawlIds = await getCrawlIds(flags.crawlCount);
    if (crawlIds.length === 0) {
      console.error("Error: No crawls available");
      process.exit(1);
    }
    if (crawlIds.length < flags.crawlCount) {
      console.warn(`Warning: Only ${crawlIds.length} crawls available (requested ${flags.crawlCount})`);
    }
  } else if (flags.crawlIds) {
    if (flags.crawlIds.length === 0) {
      console.error("Error: --crawl requires at least one valid crawl ID");
      process.exit(1);
    }
    crawlIds = flags.crawlIds;
  }

  await scrape({
    config,
    batchSize: flags.batchSize ?? Infinity,
    verbose: flags.verbose,
    force: flags.force,
    crawlIds,
    version: VERSION,
  });

  process.exit(0);
}
