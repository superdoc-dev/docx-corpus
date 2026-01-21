import { mkdir, rm } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import type { ExtractConfig, ExtractedDocument } from "./types";
import { formatProgress, writeMultiLineProgress, type DocumentRecord } from "@docx-corpus/shared";

const PYTHON_DIR = join(dirname(import.meta.path), "python");
const PYTHON_PATH = join(PYTHON_DIR, ".venv", "bin", "python");
const SCRIPT_PATH = join(PYTHON_DIR, "extract.py");

export async function processDirectory(
  config: ExtractConfig,
  verbose: boolean = false
): Promise<void> {
  const { db, storage, inputPrefix, outputPrefix, batchSize } = config;

  // Get extraction stats from database
  const stats = await db.getExtractionStats();
  if (stats.extracted > 0) {
    console.log(`Already extracted: ${stats.extracted} documents`);
  }
  if (stats.errors > 0) {
    console.log(`Previous errors: ${stats.errors} documents`);
  }

  // Get unextracted documents from database
  console.log(`Querying database for unextracted documents...`);
  const documents = await db.getUnextractedDocuments(batchSize);

  if (documents.length === 0) {
    console.log(`No unextracted documents found`);
    return;
  }

  console.log(`Found ${documents.length} documents to extract`);

  // Create temp directory for processing
  const tempDir = join(tmpdir(), `docx-extract-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });

  try {
    const { successCount, errorCount } = await processBatch(
      documents,
      config,
      tempDir,
      verbose
    );

    console.log(`Processed: ${successCount} success, ${errorCount} errors`);
  } finally {
    // Cleanup temp directory
    await rm(tempDir, { recursive: true, force: true });
  }

  console.log("\nExtraction complete!");
  console.log(`  Output: ${outputPrefix}/{hash}.txt, ${outputPrefix}/{hash}.json`);
}

const EXTRACTION_TIMEOUT_MS = 30_000; // 30 seconds per document

async function extractWithPython(
  doc: DocumentRecord,
  localFilePath: string
): Promise<ExtractedDocument> {
  const proc = Bun.spawn([PYTHON_PATH, SCRIPT_PATH, localFilePath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const extractionPromise = (async () => {
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  })();

  let timeoutId: Timer;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      proc.kill();
      reject(new Error(`Extraction timed out after ${EXTRACTION_TIMEOUT_MS / 1000}s`));
    }, EXTRACTION_TIMEOUT_MS);
  });

  try {
    var { stdout, stderr, exitCode } = await Promise.race([
      extractionPromise,
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timeoutId!);
  }

  if (exitCode !== 0) {
    const errorData = stderr ? JSON.parse(stderr) : { error: "Unknown error" };
    throw new Error(errorData.error || "Python extraction failed");
  }

  const result = JSON.parse(stdout);

  return {
    id: doc.id,
    sourceKey: `documents/${doc.id}.docx`,
    text: result.text,
    wordCount: result.wordCount,
    charCount: result.charCount,
    tableCount: result.tableCount,
    imageCount: result.imageCount,
    extraction: result.extraction,
    extractedAt: new Date().toISOString(),
  };
}

async function processBatch(
  documents: DocumentRecord[],
  config: ExtractConfig,
  tempDir: string,
  verbose: boolean
): Promise<{ successCount: number; errorCount: number }> {
  const { db, storage, inputPrefix, outputPrefix, workers } = config;
  let successCount = 0;
  let errorCount = 0;
  const queue = [...documents];

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
      total: documents.length,
      docsPerSec: currentDocsPerSec,
      failed: errorCount > 0 ? errorCount : undefined,
      elapsedMs: now - startTime,
    });

    prevLineCount = writeMultiLineProgress(lines, prevLineCount);
  };

  const progressInterval = !verbose ? setInterval(updateProgress, 100) : null;

  const processFile = async (): Promise<void> => {
    while (queue.length > 0) {
      const doc = queue.shift();
      if (!doc) continue;

      const sourceKey = `${inputPrefix}/${doc.id}.docx`;

      try {
        // Download file from storage to temp
        const content = await storage.read(sourceKey);
        if (!content) {
          throw new Error(`File not found: ${sourceKey}`);
        }

        const tempFile = join(tempDir, `${doc.id}.docx`);
        await Bun.write(tempFile, content);

        // Extract using Python
        const extracted = await extractWithPython(doc, tempFile);

        // Write text file to storage
        await storage.write(`${outputPrefix}/${doc.id}.txt`, extracted.text);

        // Write extraction JSON to storage
        await storage.write(
          `${outputPrefix}/${doc.id}.json`,
          JSON.stringify(extracted.extraction)
        );

        // Update database with extraction metadata
        await db.updateExtraction({
          id: doc.id,
          word_count: extracted.wordCount,
          char_count: extracted.charCount,
          table_count: extracted.tableCount,
          image_count: extracted.imageCount,
          extracted_at: extracted.extractedAt,
        });

        successCount++;

        // Cleanup temp file
        await rm(tempFile, { force: true });

        if (verbose) {
          console.log(`  Extracted: ${doc.id} (${extracted.wordCount} words)`);
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);

        // Update database with error
        await db.updateExtractionError(doc.id, error);
        errorCount++;

        if (verbose) {
          console.error(`  Failed: ${doc.id}: ${error}`);
        }
      }
    }
  };

  const workerPromises = Array(Math.min(workers, documents.length))
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
