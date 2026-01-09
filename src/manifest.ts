import { Database } from "bun:sqlite";
import { join } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Config } from "./config";

export async function generateManifest(
  localPath: string,
  cloudflareConfig?: Config["cloudflare"],
): Promise<{ count: number; path: string; uploaded: boolean } | null> {
  const dbPath = join(localPath, "corpus.db");

  const db = new Database(dbPath, { readonly: true });

  const rows = db
    .query("SELECT id FROM documents WHERE status = 'uploaded' ORDER BY id")
    .all() as { id: string }[];

  db.close();

  if (rows.length === 0) {
    return null;
  }

  const path = join(localPath, "manifest.txt");
  const content = `${rows.map((r) => r.id).join("\n")}\n`;
  await Bun.write(path, content);

  // Upload to R2 if credentials are configured
  let uploaded = false;
  if (cloudflareConfig?.accountId && cloudflareConfig?.r2AccessKeyId) {
    const client = new S3Client({
      region: "auto",
      endpoint: `https://${cloudflareConfig.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: cloudflareConfig.r2AccessKeyId,
        secretAccessKey: cloudflareConfig.r2SecretAccessKey,
      },
    });

    await client.send(
      new PutObjectCommand({
        Bucket: cloudflareConfig.r2BucketName,
        Key: "manifest.txt",
        Body: content,
        ContentType: "text/plain",
      }),
    );
    uploaded = true;
  }

  return { count: rows.length, path, uploaded };
}

// CLI entry point
if (import.meta.main) {
  (async () => {
    const { loadConfig, hasCloudflareCredentials } = await import("./config");
    const config = loadConfig();

    const cloudflareConfig = hasCloudflareCredentials(config)
      ? config.cloudflare
      : undefined;

    const result = await generateManifest(
      config.storage.localPath,
      cloudflareConfig,
    );

    if (!result) {
      console.log("No uploaded documents found.");
      process.exit(0);
    }

    const uploadStatus = result.uploaded ? " (uploaded to R2)" : "";
    console.log(
      `Generated ${result.path} with ${result.count} documents${uploadStatus}`,
    );
  })();
}
