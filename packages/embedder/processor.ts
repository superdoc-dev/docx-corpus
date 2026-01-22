import { GoogleGenAI } from "@google/genai";
import type { EmbedConfig } from "./types";
import { formatProgress, writeMultiLineProgress } from "@docx-corpus/shared";

// Chunking config (same as eval)
const CHUNK_SIZE_CHARS = 6000;
const CHUNK_OVERLAP_CHARS = 200;

// Google API config
const GOOGLE_MODEL = "gemini-embedding-001";
const GOOGLE_DIMENSIONS = 3072;
const API_BATCH_SIZE = 100; // Google supports up to 100 texts per request

// Adaptive rate limiter - adjusts delay based on 429 responses
class RateLimiter {
  private delayMs = 50; // Start at ~20 RPS
  private minDelay = 20;
  private maxDelay = 5000;
  private lastRequest = 0;
  private successCount = 0;

  async wait() {
    const now = Date.now();
    const elapsed = now - this.lastRequest;
    if (elapsed < this.delayMs) {
      await new Promise((r) => setTimeout(r, this.delayMs - elapsed));
    }
    this.lastRequest = Date.now();
  }

  success() {
    this.successCount++;
    // Gradually speed up after 20 successful requests
    if (this.successCount >= 20 && this.delayMs > this.minDelay) {
      this.delayMs = Math.max(this.minDelay, this.delayMs * 0.9);
      this.successCount = 0;
    }
  }

  backoff() {
    this.delayMs = Math.min(this.maxDelay, this.delayMs * 2);
    this.successCount = 0;
  }
}

/**
 * Split text into overlapping chunks for embedding.
 */
function chunkText(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (trimmed.length <= CHUNK_SIZE_CHARS) {
    return [trimmed];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < trimmed.length) {
    const end = Math.min(start + CHUNK_SIZE_CHARS, trimmed.length);
    const chunk = trimmed.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    if (end >= trimmed.length) break;

    const nextStart = end - CHUNK_OVERLAP_CHARS;
    start = nextStart <= start ? start + 1 : nextStart;
  }

  return chunks;
}

/**
 * Combine multiple embeddings using weighted average (weighted by chunk length).
 * Then normalize to unit length.
 */
function weightedAverageEmbeddings(embeddings: number[][], weights: number[]): number[] {
  if (embeddings.length === 1) {
    return embeddings[0];
  }

  const dimensions = embeddings[0].length;
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const result = new Array(dimensions).fill(0);

  for (let i = 0; i < embeddings.length; i++) {
    const weight = weights[i] / totalWeight;
    for (let d = 0; d < dimensions; d++) {
      result[d] += embeddings[i][d] * weight;
    }
  }

  // Normalize to unit length
  const norm = Math.sqrt(result.reduce((sum, val) => sum + val * val, 0));
  if (norm > 0) {
    for (let d = 0; d < dimensions; d++) {
      result[d] /= norm;
    }
  }

  return result;
}

