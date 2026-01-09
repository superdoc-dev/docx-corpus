import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Config } from "../config";

export interface R2Storage {
  save(hash: string, content: Uint8Array): Promise<boolean>;
  exists(hash: string): Promise<boolean>;
  get(hash: string): Promise<Uint8Array | null>;
}

export function createR2Storage(config: Config["cloudflare"]): R2Storage {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
    },
  });

  const bucket = config.r2BucketName;

  return {
    async save(hash: string, content: Uint8Array): Promise<boolean> {
      const key = `documents/${hash}.docx`;

      // Check if already exists
      try {
        await client.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: key,
          }),
        );
        return false; // Already exists
      } catch (err: any) {
        if (err.name !== "NotFound" && err.$metadata?.httpStatusCode !== 404) {
          throw err;
        }
        // Doesn't exist, continue to upload
      }

      // Upload
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: content,
          ContentType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
      );

      return true;
    },

    async exists(hash: string): Promise<boolean> {
      const key = `documents/${hash}.docx`;

      try {
        await client.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: key,
          }),
        );
        return true;
      } catch (err: any) {
        if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
          return false;
        }
        throw err;
      }
    },

    async get(hash: string): Promise<Uint8Array | null> {
      const key = `documents/${hash}.docx`;

      try {
        const response = await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
          }),
        );

        if (!response.Body) {
          return null;
        }

        const bytes = await response.Body.transformToByteArray();
        return new Uint8Array(bytes);
      } catch (err: any) {
        if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
          return null;
        }
        throw err;
      }
    },
  };
}
