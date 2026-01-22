import {
  processEmbeddings,
  loadEmbedderConfig,
  hasCloudflareCredentials,
  hasGoogleCredentials,
  type EmbedConfig,
} from "@docx-corpus/embedder";
import { createDb, createLocalStorage, createR2Storage } from "@docx-corpus/shared";

interface ParsedFlags {
  batchSize?: number;
  verbose: boolean;
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = {
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "--batch":
      case "-b":
        flags.batchSize = parseInt(next || "", 10);
        i++;
        break;
      case "--verbose":
      case "-v":
        flags.verbose = true;
        break;
    }
  }

  return flags;
}

const HELP = `
corpus embed - Generate embeddings for extracted documents

Usage
  corpus embed [options]

Reads extracted text from storage and writes embeddings to the database.
Storage is auto-selected based on environment:
  - With R2 credentials: reads from r2://extracted/
  - Without R2 credentials: reads from ./corpus/extracted/

Embedding progress is tracked in the database (embedded_at column).

Model
  Uses Google's gemini-embedding-001 (3072 dimensions, ~$0.006/1M tokens)
  Documents are chunked (6000 chars) and embeddings are combined via weighted average.

Options
  --batch, -b <n>         Limit to n documents (default: all)
  --verbose, -v           Show detailed progress
  --help, -h              Show this help

Environment Variables
  DATABASE_URL            PostgreSQL connection string (required)
  GOOGLE_API_KEY          Google AI API key (required)
  STORAGE_PATH            Local storage path (default: ./corpus)
  CLOUDFLARE_ACCOUNT_ID   Cloudflare account ID (enables R2)
  R2_ACCESS_KEY_ID        R2 access key
  R2_SECRET_ACCESS_KEY    R2 secret key
  R2_BUCKET_NAME          R2 bucket (default: docx-corpus)
  EMBED_INPUT_PREFIX      Input prefix (default: extracted)

Examples
  corpus embed                        # Embed all documents
  corpus embed -b 100 -v              # Limit to 100, verbose output
`;

export async function runEmbed(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }

  const flags = parseFlags(args);
  const envConfig = loadEmbedderConfig();

  // Validate database URL
  if (!envConfig.database.url) {
    console.error("Error: DATABASE_URL environment variable is required");
    process.exit(1);
  }

  // Validate Google API key
  if (!hasGoogleCredentials(envConfig)) {
    console.error("Error: GOOGLE_API_KEY environment variable is required");
    process.exit(1);
  }

  const useCloud = hasCloudflareCredentials(envConfig);

  // Create database client
  const db = await createDb(envConfig.database.url);

  // Create storage based on credentials
  const storage = useCloud
    ? createR2Storage({
        accountId: envConfig.cloudflare.accountId,
        accessKeyId: envConfig.cloudflare.r2AccessKeyId,
        secretAccessKey: envConfig.cloudflare.r2SecretAccessKey,
        bucket: envConfig.cloudflare.r2BucketName,
      })
    : createLocalStorage(envConfig.storage.localPath);

  const config: EmbedConfig = {
    db,
    storage,
    inputPrefix: envConfig.embed.inputPrefix,
    model: "google",
    batchSize: flags.batchSize ?? 1000000,
  };

  console.log("Document Embedder");
  console.log("=================");
  console.log(
    `Storage: ${useCloud ? `R2 (${envConfig.cloudflare.r2BucketName})` : `local (${envConfig.storage.localPath})`}`
  );
  console.log(`Input:   ${config.inputPrefix}/`);
  console.log(`Output:  database (embedding column)`);
  console.log(`Model:   gemini-embedding-001 (3072 dims)`);
  console.log(`Batch:   ${config.batchSize >= 1000000 ? "all" : config.batchSize}`);
  console.log("");

  try {
    await processEmbeddings(config, flags.verbose);
  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  } finally {
    await db.close();
  }
}
