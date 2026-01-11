import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { createGunzip } from "zlib";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Common Crawl S3 - uses Lambda's IAM role credentials (authenticated access)
const ccClient = new S3Client({
  region: "us-east-1",
});

// R2 client
const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

class LineSplitter extends Transform {
  private buffer = "";

  _transform(chunk: Buffer, _: string, cb: () => void) {
    this.buffer += chunk.toString("utf8");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.includes(DOCX_MIME)) {
        const jsonStart = line.indexOf("{");
        if (jsonStart === -1) continue;
        try {
          const r = JSON.parse(line.slice(jsonStart));
          if (r.status === "200") {
            this.push(line.slice(jsonStart) + "\n");
          }
        } catch {
          // Skip malformed lines
        }
      }
    }
    cb();
  }

  _flush(cb: () => void) {
    if (this.buffer && this.buffer.includes(DOCX_MIME)) {
      const jsonStart = this.buffer.indexOf("{");
      if (jsonStart !== -1) {
        try {
          const r = JSON.parse(this.buffer.slice(jsonStart));
          if (r.status === "200") {
            this.push(this.buffer.slice(jsonStart) + "\n");
          }
        } catch {
          // Skip malformed lines
        }
      }
    }
    cb();
  }
}

interface LambdaEvent {
  cdxPath: string;
  crawlId: string;
}

interface LambdaResponse {
  statusCode: number;
  body: string;
}

export async function handler(event: LambdaEvent): Promise<LambdaResponse> {
  const { cdxPath, crawlId } = event;
  const filename = cdxPath.split("/").pop()?.replace(".gz", "") || "unknown";

  console.log(`Processing: ${cdxPath}`);

  // Fetch from Common Crawl S3 (authenticated, no rate limits)
  const response = await ccClient.send(
    new GetObjectCommand({
      Bucket: "commoncrawl",
      Key: cdxPath,
    })
  );

  if (!response.Body) {
    throw new Error("No body in S3 response");
  }

  const chunks: Buffer[] = [];
  const splitter = new LineSplitter();
  splitter.on("data", (c: Buffer) => chunks.push(c));

  await pipeline(response.Body as Readable, createGunzip(), splitter);

  const output = Buffer.concat(chunks);
  const outputKey = `cdx-filtered/${crawlId}/${filename}.jsonl`;
  const count = output
    .toString()
    .split("\n")
    .filter((l) => l.trim()).length;

  console.log(`Found ${count} docx records`);

  await r2Client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: outputKey,
      Body: output,
      ContentType: "application/x-ndjson",
    })
  );

  console.log(`Uploaded to: ${outputKey}`);

  return {
    statusCode: 200,
    body: JSON.stringify({ cdxPath, outputKey, count }),
  };
}
