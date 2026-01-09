import pLimit from "p-limit";
import { type CdxRecord, streamAllCdxFiles } from "./commoncrawl/cdx-index";
import { getLatestCrawl, listCrawls } from "./commoncrawl/index";
import { fetchWarcRecord, type WarcResult } from "./commoncrawl/warc";
import { hasCloudflareCredentials, loadConfig } from "./config";
import { generateManifest } from "./manifest";
import { createRateLimiter } from "./rate-limiter";
import { createDb } from "./storage/db";
import { createLocalStorage } from "./storage/local";
import { createR2Storage } from "./storage/r2";
import {
  blank,
  clearLines,
  formatDuration,
  header,
  keyValue,
  progressBar,
  section,
  VERSION,
  writeTwoLineProgress,
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
  --keep-index     Cache CDX index files locally for faster reruns
  --verbose        Show detailed logs for debugging

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
      await scrape(config, flags.limit || 100, flags.keepIndex, flags.verbose);
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

interface ProcessContext {
  db: Awaited<ReturnType<typeof createDb>>;
  storage:
    | ReturnType<typeof createLocalStorage>
    | ReturnType<typeof createR2Storage>;
  config: ReturnType<typeof loadConfig>;
  crawlId: string;
  stats: { saved: number; skipped: number; failed: number };
}

async function processRecord(record: CdxRecord, ctx: ProcessContext) {
  const { db, storage, config, crawlId, stats } = ctx;

  // Check if already processed
  const existingByUrl = await db.getDocumentByUrl(record.url);
  if (existingByUrl && existingByUrl.status === "uploaded") {
    stats.skipped++;
    return;
  }

  // Download from WARC
  let result: WarcResult;
  try {
    result = await fetchWarcRecord(record as any, {
      timeoutMs: config.download.timeoutMs,
    });
  } catch (err) {
    stats.failed++;
    await db.upsertDocument({
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      source_url: record.url,
      crawl_id: crawlId,
      original_filename: extractFilename(record.url),
      status: "failed",
      error_message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // Check file size
  const maxBytes = config.download.maxFileSizeMb * 1024 * 1024;
  if (result.contentLength > maxBytes) {
    stats.skipped++;
    return;
  }

  // Validate
  const validation = validateDocx(result.content);
  if (!validation.isValid) {
    stats.failed++;
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
    return;
  }

  // Compute hash and save
  const hash = await computeHash(result.content);

  // Check if already exists by hash
  const existingByHash = await db.getDocument(hash);
  if (existingByHash && existingByHash.status === "uploaded") {
    stats.skipped++;
    return;
  }

  // Save to storage
  const isNew = await storage.save(hash, result.content);

  if (isNew) {
    stats.saved++;
  } else {
    stats.skipped++;
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

async function scrape(
  config: ReturnType<typeof loadConfig>,
  limit: number,
  keepIndex?: boolean,
  verbose?: boolean,
) {
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
  keyValue("Workers", config.download.concurrency);
  if (keepIndex) keyValue("Index cache", "enabled");
  if (verbose) keyValue("Verbose", "enabled");
  blank();

  // Initialize storage
  const storage = useCloud
    ? createR2Storage(config.cloudflare)
    : createLocalStorage(config.storage.localPath);

  // Initialize database
  const db = await createDb(config.storage.localPath);
  await db.init();

  // Stats
  const stats = {
    saved: 0,
    skipped: 0,
    failed: 0,
    discovered: 0,
  };

  // CDX progress state
  const cdxProgress = {
    currentFile: 0,
    totalFiles: 0,
    currentFileName: "",
  };

  // Parallel download setup
  const concurrency = config.download.concurrency;
  const downloadLimit = pLimit(concurrency);
  const rateLimiter = createRateLimiter(config.commonCrawl.rateLimitRps);

  // Combined progress update function
  const updateProgress = () => {
    const completed = stats.saved + stats.skipped + stats.failed;
    const cdxLine = `  CDX:   [${cdxProgress.currentFile}/${cdxProgress.totalFiles}] ${cdxProgress.currentFileName}`;
    const bar = progressBar(completed, limit);
    const filesLine = `  Files: ${bar} ${completed}/${limit}`;
    writeTwoLineProgress(cdxLine, filesLine);
  };

  const streamOptions = {
    limit,
    verbose,
    cacheDir: keepIndex
      ? `${config.storage.localPath}/cache/cdx/${crawlId}`
      : undefined,
    onProgress: (progress: {
      currentFileName: string;
      totalFiles: number;
      currentFile: number;
    }) => {
      cdxProgress.currentFile = progress.currentFile;
      cdxProgress.totalFiles = progress.totalFiles;
      cdxProgress.currentFileName = progress.currentFileName;
      updateProgress();
    },
  };

  blank();
  section("Downloading");
  console.log(); // Extra line for two-line progress

  const tasks: Promise<void>[] = [];

  for await (const record of streamAllCdxFiles(crawlId, streamOptions)) {
    stats.discovered++;

    // Queue parallel download
    const task = downloadLimit(async () => {
      await rateLimiter();
      await processRecord(record, {
        db,
        storage,
        config,
        crawlId,
        stats,
      });
      updateProgress();
    });

    tasks.push(task);
  }

  // Wait for all downloads to complete
  await Promise.all(tasks);

  // Clear progress lines and show summary
  clearLines(2);
  blank();

  section("Summary");
  keyValue("Saved", stats.saved);
  keyValue("Skipped", stats.skipped);
  keyValue("Failed", stats.failed);
  blank();

  // Generate manifest
  const cloudflareConfig = useCloud ? config.cloudflare : undefined;
  const manifest = await generateManifest(
    config.storage.localPath,
    cloudflareConfig,
  );
  if (manifest) {
    section("Manifest");
    keyValue("Documents", manifest.count);
    keyValue("File", "manifest.txt");
    if (manifest.uploaded) keyValue("Uploaded", "R2");
    blank();
  }

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
  keepIndex?: boolean;
  verbose?: boolean;
} {
  const flags: any = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--limit" && args[i + 1]) {
      flags.limit = parseInt(args[++i], 10);
    } else if (arg === "--crawl" && args[i + 1]) {
      flags.crawl = args[++i];
    } else if (arg === "--keep-index") {
      flags.keepIndex = true;
    } else if (arg === "--verbose" || arg === "-v") {
      flags.verbose = true;
    }
  }

  return flags;
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
