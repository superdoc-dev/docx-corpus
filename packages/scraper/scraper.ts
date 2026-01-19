import pLimit from "p-limit";
import { streamCdxFromR2, type CdxRecord } from "./commoncrawl/cdx-r2";
import { getLatestCrawlId } from "./commoncrawl/index";
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
  formatProgress,
  header,
  keyValue,
  logError,
  section,
  writeMultiLineProgress,
} from "@docx-corpus/shared";
import { computeHash, extractFilename, validateDocx } from "./validation";

interface ProcessContext {
  db: Awaited<ReturnType<typeof createDb>>;
  storage: ReturnType<typeof createLocalStorage> | ReturnType<typeof createR2Storage>;
  config: Config;
  crawlId: string;
  stats: { saved: number; skipped: number; failed: number };
  rateLimiter: RateLimiter;
  force?: boolean;
  onError?: (status: number, url: string, message: string) => void;
}

async function processRecord(record: CdxRecord, ctx: ProcessContext) {
  const { db, storage, config, crawlId, stats, rateLimiter, force, onError } = ctx;

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
      onError,
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

export interface ScrapeOptions {
  config: Config;
  batchSize: number;
  verbose?: boolean;
  force?: boolean;
  crawlIds?: string[];
  version: string;
}

export async function scrape(options: ScrapeOptions) {
  const { config, batchSize, verbose, force, crawlIds, version } = options;
  const startTime = Date.now();
  const useCloud = hasCloudflareCredentials(config);

  header("docx-corpus", version);

  // Resolve crawl IDs: from param, config, or fetch latest
  let resolvedCrawlIds: string[];
  if (crawlIds !== undefined) {
    if (crawlIds.length === 0) {
      throw new Error("crawlIds array is empty");
    }
    resolvedCrawlIds = crawlIds;
  } else if (config.crawl.id) {
    resolvedCrawlIds = [config.crawl.id];
  } else {
    resolvedCrawlIds = [await getLatestCrawlId()];
  }

  section("Configuration");
  keyValue("Batch size", batchSize === Infinity ? "all" : `${batchSize} documents per crawl`);
  keyValue(
    "Storage",
    useCloud ? `R2 (${config.cloudflare.r2BucketName})` : `local (${config.storage.localPath})`,
  );
  keyValue("Crawl(s)", resolvedCrawlIds.join(", "));
  keyValue("Workers", config.crawl.concurrency);
  if (force) keyValue("Force", "re-process all URLs");
  if (verbose) keyValue("Verbose", "enabled");
  blank();

  // Initialize storage
  const storage = useCloud
    ? createR2Storage(config.cloudflare)
    : createLocalStorage(config.storage.localPath);

  // Initialize database
  const db = await createDb(config.database.url);

  // Aggregate stats across all crawls
  const totalStats = { saved: 0, skipped: 0, failed: 0 };

  // Process each crawl
  for (const crawlId of resolvedCrawlIds) {
    const crawlStartTime = Date.now();

    // Per-crawl stats
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

    // Track throughput (reset per crawl)
    let lastThroughputUpdate = crawlStartTime;
    let docsAtLastUpdate = 0;
    let currentDocsPerSec = 0;

    // Track line count for clearing
    let prevLineCount = 2;

    // Error logging for verbose mode
    const onError = verbose
      ? (_status: number, url: string, message: string) => {
          clearLines(prevLineCount);
          logError(`${message} - ${url}`);
          prevLineCount = 0;
        }
      : undefined;

    // Progress update function
    const updateProgress = () => {
      const now = Date.now();
      const elapsed = (now - lastThroughputUpdate) / 1000;
      if (elapsed >= 1) {
        currentDocsPerSec = (stats.saved - docsAtLastUpdate) / elapsed;
        lastThroughputUpdate = now;
        docsAtLastUpdate = stats.saved;
      }

      const { errorCount } = rateLimiter.getStats();

      const lines = formatProgress({
        saved: Math.min(stats.saved, batchSize),
        total: batchSize,
        docsPerSec: currentDocsPerSec,
        currentRps: rateLimiter.getCurrentRps(),
        skipped: stats.skipped,
        failed: stats.failed,
        retried: errorCount,
        elapsedMs: Date.now() - crawlStartTime,
      });

      prevLineCount = writeMultiLineProgress(lines, prevLineCount);
    };

    blank();
    section(`Processing ${crawlId}`);
    updateProgress();

    const tasks: Set<Promise<void>> = new Set();

    for await (const record of streamCdxFromR2(config, crawlId)) {
      if (stats.saved >= batchSize) break;

      stats.discovered++;
      updateProgress();

      const task = downloadLimit(async () => {
        await rateLimiter.acquire();
        await processRecord(record, {
          db,
          storage,
          config,
          crawlId,
          stats,
          rateLimiter,
          force,
          onError,
        });
        updateProgress();
      }).finally(() => tasks.delete(task));

      tasks.add(task);

      if (tasks.size >= config.crawl.concurrency * 2) {
        await Promise.race(tasks);
      }
    }

    await Promise.all(tasks);
    clearLines(prevLineCount);

    // Accumulate totals
    totalStats.saved += stats.saved;
    totalStats.skipped += stats.skipped;
    totalStats.failed += stats.failed;
  }

  blank();
  section("Summary");
  keyValue("Saved", totalStats.saved);
  keyValue("Skipped", totalStats.skipped);
  keyValue("Failed", totalStats.failed);
  blank();

  // Generate manifest
  const cloudflareConfig = useCloud ? config.cloudflare : undefined;
  const manifest = await generateManifest(config.database.url, config.storage.localPath, cloudflareConfig);
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
