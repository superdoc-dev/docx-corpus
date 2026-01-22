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

/**
 * Split text into overlapping chunks for embedding.
 */
function chunkText(text: string): string[] {
  if (text.length <= CHUNK_SIZE_CHARS) {
    return [text];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE_CHARS, text.length);
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    if (end >= text.length) break;

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
  const { db, storage, inputPrefix, batchSize } = config;

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_API_KEY environment variable required");
  }

  // Initialize Google GenAI client
  const ai = new GoogleGenAI({ apiKey });

  // Get embedding stats from database
  const stats = await db.getEmbeddingStats();
  if (stats.embedded > 0) {
    console.log(`Already embedded: ${stats.embedded} documents`);
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
    const docBatchSize = 10; // Load 10 docs at a time from storage

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
            const weights = chunks.map((c) => c.length);
            docsWithChunks.push({ id: doc.id, chunks, weights });
          }
        } catch {
          errorCount++;
          if (verbose) {
            console.error(`  Skipped: ${doc.id} (text file not found)`);
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

      // Embed all chunks in API batches
      const chunkEmbeddings: number[][] = new Array(allChunks.length);

      for (let j = 0; j < allChunks.length; j += API_BATCH_SIZE) {
        const batchChunks = allChunks.slice(j, j + API_BATCH_SIZE);

        let retries = 0;
        const maxRetries = 3;
        while (retries < maxRetries) {
          try {
            const embeddings = await embedTexts(batchChunks);
            for (let k = 0; k < embeddings.length; k++) {
              chunkEmbeddings[j + k] = embeddings[k];
            }
            break;
          } catch (error: unknown) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            if (errorMsg.includes("429") || errorMsg.includes("rate") || errorMsg.includes("quota")) {
              retries++;
              const waitTime = Math.pow(2, retries) * 10;
              if (verbose) {
                console.log(`  Rate limited, waiting ${waitTime}s (retry ${retries}/${maxRetries})...`);
              }
              await new Promise((r) => setTimeout(r, waitTime * 1000));
            } else {
              throw error;
            }
          }
        }
        if (retries >= maxRetries) {
          throw new Error(`Failed after ${maxRetries} retries due to rate limiting`);
        }
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
