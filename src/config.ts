export interface Config {
  crawl: {
    id: string;
    cdxConcurrency: number;
    cdxRateLimitRps: number;
    cdxMaxRps: number;
    cdxMinRps: number;
    warcConcurrency: number;
    warcRateLimitRps: number;
    warcMaxRps: number;
    warcMinRps: number;
    timeoutMs: number;
    cdxQueueSize: number;
  };
  storage: {
    localPath: string;
  };
  cloudflare: {
    accountId: string;
    r2AccessKeyId: string;
    r2SecretAccessKey: string;
    r2BucketName: string;
  };
}

export function loadConfig(): Config {
  const env = process.env;

  return {
    crawl: {
      id: env.CRAWL_ID || "CC-MAIN-2025-51",
      cdxConcurrency: parseInt(env.CDX_CONCURRENCY || "", 10) || 3,
      cdxRateLimitRps: parseInt(env.CDX_RATE_LIMIT_RPS || "", 10) || 5,
      cdxMaxRps: parseInt(env.CDX_MAX_RPS || "", 10) || 10,
      cdxMinRps: parseInt(env.CDX_MIN_RPS || "", 10) || 1,
      cdxQueueSize: parseInt(env.CDX_QUEUE_SIZE || "", 10) || 2000,
      warcConcurrency: parseInt(env.WARC_CONCURRENCY || "", 10) || 50,
      warcRateLimitRps: parseInt(env.WARC_RATE_LIMIT_RPS || "", 10) || 50,
      warcMaxRps: parseInt(env.WARC_MAX_RPS || "", 10) || 100,
      warcMinRps: parseInt(env.WARC_MIN_RPS || "", 10) || 10,
      timeoutMs: parseInt(env.TIMEOUT_MS || "", 10) || 45000,
    },
    storage: {
      localPath: env.STORAGE_PATH || "./corpus",
    },
    cloudflare: {
      accountId: env.CLOUDFLARE_ACCOUNT_ID || "",
      r2AccessKeyId: env.R2_ACCESS_KEY_ID || "",
      r2SecretAccessKey: env.R2_SECRET_ACCESS_KEY || "",
      r2BucketName: env.R2_BUCKET_NAME || "docx-corpus",
    },
  };
}

/**
 * Check if Cloudflare credentials are configured
 */
export function hasCloudflareCredentials(config: Config): boolean {
  return !!(
    config.cloudflare.accountId &&
    config.cloudflare.r2AccessKeyId &&
    config.cloudflare.r2SecretAccessKey
  );
}
