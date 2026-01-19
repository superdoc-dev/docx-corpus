import { SQL } from "bun";
import { join } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Config } from "./config";

export async function generateManifest(
  databaseUrl: string,
  localPath: string,
  cloudflareConfig?: Config["cloudflare"],
): Promise<{ count: number; path: string; uploaded: boolean } | null> {
  const sql = new SQL({ url: databaseUrl });

  const rows = await sql<{ id: string }[]>`
    SELECT id FROM documents WHERE status = 'uploaded' ORDER BY id
  `;

  await sql.close();

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
