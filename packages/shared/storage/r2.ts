import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { R2Config, Storage } from "./types";

/**
 * Create a Cloudflare R2 storage adapter.
 * Keys are S3 object keys (e.g., "documents/abc123.docx").
 */
export function createR2Storage(config: R2Config): Storage {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  const bucket = config.bucket;

  const storage: Storage = {
    async read(key: string): Promise<Uint8Array | null> {
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        );
        if (!response.Body) return null;
        return new Uint8Array(await response.Body.transformToByteArray());
      } catch (err: any) {
        if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
          return null;
        }
        throw err;
      }
    },

    async exists(key: string): Promise<boolean> {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (err: any) {
        if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
          return false;
        }
        throw err;
      }
    },

    async *list(prefix: string): AsyncIterable<string> {
      let continuationToken: string | undefined;
      do {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );
        for (const obj of response.Contents || []) {
          if (obj.Key) yield obj.Key;
        }
        continuationToken = response.NextContinuationToken;
      } while (continuationToken);
    },

    async write(key: string, content: Uint8Array | string): Promise<void> {
      // Always convert to Uint8Array and set ContentLength to avoid
      // "Stream of unknown length" errors with S3-compatible storage
      const body = typeof content === "string"
        ? new TextEncoder().encode(content)
        : content;

      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentLength: body.length,
        }),
      );
    },

    async writeIfNotExists(key: string, content: Uint8Array): Promise<boolean> {
      if (await storage.exists(key)) return false;
      await storage.write(key, content);
      return true;
    },
  };

  return storage;
}
