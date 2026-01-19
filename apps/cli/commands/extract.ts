import {
  processDirectory,
  loadExtractorConfig,
  hasCloudflareCredentials,
  type ExtractConfig,
} from "@docx-corpus/extractor";
import { createLocalStorage, createR2Storage } from "@docx-corpus/shared";

interface ParsedFlags {
  batchSize?: number;
  workers?: number;
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
      case "--workers":
      case "-w":
        flags.workers = parseInt(next || "", 10);
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
corpus extract - Extract text from DOCX files using Docling

Usage
  corpus extract [options]

Storage is auto-selected based on environment:
  - With R2 credentials: reads from r2://documents/, writes to r2://extracted/
  - Without R2 credentials: reads from ./corpus/documents/, writes to ./corpus/extracted/

Already-extracted files are automatically skipped (tracked in index.jsonl).

Options
  --batch, -b <n>         Limit to n documents (default: all)
  --workers, -w <n>       Number of parallel workers (default: from EXTRACT_WORKERS or 4)
  --verbose, -v           Show detailed progress
  --help, -h              Show this help

Environment Variables
  STORAGE_PATH            Local storage path (default: ./corpus)
  CLOUDFLARE_ACCOUNT_ID   Cloudflare account ID (enables R2)
  R2_ACCESS_KEY_ID        R2 access key
  R2_SECRET_ACCESS_KEY    R2 secret key
  R2_BUCKET_NAME          R2 bucket (default: docx-corpus)
  EXTRACT_INPUT_PREFIX    Input prefix (default: documents)
  EXTRACT_OUTPUT_PREFIX   Output prefix (default: extracted)
  EXTRACT_WORKERS         Worker count (default: 4)

Examples
  corpus extract                    # Extract all documents
  corpus extract -b 100             # Limit to 100 documents
  corpus extract -v                 # With verbose output
  corpus extract -b 50 -w 8         # Custom batch/workers
`;

export async function runExtract(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }

  const flags = parseFlags(args);
  const envConfig = loadExtractorConfig();
  const useCloud = hasCloudflareCredentials(envConfig);

  // Create storage based on credentials
  const storage = useCloud
    ? createR2Storage({
        accountId: envConfig.cloudflare.accountId,
        accessKeyId: envConfig.cloudflare.r2AccessKeyId,
        secretAccessKey: envConfig.cloudflare.r2SecretAccessKey,
        bucket: envConfig.cloudflare.r2BucketName,
      })
    : createLocalStorage(envConfig.storage.localPath);

  const config: ExtractConfig = {
    storage,
    inputPrefix: envConfig.extract.inputPrefix,
    outputPrefix: envConfig.extract.outputPrefix,
    batchSize: flags.batchSize ?? Infinity,
    workers: flags.workers ?? envConfig.extract.workers,
  };

  console.log("Text Extractor");
  console.log("==============");
  console.log(
    `Storage: ${useCloud ? `R2 (${envConfig.cloudflare.r2BucketName})` : `local (${envConfig.storage.localPath})`}`
  );
  console.log(`Input:   ${config.inputPrefix}/`);
  console.log(`Output:  ${config.outputPrefix}/`);
  console.log(`Workers: ${config.workers}`);
  console.log(`Batch:   ${config.batchSize === Infinity ? "all" : config.batchSize}`);
  console.log("");

  try {
    await processDirectory(config, flags.verbose);
  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
}
