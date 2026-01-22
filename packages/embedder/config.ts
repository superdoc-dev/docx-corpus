import type { EmbeddingModel } from "./types";

export interface EmbedderConfig {
  database: {
    url: string;
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
  embed: {
    inputPrefix: string;
    model: EmbeddingModel;
    batchSize: number;
  };
  google: {
    apiKey: string;
  };
}

export function loadEmbedderConfig(): EmbedderConfig {
  const env = process.env;

  return {
    database: {
      url: env.DATABASE_URL || "",
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
    embed: {
      inputPrefix: env.EMBED_INPUT_PREFIX || "extracted",
      model: (env.EMBED_MODEL as EmbeddingModel) || "google",
      batchSize: parseInt(env.EMBED_BATCH_SIZE || "100", 10),
    },
    google: {
      apiKey: env.GOOGLE_API_KEY || "",
    },
  };
}

/**
 * Check if Cloudflare credentials are configured
 */
export function hasCloudflareCredentials(config: EmbedderConfig): boolean {
  return !!(
    config.cloudflare.accountId &&
    config.cloudflare.r2AccessKeyId &&
    config.cloudflare.r2SecretAccessKey
  );
}

/**
 * Check if Google API key is configured
 */
export function hasGoogleCredentials(config: EmbedderConfig): boolean {
  return !!config.google.apiKey;
}
