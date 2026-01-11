import { loadConfig } from "./config";
import { scrape } from "./scraper";
import { createDb } from "./storage/db";
import { blank, header, keyValue, section, VERSION } from "./ui";

const HELP = `
docx-corpus v${VERSION}

Usage
  docx-corpus <command> [options]

Commands
  scrape    Download .docx files from Common Crawl
  status    Show corpus statistics

Options
  --batch <n>   Limit to n documents (default: all)
  --crawl <id>  Common Crawl index ID (required, or set CRAWL_ID env var)
  --force       Re-process URLs already in database
  --verbose     Show detailed logs for debugging

Environment Variables
  CRAWL_ID             Common Crawl index ID (e.g., CC-MAIN-2025-51)
  WARC_CONCURRENCY     Parallel WARC file downloads (default: 50)
  WARC_RATE_LIMIT_RPS  WARC requests per second (default: 50)

Examples
  bun run scrape --crawl CC-MAIN-2025-51 --batch 500
  bun run status
`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    process.exit(0);
  }

  const flags = parseFlags(args.slice(1));
  const config = loadConfig();

  if (flags.crawl) {
    config.crawl.id = flags.crawl;
  }

  switch (command) {
    case "scrape":
      await scrape(config, flags.batchSize ?? Infinity, flags.verbose, flags.force);
      process.exit(0); // Force exit to clean up any lingering async operations
      break;
    case "status":
      await status(config);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

async function status(config: ReturnType<typeof loadConfig>) {
  header();

  const db = await createDb(config.storage.localPath);
  await db.init();

  const stats = await db.getStats();

  section("Corpus Status");
  blank();

  let total = 0;
  for (const { status, count } of stats) {
    keyValue(status, count);
    total += count;
  }

  blank();
  keyValue("Total", total);
}

function parseFlags(args: string[]): {
  batchSize?: number;
  crawl?: string;
  verbose?: boolean;
  force?: boolean;
} {
  const flags: {
    batchSize?: number;
    crawl?: string;
    verbose?: boolean;
    force?: boolean;
  } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--batch" && args[i + 1]) {
      flags.batchSize = parseInt(args[++i], 10);
    } else if (arg === "--crawl" && args[i + 1]) {
      flags.crawl = args[++i];
    } else if (arg === "--verbose" || arg === "-v") {
      flags.verbose = true;
    } else if (arg === "--force" || arg === "-f") {
      flags.force = true;
    }
  }

  return flags;
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
