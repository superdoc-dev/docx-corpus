import { readdir, mkdir } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import type { ExtractConfig, ExtractedDocument, ExtractionProgress } from "./types";

const PYTHON_DIR = join(dirname(import.meta.path), "python");
const PYTHON_PATH = join(PYTHON_DIR, ".venv", "bin", "python");
const SCRIPT_PATH = join(PYTHON_DIR, "extract.py");

const PROGRESS_FILE = "progress.json";
const ERRORS_FILE = "errors.jsonl";

export async function processDirectory(
  config: ExtractConfig,
  verbose: boolean = false
): Promise<void> {
  await mkdir(config.outputDir, { recursive: true });

  const files = await findDocxFiles(config.inputDir);
  if (files.length === 0) {
    console.log("No DOCX files found in input directory");
    return;
  }

  console.log(`Found ${files.length} DOCX files`);

  const progress = await loadProgress(config);
  const startIndex = config.resume ? progress.processedFiles : 0;

  if (config.resume && startIndex > 0) {
    console.log(`Resuming from file ${startIndex + 1}`);
  }

  progress.totalFiles = files.length;
  progress.startedAt = progress.startedAt || new Date().toISOString();

  const outputPath = join(config.outputDir, "documents.jsonl");
  const outputFile = Bun.file(outputPath);
  const writer = outputFile.writer();

  const batches = chunkArray(files.slice(startIndex), config.batchSize);
  let totalProcessed = startIndex;

  for (const batch of batches) {
    const results = await processBatch(batch, config.workers, verbose);

    for (const result of results) {
      if (result.success && result.document) {
        writer.write(JSON.stringify(result.document) + "\n");
        progress.successCount++;
      } else {
        progress.errorCount++;
        await appendError(config.outputDir, result.error || "Unknown error", result.filePath);
      }
    }

    totalProcessed += batch.length;
    progress.processedFiles = totalProcessed;
    progress.lastProcessedFile = batch[batch.length - 1];
    progress.updatedAt = new Date().toISOString();

    await saveProgress(config.outputDir, progress);

    const percent = ((totalProcessed / files.length) * 100).toFixed(1);
    console.log(
      `Progress: ${totalProcessed}/${files.length} (${percent}%) - ` +
        `Success: ${progress.successCount}, Errors: ${progress.errorCount}`
    );
  }

  await writer.end();

  console.log("\nExtraction complete!");
  console.log(`  Total: ${files.length}`);
  console.log(`  Success: ${progress.successCount}`);
  console.log(`  Errors: ${progress.errorCount}`);
  console.log(`  Output: ${outputPath}`);
}

interface ProcessResult {
  filePath: string;
  success: boolean;
  document?: ExtractedDocument;
  error?: string;
}

async function extractWithPython(filePath: string): Promise<ExtractedDocument> {
  const proc = Bun.spawn([PYTHON_PATH, SCRIPT_PATH, filePath], {
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
  const id = generateId(filePath);

  return {
    id,
    sourcePath: filePath,
    text: result.text,
    wordCount: result.wordCount,
    charCount: result.charCount,
    tableCount: result.tableCount,
    imageCount: result.imageCount,
    extractedAt: new Date().toISOString(),
  };
}

async function processBatch(
  files: string[],
  workers: number,
  verbose: boolean
): Promise<ProcessResult[]> {
  const results: ProcessResult[] = [];
  const queue = [...files];

  const processFile = async (): Promise<void> => {
    while (queue.length > 0) {
      const filePath = queue.shift();
      if (!filePath) continue;

      try {
        const document = await extractWithPython(filePath);
        results.push({ filePath, success: true, document });

        if (verbose) {
          console.log(`  Extracted: ${basename(filePath)} (${document.wordCount} words)`);
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        results.push({ filePath, success: false, error });

        if (verbose) {
          console.error(`  Failed: ${basename(filePath)}: ${error}`);
        }
      }
    }
  };

  const workerPromises = Array(Math.min(workers, files.length))
    .fill(null)
    .map(() => processFile());

  await Promise.all(workerPromises);
  return results;
}

async function findDocxFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function scan(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        await scan(fullPath);
      } else if (
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".docx") &&
        !entry.name.startsWith("~$")
      ) {
        files.push(fullPath);
      }
    }
  }

  await scan(dir);
  return files.sort();
}

function generateId(filePath: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(filePath);
  return hasher.digest("hex").slice(0, 16);
}

async function loadProgress(config: ExtractConfig): Promise<ExtractionProgress> {
  const progressPath = join(config.outputDir, PROGRESS_FILE);

  try {
    const file = Bun.file(progressPath);
    if (await file.exists()) {
      return await file.json();
    }
  } catch {
    // Ignore errors, return fresh progress
  }

  return {
    totalFiles: 0,
    processedFiles: 0,
    successCount: 0,
    errorCount: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function saveProgress(outputDir: string, progress: ExtractionProgress): Promise<void> {
  const progressPath = join(outputDir, PROGRESS_FILE);
  await Bun.write(progressPath, JSON.stringify(progress, null, 2));
}

async function appendError(outputDir: string, error: string, filePath: string): Promise<void> {
  const errorsPath = join(outputDir, ERRORS_FILE);
  const line = JSON.stringify({ filePath, error, timestamp: new Date().toISOString() }) + "\n";

  const file = Bun.file(errorsPath);
  const existing = (await file.exists()) ? await file.text() : "";
  await Bun.write(errorsPath, existing + line);
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}
