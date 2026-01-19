import { mkdir, rm } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import type { ExtractConfig, ExtractedDocument } from "./types";

const PYTHON_DIR = join(dirname(import.meta.path), "python");
const PYTHON_PATH = join(PYTHON_DIR, ".venv", "bin", "python");
const SCRIPT_PATH = join(PYTHON_DIR, "extract.py");

const INDEX_FILE = "index.jsonl";
const ERRORS_FILE = "errors.jsonl";

export async function processDirectory(
  config: ExtractConfig,
  verbose: boolean = false
): Promise<void> {
  const { storage, inputPrefix, outputPrefix, batchSize } = config;

  // Load index to get already-processed IDs
  const processedIds = await loadProcessedIds(storage, outputPrefix);

  if (processedIds.size > 0) {
    console.log(`Already extracted: ${processedIds.size} documents`);
  }

  // List .docx files, filtering out already-processed ones
  const files: string[] = [];

  console.log(`Scanning ${inputPrefix}/...`);
  for await (const key of storage.list(inputPrefix)) {
    if (key.toLowerCase().endsWith(".docx") && !basename(key).startsWith("~$")) {
      const id = extractIdFromKey(key);
      if (!processedIds.has(id)) {
        files.push(key);
        if (files.length >= batchSize) {
          console.log(`Listed ${files.length} files to process (batch limit)`);
          break;
        }
      }
    }
  }
  files.sort();

  if (files.length === 0) {
    console.log(`No new DOCX files to process in ${inputPrefix}`);
    return;
  }

  console.log(`Found ${files.length} DOCX files to extract`);

  // Create temp directory for processing
  const tempDir = join(tmpdir(), `docx-extract-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });

  let successCount = 0;
  let errorCount = 0;

  try {
    const results = await processBatch(files, storage, tempDir, config.workers, verbose);

    for (const result of results) {
      if (result.success && result.document) {
        // Write text file
        await storage.write(
          `${outputPrefix}/${result.document.id}.txt`,
          result.document.text
        );
        // Append to index (metadata)
        await appendToIndex(storage, outputPrefix, result.document);
        successCount++;
      } else {
        errorCount++;
        await appendError(storage, outputPrefix, result.error || "Unknown error", result.sourceKey);
      }
    }

    console.log(`Processed: ${successCount} success, ${errorCount} errors`);
  } finally {
    // Cleanup temp directory
    await rm(tempDir, { recursive: true, force: true });
  }

  console.log("\nExtraction complete!");
  console.log(`  Output: ${outputPrefix}/{hash}.txt`);
  console.log(`  Index: ${outputPrefix}/${INDEX_FILE}`);
}

interface ProcessResult {
  sourceKey: string;
  success: boolean;
  document?: ExtractedDocument;
  error?: string;
}

async function extractWithPython(
  sourceKey: string,
  localFilePath: string
): Promise<ExtractedDocument> {
  const proc = Bun.spawn([PYTHON_PATH, SCRIPT_PATH, localFilePath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const errorData = stderr ? JSON.parse(stderr) : { error: "Unknown error" };
    throw new Error(errorData.error || "Python extraction failed");
  }

  const result = JSON.parse(stdout);
  const id = extractIdFromKey(sourceKey);

  return {
    id,
    sourceKey,
    text: result.text,
    wordCount: result.wordCount,
    charCount: result.charCount,
    tableCount: result.tableCount,
    imageCount: result.imageCount,
    extractedAt: new Date().toISOString(),
  };
}

async function processBatch(
  keys: string[],
  storage: ExtractConfig["storage"],
  tempDir: string,
  workers: number,
  verbose: boolean
): Promise<ProcessResult[]> {
  const results: ProcessResult[] = [];
  const queue = [...keys];

  const processFile = async (): Promise<void> => {
    while (queue.length > 0) {
      const sourceKey = queue.shift();
      if (!sourceKey) continue;

      try {
        // Download file from storage to temp
        const content = await storage.read(sourceKey);
        if (!content) {
          throw new Error(`File not found: ${sourceKey}`);
        }

        const tempFile = join(tempDir, `${extractIdFromKey(sourceKey)}.docx`);
        await Bun.write(tempFile, content);

        // Extract using Python
        const document = await extractWithPython(sourceKey, tempFile);
        results.push({ sourceKey, success: true, document });

        // Cleanup temp file
        await rm(tempFile, { force: true });

        if (verbose) {
          console.log(`  Extracted: ${basename(sourceKey)} (${document.wordCount} words)`);
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        results.push({ sourceKey, success: false, error });

        if (verbose) {
          console.error(`  Failed: ${basename(sourceKey)}: ${error}`);
        }
      }
    }
  };

  const workerPromises = Array(Math.min(workers, keys.length))
    .fill(null)
    .map(() => processFile());

  await Promise.all(workerPromises);
  return results;
}

function extractIdFromKey(key: string): string {
  // Extract hash from filename: "documents/abc123.docx" → "abc123"
  const filename = basename(key);
  return filename.replace(/\.docx$/i, "");
}

async function appendError(
  storage: ExtractConfig["storage"],
  outputPrefix: string,
  error: string,
  sourceKey: string
): Promise<void> {
  const errorsKey = `${outputPrefix}/${ERRORS_FILE}`;
  const line = JSON.stringify({ sourceKey, error, timestamp: new Date().toISOString() }) + "\n";

  // Read existing errors and append
  const existing = await storage.read(errorsKey);
  const existingText = existing ? new TextDecoder().decode(existing) : "";
  await storage.write(errorsKey, existingText + line);
}

async function loadProcessedIds(
  storage: ExtractConfig["storage"],
  outputPrefix: string
): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const content = await storage.read(`${outputPrefix}/${INDEX_FILE}`);
    if (content) {
      const text = new TextDecoder().decode(content);
      for (const line of text.split("\n")) {
        if (line.trim()) {
          const entry = JSON.parse(line);
          ids.add(entry.id);
        }
      }
    }
  } catch {
    // Index doesn't exist yet, return empty set
  }
  return ids;
}

async function appendToIndex(
  storage: ExtractConfig["storage"],
  outputPrefix: string,
  doc: ExtractedDocument
): Promise<void> {
  const indexKey = `${outputPrefix}/${INDEX_FILE}`;
  const entry = {
    id: doc.id,
    extractedAt: doc.extractedAt,
    wordCount: doc.wordCount,
    charCount: doc.charCount,
    tableCount: doc.tableCount,
    imageCount: doc.imageCount,
  };

  // Read existing index and append
  const existing = await storage.read(indexKey);
  const existingText = existing ? new TextDecoder().decode(existing) : "";
  await storage.write(indexKey, existingText + JSON.stringify(entry) + "\n");
}
