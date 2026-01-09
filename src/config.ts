export interface Config {
  download: {
    concurrency: number;
    timeoutMs: number;
    retries: number;
    retryDelayMs: number;
    maxFileSizeMb: number;
  };
  commonCrawl: {
    rateLimitRps: number;
    crawlId: string;
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
    download: {
      concurrency: parseInt(env.DOWNLOAD_CONCURRENCY || "", 10) || 10,
      timeoutMs: parseInt(env.DOWNLOAD_TIMEOUT_MS || "", 10) || 30000,
      retries: parseInt(env.DOWNLOAD_RETRIES || "", 10) || 3,
      retryDelayMs: parseInt(env.DOWNLOAD_RETRY_DELAY_MS || "", 10) || 1000,
      maxFileSizeMb: parseInt(env.MAX_FILE_SIZE_MB || "", 10) || 50,
    },
    commonCrawl: {
      rateLimitRps: parseInt(env.COMMONCRAWL_RATE_LIMIT_RPS || "", 10) || 10,
      crawlId: env.COMMONCRAWL_CRAWL_ID || "CC-MAIN-2025-51",
    },
    storage: {
      localPath: env.STORAGE_LOCAL_PATH || "./corpus",
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
