// Version
import pkg from "./package.json";
export const VERSION = pkg.version;

// Core scraper functionality
export { scrape, type ScrapeOptions } from "./scraper";

// Configuration
export { loadConfig, hasCloudflareCredentials, type Config } from "./config";

// Storage
export { createDb, type DbClient, type DocumentRecord, type DocumentStatus } from "./storage/db";
export { createLocalStorage, type LocalStorage } from "./storage/local";
export { createR2Storage, type R2Storage } from "./storage/r2";

// Common Crawl utilities
export { getLatestCrawlId, getCrawlIds } from "./commoncrawl/index";
export { streamCdxFromR2, type CdxRecord } from "./commoncrawl/cdx-r2";
export { fetchWarcRecord, parseWarcRecord, findPattern, type WarcResult, type FetchOptions } from "./commoncrawl/warc";

// Validation utilities
export { validateDocx, computeHash, extractFilename, type ValidationResult } from "./validation";

// Rate limiter
export { createRateLimiter, type RateLimiter, type RateLimiterConfig } from "./rate-limiter";

// Manifest generation
export { generateManifest } from "./manifest";
