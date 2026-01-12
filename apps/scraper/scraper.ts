import pLimit from "p-limit";
import { streamCdxFromR2, type CdxRecord } from "./commoncrawl/cdx-r2";
import { fetchWarcRecord, type WarcResult } from "./commoncrawl/warc";
import { type Config, hasCloudflareCredentials } from "./config";
import { generateManifest } from "./manifest";
import { createRateLimiter, type RateLimiter } from "./rate-limiter";
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
  writeMultiLineProgress,
} from "./ui";
import { computeHash, extractFilename, validateDocx } from "./validation";

interface ProcessContext {
  db: Awaited<ReturnType<typeof createDb>>;
  storage: ReturnType<typeof createLocalStorage> | ReturnType<typeof createR2Storage>;
  config: Config;
  crawlId: string;
  stats: { saved: number; skipped: number; failed: number };
  rateLimiter: RateLimiter;
  force?: boolean;
}

async function processRecord(record: CdxRecord, ctx: ProcessContext) {
  const { db, storage, config, crawlId, stats, rateLimiter, force } = ctx;

  // Check if already processed (skip if --force)
  if (!force) {
    const existingByUrl = await db.getDocumentByUrl(record.url);
    if (existingByUrl && existingByUrl.status === "uploaded") {
      stats.skipped++;
      return;
    }
  }

  // Download from WARC
  let result: WarcResult;
  try {
    result = await fetchWarcRecord(record, {
      timeoutMs: config.crawl.timeoutMs,
      rateLimiter,
    });
  } catch (err) {
    stats.failed++;
    const urlHash = await computeHash(new TextEncoder().encode(record.url));
    await db.upsertDocument({
      id: `failed-${urlHash}`,
      source_url: record.url,
      crawl_id: crawlId,
      original_filename: extractFilename(record.url),
      status: "failed",
      error_message: err instanceof Error ? err.message : String(err),
    });
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

export async function scrape(
  config: Config,
  batchSize: number,
  verbose?: boolean,
  force?: boolean,
) {
  const startTime = Date.now();
  const useCloud = hasCloudflareCredentials(config);

  header();

  const crawlId = config.crawl.id;
  if (!crawlId) {
    throw new Error("CRAWL_ID must be specified");
  }

  section("Configuration");
  keyValue("Batch size", batchSize === Infinity ? "all" : `${batchSize} documents`);
  keyValue(
    "Storage",
    useCloud ? `R2 (${config.cloudflare.r2BucketName})` : `local (${config.storage.localPath})`,
  );
  keyValue("Crawl", crawlId);
  keyValue("Workers", config.crawl.concurrency);
  if (force) keyValue("Force", "re-process all URLs");
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

  // Parallel download setup
  const downloadLimit = pLimit(config.crawl.concurrency);
  const rateLimiter = createRateLimiter({
    initialRps: config.crawl.rateLimitRps,
    minRps: config.crawl.minRps,
    maxRps: config.crawl.maxRps,
  });

  // Track throughput
  let lastThroughputUpdate = Date.now();
  let docsAtLastUpdate = 0;

  // Track line count for clearing
  let prevLineCount = 1;

  // Progress update function
  const updateProgress = () => {
    const lines: string[] = [];

    // Calculate docs/sec
    const now = Date.now();
    const elapsed = (now - lastThroughputUpdate) / 1000;
    let docsPerSec = 0;
    if (elapsed >= 1) {
      docsPerSec = (stats.saved - docsAtLastUpdate) / elapsed;
      lastThroughputUpdate = now;
      docsAtLastUpdate = stats.saved;
    }

    const { errorCount } = rateLimiter.getStats();

    const extras: string[] = [];
    if (docsPerSec > 0) extras.push(`${docsPerSec.toFixed(1)}/s`);
    if (stats.skipped > 0) extras.push(`${stats.skipped} dup`);
    if (stats.failed > 0) extras.push(`${stats.failed} fail`);
    if (errorCount > 0) extras.push(`${errorCount} retried`);
    const extrasText = extras.length > 0 ? ` (${extras.join(" · ")})` : "";

    if (batchSize === Infinity) {
      lines.push(`  WARC: ${stats.saved} saved${extrasText}`);
    } else {
      const savedDisplay = Math.min(stats.saved, batchSize);
      const warcBar = progressBar(savedDisplay, batchSize);
      lines.push(`  WARC: ${warcBar} ${savedDisplay}/${batchSize} saved${extrasText}`);
    }

    prevLineCount = writeMultiLineProgress(lines, prevLineCount);
  };

  blank();
  section("Processing");
  updateProgress(); // Show initial state

  const tasks: Set<Promise<void>> = new Set();

  for await (const record of streamCdxFromR2(config, crawlId)) {
    // Stop when we have enough saved files
    if (stats.saved >= batchSize) break;

    stats.discovered++;
    updateProgress();

    // Queue parallel download
    const task = downloadLimit(async () => {
      await rateLimiter.acquire();
      await processRecord(record, {
        db,
        storage,
        config,
        crawlId,
        stats,
        rateLimiter: rateLimiter,
        force,
      });
      updateProgress();
    }).finally(() => tasks.delete(task));

    tasks.add(task);

    // Backpressure: if too many tasks queued, wait for some to complete
    if (tasks.size >= config.crawl.concurrency * 2) {
      await Promise.race(tasks);
    }
  }

  // Wait for remaining downloads to complete
  await Promise.all(tasks);

  // Clear progress lines
  clearLines(prevLineCount);
  blank();

  section("Summary");
  keyValue("Saved", stats.saved);
  keyValue("Skipped", stats.skipped);
  keyValue("Failed", stats.failed);
  blank();

  // Generate manifest
  const cloudflareConfig = useCloud ? config.cloudflare : undefined;
  const manifest = await generateManifest(config.storage.localPath, cloudflareConfig);
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
