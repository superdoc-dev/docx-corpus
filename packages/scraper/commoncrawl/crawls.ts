import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import type { Config } from "../config";

export interface FilteredCrawl {
  id: string;
  files: number;
  totalSize: number;
}

/**
 * List all CDX-filtered crawls available in R2.
 * Returns crawls sorted newest-first.
 */
export async function listFilteredCrawls(config: Config): Promise<FilteredCrawl[]> {
  const { cloudflare } = config;

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${cloudflare.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: cloudflare.r2AccessKeyId,
      secretAccessKey: cloudflare.r2SecretAccessKey,
    },
  });

  const crawls = new Map<string, FilteredCrawl>();
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: cloudflare.r2BucketName,
        Prefix: "cdx-filtered/",
        ContinuationToken: continuationToken,
      })
    );

    for (const obj of response.Contents || []) {
      if (!obj.Key) continue;
      // Key format: cdx-filtered/CC-MAIN-2025-51/part-00001.jsonl
      const parts = obj.Key.split("/");
      if (parts.length < 3) continue;

      const crawlId = parts[1];
      if (!crawls.has(crawlId)) {
        crawls.set(crawlId, { id: crawlId, files: 0, totalSize: 0 });
      }
      const info = crawls.get(crawlId)!;
      info.files++;
      info.totalSize += obj.Size || 0;
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return [...crawls.values()].sort((a, b) => b.id.localeCompare(a.id));
}
