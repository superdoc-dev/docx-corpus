export interface Config {
  crawl: {
    id: string;
    concurrency: number;
    rateLimitRps: number;
    maxRps: number;
    minRps: number;
    timeoutMs: number;
    maxRetries: number;
    maxBackoffMs: number;
  };
  storage: {
    localPath: string;
  };
  database: {
    url: string;
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
      id: env.CRAWL_ID || "",
      concurrency: parseInt(env.CONCURRENCY || "", 10) || 1,
      rateLimitRps: parseInt(env.RATE_LIMIT_RPS || "", 10) || 2,
      maxRps: parseInt(env.MAX_RPS || "", 10) || 5,
      minRps: parseInt(env.MIN_RPS || "", 10) || 1,
      timeoutMs: parseInt(env.TIMEOUT_MS || "", 10) || 45000,
      maxRetries: parseInt(env.MAX_RETRIES || "", 10) || 5,
      maxBackoffMs: parseInt(env.MAX_BACKOFF_MS || "", 10) || 60000,
    },
    storage: {
      localPath: env.STORAGE_PATH || "./corpus",
    },
    database: {
      url: env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/corpus",
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
