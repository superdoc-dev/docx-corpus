import { streamAllCdxFiles } from "./commoncrawl/cdx-index";
import { getLatestCrawl, listCrawls } from "./commoncrawl/index";
import { fetchWarcRecord, type WarcResult } from "./commoncrawl/warc";
import { hasCloudflareCredentials, loadConfig } from "./config";
import { createDb } from "./storage/db";
import { createLocalStorage } from "./storage/local";
import { createR2Storage } from "./storage/r2";
import {
  blank,
  formatDuration,
  header,
  keyValue,
  progressBar,
  section,
  VERSION,
  writeProgress,
} from "./ui";
import { computeHash, extractFilename, validateDocx } from "./validation";

const HELP = `
docx-corpus v${VERSION}

Usage
  docx-corpus <command> [options]

Commands
  scrape    Download .docx files from Common Crawl
  status    Show corpus statistics
  crawls    List available Common Crawl indexes

Options
  --limit <n>      Maximum documents to download (default: 100)
  --crawl <id>     Common Crawl index ID (default: latest)

Examples
  bun run scrape --limit 500
  bun run scrape --crawl CC-MAIN-2024-51
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
    config.commonCrawl.crawlId = flags.crawl;
  }

  switch (command) {
    case "scrape":
      await scrape(config, flags.limit || 100);
      break;
    case "status":
      await status(config);
      break;
    case "crawls":
      await showCrawls();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

async function scrape(config: ReturnType<typeof loadConfig>, limit: number) {
  const startTime = Date.now();
  const useCloud = hasCloudflareCredentials(config);

  header();

  // Get crawl ID
  let crawlId = config.commonCrawl.crawlId;
  if (!crawlId || crawlId === "latest") {
    crawlId = await getLatestCrawl();
  }

  section("Configuration");
  keyValue("Limit", `${limit} documents`);
  keyValue(
    "Storage",
    useCloud
      ? `R2 (${config.cloudflare.r2BucketName})`
      : `local (${config.storage.localPath})`,
  );
  keyValue("Crawl", crawlId);
  blank();

  // Initialize storage
  const storage = useCloud
    ? createR2Storage(config.cloudflare)
    : createLocalStorage(config.storage.localPath);

  // Initialize database
  const db = await createDb(config.storage.localPath);
  await db.init();

  section("Scanning CDX index...");

  // Stats
  let saved = 0;
  let skipped = 0;
  let failed = 0;
  let discovered = 0;

  const minDelayMs = 1000 / config.commonCrawl.rateLimitRps;
  let lastRequestTime = 0;
  let currentCdxFile = "";

  const streamOptions = {
    limit,
    onProgress: (progress: {
      currentFileName: string;
      totalFiles: number;
      currentFile: number;
    }) => {
      currentCdxFile = progress.currentFileName;
      writeProgress(
        `  [${progress.currentFile}/${progress.totalFiles}] ${progress.currentFileName}`,
      );
    },
  };

  blank();
  section("Downloading");

  for await (const record of streamAllCdxFiles(crawlId, streamOptions)) {
    discovered++;

    // Update progress
    const bar = progressBar(discovered, limit);
    writeProgress(`  [${currentCdxFile}] ${bar} ${discovered}/${limit}`);

    // Check if already processed
    const existingByUrl = await db.getDocumentByUrl(record.url);
    if (existingByUrl && existingByUrl.status === "uploaded") {
      skipped++;
      continue;
    }

    // Rate limiting
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < minDelayMs) {
      await new Promise((r) => setTimeout(r, minDelayMs - elapsed));
    }
    lastRequestTime = Date.now();

    // Download from WARC
    let result: WarcResult;
    try {
      result = await fetchWarcRecord(record as any, {
        timeoutMs: config.download.timeoutMs,
      });
    } catch (err) {
      failed++;
      await db.upsertDocument({
        id: `pending-${discovered}`,
        source_url: record.url,
        crawl_id: crawlId,
        original_filename: extractFilename(record.url),
        status: "failed",
        error_message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // Check file size
    const maxBytes = config.download.maxFileSizeMb * 1024 * 1024;
    if (result.contentLength > maxBytes) {
      skipped++;
      continue;
    }

    // Validate
    const validation = validateDocx(result.content);
    if (!validation.isValid) {
      failed++;
      const hash = await computeHash(result.content);
      await db.upsertDocument({
        id: hash,
        source_url: record.url,
        crawl_id: crawlId,
        original_filename: extractFilename(record.url),
        file_size_bytes: result.contentLength,
        status: "failed",
        error_message: validation.error,
        is_valid_docx: false,
      });
      continue;
    }

    // Compute hash and save
    const hash = await computeHash(result.content);

    // Check if already exists by hash
    const existingByHash = await db.getDocument(hash);
    if (existingByHash && existingByHash.status === "uploaded") {
      skipped++;
      continue;
    }

    // Save to storage
    const isNew = await storage.save(hash, result.content);

    if (isNew) {
      saved++;
    } else {
      skipped++;
    }

    // Update database
    await db.upsertDocument({
      id: hash,
      source_url: record.url,
      crawl_id: crawlId,
      original_filename: extractFilename(record.url),
      file_size_bytes: result.contentLength,
      status: "uploaded",
      is_valid_docx: true,
      downloaded_at: new Date().toISOString(),
      uploaded_at: new Date().toISOString(),
    });
  }

  // Clear progress line and show summary
  writeProgress("");
  console.log();
  blank();

  section("Summary");
  keyValue("Saved", saved);
  keyValue("Skipped", skipped);
  keyValue("Failed", failed);
  blank();

  const duration = Date.now() - startTime;
  console.log(`Done in ${formatDuration(duration)}`);
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

async function showCrawls() {
  header();

  section("Fetching available crawls...");
  const crawls = await listCrawls();

  blank();
  section("Available Common Crawl indexes");
  blank();

  for (const crawl of crawls.slice(0, 20)) {
    console.log(`  ${crawl}`);
  }

  if (crawls.length > 20) {
    blank();
    console.log(`  ... and ${crawls.length - 20} more`);
  }
}

function parseFlags(args: string[]): {
  limit?: number;
  crawl?: string;
} {
  const flags: any = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--limit" && args[i + 1]) {
      flags.limit = parseInt(args[++i], 10);
    } else if (arg === "--crawl" && args[i + 1]) {
      flags.crawl = args[++i];
    }
  }

  return flags;
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
