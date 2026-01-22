import { mkdir, rm } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import type { ExtractConfig, ExtractedDocument } from "./types";
import { formatProgress, writeMultiLineProgress, type DocumentRecord } from "@docx-corpus/shared";

const PYTHON_DIR = join(dirname(import.meta.path), "python");
const PYTHON_PATH = join(PYTHON_DIR, ".venv", "bin", "python");
const SCRIPT_PATH = join(PYTHON_DIR, "extract_server.py");

/**
 * Persistent Python extraction worker.
 * Spawns one Python process and communicates via stdin/stdout JSON lines.
 */
class PersistentExtractor {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private stdin: ReturnType<typeof Bun.spawn>["stdin"] | null = null;
  private initialized = false;
  private readBuffer = "";
  private stdoutReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private decoder = new TextDecoder();

  async start(): Promise<void> {
    this.proc = Bun.spawn([PYTHON_PATH, SCRIPT_PATH], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });

    const stdout = this.proc.stdout;
    this.stdin = this.proc.stdin;

    if (!stdout || typeof stdout === "number") {
      throw new Error("Failed to get stdout pipe from Python process");
    }
    if (!this.stdin || typeof this.stdin === "number") {
      throw new Error("Failed to get stdin pipe from Python process");
    }

    // Get reader for stdout
    this.stdoutReader = (stdout as ReadableStream<Uint8Array>).getReader();

    // Wait for "ready" signal (imports complete)
    const readyLine = await this.readLine();
    const ready = JSON.parse(readyLine);
    if (!ready.ready) {
      throw new Error("Python extractor failed to signal ready");
    }

    // Wait for "initialized" signal (converter created)
    const initLine = await this.readLine();
    const init = JSON.parse(initLine);
    if (!init.initialized) {
      throw new Error("Python extractor failed to initialize converter");
    }

