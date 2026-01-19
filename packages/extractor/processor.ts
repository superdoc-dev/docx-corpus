import { mkdir, rm } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import type { ExtractConfig, ExtractedDocument } from "./types";
import { formatProgress, writeMultiLineProgress } from "@docx-corpus/shared";

const PYTHON_DIR = join(dirname(import.meta.path), "python");
const PYTHON_PATH = join(PYTHON_DIR, ".venv", "bin", "python");
const SCRIPT_PATH = join(PYTHON_DIR, "extract.py");

const INDEX_FILE = "index.jsonl";

export async function processDirectory(
  config: ExtractConfig,
  verbose: boolean = false
): Promise<void> {
  const { storage, inputPrefix, outputPrefix, batchSize } = config;

  // Load index to get already-processed IDs and existing errors
  const indexState = await loadIndexState(storage, outputPrefix);

  if (indexState.successIds.size > 0) {
    console.log(`Already extracted: ${indexState.successIds.size} documents`);
  }
  if (indexState.errorIds.size > 0) {
    console.log(`Previous errors: ${indexState.errorIds.size} documents (will retry)`);
  }

  // List .docx files, filtering out already-processed ones
  const files: string[] = [];

  console.log(`Scanning ${inputPrefix}/...`);
  for await (const key of storage.list(inputPrefix)) {
    if (key.toLowerCase().endsWith(".docx") && !basename(key).startsWith("~$")) {
      const id = extractIdFromKey(key);
      if (!indexState.successIds.has(id)) {
        files.push(key);
        if (batchSize !== Infinity && files.length >= batchSize) {
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

  try {
    const { successCount, errorCount } = await processBatch(
      files,
      storage,
      outputPrefix,
      tempDir,
      config.workers,
      verbose,
      indexState.errorIds
    );

    console.log(`Processed: ${successCount} success, ${errorCount} errors`);
  } finally {
    // Cleanup temp directory
    await rm(tempDir, { recursive: true, force: true });
  }

  console.log("\nExtraction complete!");
  console.log(`  Output: ${outputPrefix}/{hash}.txt`);
  console.log(`  Index: ${outputPrefix}/${INDEX_FILE}`);
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
  outputPrefix: string,
  tempDir: string,
  workers: number,
  verbose: boolean,
  existingErrorIds: Set<string>
): Promise<{ successCount: number; errorCount: number }> {
  let successCount = 0;
  let errorCount = 0;
  const queue = [...keys];

  // Progress tracking (only used when not verbose)
  const startTime = Date.now();
  let lastThroughputUpdate = startTime;
  let docsAtLastUpdate = 0;
  let currentDocsPerSec = 0;
  let prevLineCount = 0;

  const updateProgress = () => {
    const now = Date.now();
    const elapsed = (now - lastThroughputUpdate) / 1000;
    if (elapsed >= 1) {
      currentDocsPerSec = (successCount + errorCount - docsAtLastUpdate) / elapsed;
      lastThroughputUpdate = now;
      docsAtLastUpdate = successCount + errorCount;
    }

    const lines = formatProgress({
      saved: successCount + errorCount,
      total: keys.length,
      docsPerSec: currentDocsPerSec,
      failed: errorCount > 0 ? errorCount : undefined,
      elapsedMs: now - startTime,
    });

    prevLineCount = writeMultiLineProgress(lines, prevLineCount);
  };

  const progressInterval = !verbose ? setInterval(updateProgress, 100) : null;

  const processFile = async (): Promise<void> => {
    while (queue.length > 0) {
      const sourceKey = queue.shift();
      if (!sourceKey) continue;

      const id = extractIdFromKey(sourceKey);

      try {
        // Download file from storage to temp
        const content = await storage.read(sourceKey);
        if (!content) {
          throw new Error(`File not found: ${sourceKey}`);
        }

        const tempFile = join(tempDir, `${id}.docx`);
        await Bun.write(tempFile, content);

        // Extract using Python
        const document = await extractWithPython(sourceKey, tempFile);

        // Write text file immediately
        await storage.write(`${outputPrefix}/${document.id}.txt`, document.text);
        // Append to index immediately
        await appendToIndex(storage, outputPrefix, document);
        successCount++;

        // Cleanup temp file
        await rm(tempFile, { force: true });

        if (verbose) {
          console.log(`  Extracted: ${basename(sourceKey)} (${document.wordCount} words)`);
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        // Only append error if not already recorded
        if (!existingErrorIds.has(id)) {
          await appendError(storage, outputPrefix, error, sourceKey);
          existingErrorIds.add(id); // Track in-flight errors too
        }
        errorCount++;

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

  // Clean up progress display
  if (progressInterval) {
    clearInterval(progressInterval);
    updateProgress(); // Final update
    console.log(); // Move to next line
  }

  return { successCount, errorCount };
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
  const indexKey = `${outputPrefix}/${INDEX_FILE}`;
  const id = extractIdFromKey(sourceKey);
  const line = JSON.stringify({ id, error, extractedAt: new Date().toISOString() }) + "\n";

  // Read existing index and append
  const existing = await storage.read(indexKey);
  const existingText = existing ? new TextDecoder().decode(existing) : "";
  await storage.write(indexKey, existingText + line);
}

interface IndexState {
  successIds: Set<string>;
  errorIds: Set<string>;
}

async function loadIndexState(
  storage: ExtractConfig["storage"],
  outputPrefix: string
): Promise<IndexState> {
  const successIds = new Set<string>();
  const errorIds = new Set<string>();
  try {
    const content = await storage.read(`${outputPrefix}/${INDEX_FILE}`);
    if (content) {
      const text = new TextDecoder().decode(content);
      for (const line of text.split("\n")) {
        if (line.trim()) {
          const entry = JSON.parse(line);
          if (entry.error) {
            errorIds.add(entry.id);
          } else {
            successIds.add(entry.id);
          }
        }
      }
    }
  } catch {
    // Index doesn't exist yet, return empty sets
  }
  return { successIds, errorIds };
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
