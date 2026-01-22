import type { DbClient, Storage } from "@docx-corpus/shared";

/**
 * Extracted document data from Docling
 */
export interface ExtractedDocument {
  id: string;
  sourceKey: string;
  text: string;
  wordCount: number;
  charCount: number;
  tableCount: number;
  imageCount: number;
  language: string;
  languageConfidence: number;
  extraction: Record<string, unknown>;
  extractedAt: string;
}

/**
 * Configuration for the extraction process
 */
export interface ExtractConfig {
  db: DbClient;
  storage: Storage;
  inputPrefix: string;
  outputPrefix: string;
  batchSize: number;
  workers: number;
}