export async function processEmbeddings(config: EmbedConfig, verbose: boolean = false): Promise<void> {
  const { db, storage, inputPrefix, batchSize, concurrency } = config;

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_API_KEY environment variable required");
  }

  // Initialize Google GenAI client and rate limiter
  const ai = new GoogleGenAI({ apiKey });
  const rateLimiter = new RateLimiter();

  // Get embedding stats from database
  const stats = await db.getEmbeddingStats();
  if (stats.embedded > 0 || stats.skipped > 0) {
    console.log(`Already embedded: ${stats.embedded} documents (${stats.skipped} skipped)`);
  }

  // Get unembedded documents from database
  console.log(`Querying database for unembedded documents...`);
  const documents = await db.getUnembeddedDocuments(batchSize);

  if (documents.length === 0) {
    console.log("No new documents to embed");
    return;
  }

  console.log(`Found ${documents.length} documents to embed`);

  let processed = 0;
  let errorCount = 0;

  // Progress tracking
  const startTime = Date.now();
  let lastThroughputUpdate = startTime;
  let docsAtLastUpdate = 0;
  let currentDocsPerSec = 0;
  let prevLineCount = 0;

  const updateProgress = () => {
    const now = Date.now();
    const elapsed = (now - lastThroughputUpdate) / 1000;
    if (elapsed >= 1) {
      currentDocsPerSec = (processed - docsAtLastUpdate) / elapsed;
      lastThroughputUpdate = now;
      docsAtLastUpdate = processed;
    }

    const lines = formatProgress({
      saved: processed,
      total: documents.length,
      docsPerSec: currentDocsPerSec,
      failed: errorCount > 0 ? errorCount : undefined,
      elapsedMs: now - startTime,
    });

    prevLineCount = writeMultiLineProgress(lines, prevLineCount);
  };

  const progressInterval = !verbose ? setInterval(updateProgress, 100) : null;

  /**
   * Embed texts using Google GenAI SDK
   */
  async function embedTexts(texts: string[]): Promise<number[][]> {
    const response = await ai.models.embedContent({
      model: GOOGLE_MODEL,
      contents: texts,
    });

    if (!response.embeddings) {
      throw new Error("No embeddings returned from Google API");
    }

    return response.embeddings.map((e) => e.values || []);
  }

  try {
    // Process documents in batches
    const docBatchSize = 50; // Load docs in batches to fill concurrent API slots

    for (let i = 0; i < documents.length; i += docBatchSize) {
      const batch = documents.slice(i, i + docBatchSize);

      // Load text for each doc and prepare chunks
      const docsWithChunks: { id: string; chunks: string[]; weights: number[] }[] = [];

      for (const doc of batch) {
        try {
          const textContent = await storage.read(`${inputPrefix}/${doc.id}.txt`);
          if (textContent) {
            const text = new TextDecoder().decode(textContent);
            const chunks = chunkText(text);
            if (chunks.length === 0) {
              await db.markEmbeddingSkipped(doc.id, "empty");
              if (verbose) {
                console.log(`  Skipped: ${doc.id} (empty text content)`);
              }
              continue;
            }
            const weights = chunks.map((c) => c.length);
            docsWithChunks.push({ id: doc.id, chunks, weights });
          } else {
            await db.markEmbeddingSkipped(doc.id, "empty");
            if (verbose) {
              console.log(`  Skipped: ${doc.id} (text file not found)`);
            }
          }
        } catch {
          errorCount++;
          if (verbose) {
            console.error(`  Error: ${doc.id} (failed to read text file)`);
          }
        }
      }

      if (docsWithChunks.length === 0) continue;

      // Flatten all chunks for batch embedding
      const allChunks: string[] = [];
      const chunkToDoc: { docIdx: number; chunkIdx: number }[] = [];

      for (let docIdx = 0; docIdx < docsWithChunks.length; docIdx++) {
        const { chunks } = docsWithChunks[docIdx];
        for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
          allChunks.push(chunks[chunkIdx]);
          chunkToDoc.push({ docIdx, chunkIdx });
        }
      }

      // Embed all chunks in API batches (with concurrency)
      const chunkEmbeddings: number[][] = new Array(allChunks.length);

      // Prepare all batch tasks
      const batchTasks: { startIdx: number; chunks: string[] }[] = [];
      for (let j = 0; j < allChunks.length; j += API_BATCH_SIZE) {
        batchTasks.push({
          startIdx: j,
          chunks: allChunks.slice(j, j + API_BATCH_SIZE),
        });
      }

      // Process batch with rate limiting and retry
      const processBatch = async (task: { startIdx: number; chunks: string[] }) => {
        const maxRetries = 5;
        let retries = 0;

        while (retries < maxRetries) {
          await rateLimiter.wait();
          try {
            const embeddings = await embedTexts(task.chunks);
            for (let k = 0; k < embeddings.length; k++) {
              chunkEmbeddings[task.startIdx + k] = embeddings[k];
            }
            rateLimiter.success();
            return;
          } catch (error: unknown) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            const isRetryable =
              errorMsg.includes("429") ||
              errorMsg.includes("rate") ||
              errorMsg.includes("quota") ||
              errorMsg.includes("timeout") ||
              errorMsg.includes("timed out") ||
              errorMsg.includes("TimeoutError");

            if (isRetryable) {
              retries++;
              rateLimiter.backoff();
              if (verbose) {
                const reason = errorMsg.includes("timeout") || errorMsg.includes("timed out") || errorMsg.includes("TimeoutError")
                  ? "timeout"
                  : "rate limited";
                console.log(`  Retrying (${reason}, attempt ${retries}/${maxRetries})...`);
              }
            } else {
              throw error;
            }
          }
        }
        throw new Error(`Failed after ${maxRetries} retries for batch starting at ${task.startIdx}`);
      };

      // Run batches with concurrency limit
      for (let j = 0; j < batchTasks.length; j += concurrency) {
        const concurrentBatches = batchTasks.slice(j, j + concurrency);
        await Promise.all(concurrentBatches.map(processBatch));
      }

      // Combine chunk embeddings per document and save
      for (let docIdx = 0; docIdx < docsWithChunks.length; docIdx++) {
        const { id, chunks, weights } = docsWithChunks[docIdx];

        // Find this doc's chunk embeddings
        const docEmbeddings: number[][] = [];
        for (let ci = 0; ci < chunkToDoc.length; ci++) {
          if (chunkToDoc[ci].docIdx === docIdx) {
            docEmbeddings.push(chunkEmbeddings[ci]);
          }
        }

        const finalEmbedding = weightedAverageEmbeddings(docEmbeddings, weights);

        await db.updateEmbedding({
          id,
          embedding: finalEmbedding,
          embedding_model: "google",
          embedded_at: new Date().toISOString(),
        });

        processed++;

        if (verbose) {
          console.log(`  Embedded: ${id} (${chunks.length} chunks, ${GOOGLE_DIMENSIONS} dims)`);
        }
      }
    }
  } finally {
    if (progressInterval) {
      clearInterval(progressInterval);
      updateProgress();
      console.log();
    }
  }

  console.log(`Embedded: ${processed} documents, ${errorCount} errors`);
}