    this.initialized = true;
  }

  private async readLine(): Promise<string> {
    if (!this.stdoutReader) throw new Error("Reader not initialized");

    while (true) {
      // Check if we already have a complete line in the buffer
      const newlineIndex = this.readBuffer.indexOf("\n");
      if (newlineIndex !== -1) {
        const line = this.readBuffer.slice(0, newlineIndex);
        this.readBuffer = this.readBuffer.slice(newlineIndex + 1);
        return line;
      }

      // Read more data
      const { value, done } = await this.stdoutReader.read();
      if (done) throw new Error("Python process closed unexpectedly");

      this.readBuffer += this.decoder.decode(value, { stream: true });
    }
  }

  async extract(filePath: string): Promise<{
    success: boolean;
    text?: string;
    wordCount?: number;
    charCount?: number;
    tableCount?: number;
    imageCount?: number;
    language?: string;
    languageConfidence?: number;
    extraction?: any;
    error?: string;
  }> {
    if (!this.initialized || !this.stdin || typeof this.stdin === "number") {
      throw new Error("Extractor not initialized");
    }

    // Send file path to Python using Bun's FileSink
    (this.stdin as { write: (data: string) => number }).write(filePath + "\n");

    // Read JSON response
    const responseLine = await this.readLine();
    return JSON.parse(responseLine);
  }

  async stop(): Promise<void> {
    if (this.stdin && typeof this.stdin !== "number") {
      (this.stdin as { end: () => void }).end();
      this.stdin = null;
    }
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.initialized = false;
    this.readBuffer = "";
    this.stdoutReader = null;
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }
}

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
const STALL_TIMEOUT_MS = 60_000; // 1 minute without progress

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

  // Atomic queue retrieval to avoid race conditions
  const getNextDocument = (): DocumentRecord | undefined => queue.shift();

  // Progress tracking (only used when not verbose)
  const startTime = Date.now();
  let lastThroughputUpdate = startTime;
  let docsAtLastUpdate = 0;
  let currentDocsPerSec = 0;
  let prevLineCount = 0;

  // Stall detection - track when last progress was made
  let lastProgressTime = Date.now();
  let stalled = false;

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

  // Start pool of persistent Python extractors (one per worker)
  const numWorkers = Math.min(workers, documents.length);
  const extractors: PersistentExtractor[] = [];

  console.log(`Starting ${numWorkers} persistent Python extractor(s)...`);
  for (let i = 0; i < numWorkers; i++) {
    const extractor = new PersistentExtractor();
    await extractor.start();
    extractors.push(extractor);
  }
  console.log(`${numWorkers} extractor(s) ready, processing documents...`);

  // Process a single document with timeout covering all operations
  const processDocument = async (
    doc: DocumentRecord,
    extractor: PersistentExtractor
  ): Promise<{ success: boolean; needsRestart: boolean }> => {
    const sourceKey = `${inputPrefix}/${doc.id}.docx`;

    // Download file from storage to temp
    const content = await storage.read(sourceKey);
    if (!content) {
      throw new Error(`File not found: ${sourceKey}`);
    }

    const tempFile = join(tempDir, `${doc.id}.docx`);
    await Bun.write(tempFile, content);

    // Extract using persistent Python worker
    const result = await extractor.extract(tempFile);

    if (!result.success) {
      throw new Error(result.error || "Extraction failed");
    }

    // Write text file to storage
    await storage.write(`${outputPrefix}/${doc.id}.txt`, result.text!);

    // Write extraction JSON to storage
    await storage.write(
      `${outputPrefix}/${doc.id}.json`,
      JSON.stringify(result.extraction)
    );

    // Update database with extraction metadata
    await db.updateExtraction({
      id: doc.id,
      word_count: result.wordCount!,
      char_count: result.charCount!,
      table_count: result.tableCount!,
      image_count: result.imageCount!,
      language: result.language || "unknown",
      language_confidence: result.languageConfidence || 0,
      extracted_at: new Date().toISOString(),
    });

    // Cleanup temp file
    await rm(tempFile, { force: true });

    if (verbose) {
      console.log(`  Extracted: ${doc.id} (${result.wordCount} words)`);
    }

    return { success: true, needsRestart: false };
  };

  // Worker function - each worker uses its own extractor
  const processWorker = async (extractor: PersistentExtractor): Promise<void> => {
    let doc: DocumentRecord | undefined;
    while ((doc = getNextDocument()) && !stalled) {
      const currentDoc = doc; // Capture for closure
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      try {
        // Wrap entire document processing with timeout
        const processPromise = processDocument(currentDoc, extractor);
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`Document processing timed out after ${EXTRACTION_TIMEOUT_MS / 1000}s`));
          }, EXTRACTION_TIMEOUT_MS);
        });

        await Promise.race([processPromise, timeoutPromise]);

        // Clear timeout on success
        if (timeoutId) clearTimeout(timeoutId);

        successCount++;
        lastProgressTime = Date.now();
      } catch (err) {
        // Clear timeout on error
        if (timeoutId) clearTimeout(timeoutId);

        const error = err instanceof Error ? err.message : String(err);

        // Restart Python process after timeout to restore clean state
        if (error.includes("timed out")) {
          try {
            await extractor.restart();
          } catch {
            // If restart fails, continue with potentially broken extractor
          }
        }

        // Update database with error (with its own timeout)
        try {
          const dbPromise = db.updateExtractionError(currentDoc.id, error);
          const dbTimeout = new Promise<void>((resolve) => {
            setTimeout(resolve, 5000); // 5s timeout for DB update
          });
          await Promise.race([dbPromise, dbTimeout]);
        } catch {
          // Ignore DB errors during error handling
        }

        errorCount++;
        lastProgressTime = Date.now();

        if (verbose) {
          console.error(`  Failed: ${currentDoc.id}: ${error}`);
        }
      }
    }
  };

  // Stall detection interval - check if no progress for too long
  const stallCheckInterval = setInterval(async () => {
    const timeSinceProgress = Date.now() - lastProgressTime;
    const totalProcessed = successCount + errorCount;
    // Check if stalled: no progress for too long AND we haven't finished all documents
    if (timeSinceProgress > STALL_TIMEOUT_MS && totalProcessed < documents.length) {
      console.error(`\nStall detected: no progress for ${STALL_TIMEOUT_MS / 1000}s, restarting extractors...`);
      stalled = true;

      // Force restart all extractors
      await Promise.all(extractors.map(async (e) => {
        try {
          await e.restart();
        } catch {
          // Ignore restart errors
        }
      }));

      stalled = false;
      lastProgressTime = Date.now();
    }
  }, 10_000); // Check every 10 seconds

  try {
    // Run all workers in parallel, each with its own extractor
    await Promise.all(extractors.map(extractor => processWorker(extractor)));
  } finally {
    // Always stop all extractors and clear intervals
    clearInterval(stallCheckInterval);
    await Promise.all(extractors.map(e => e.stop()));
  }

  // Clean up progress display
  if (progressInterval) {
    clearInterval(progressInterval);
    updateProgress(); // Final update
    console.log(); // Move to next line
  }

  return { successCount, errorCount };
}
