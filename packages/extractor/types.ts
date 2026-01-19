/**
 * Extracted document data from Docling
 */
export interface ExtractedDocument {
  id: string;
  sourcePath: string;
  text: string;
  wordCount: number;
  charCount: number;
  tableCount: number;
  imageCount: number;
  extractedAt: string;
}

/**
 * Configuration for the extraction process
 */
export interface ExtractConfig {
  inputDir: string;
  outputDir: string;
  batchSize: number;
  workers: number;
  resume: boolean;
}

/**
 * Progress tracking for resumable extraction
 */
export interface ExtractionProgress {
  totalFiles: number;
  processedFiles: number;
  successCount: number;
  errorCount: number;
  lastProcessedFile?: string;
  startedAt: string;
  updatedAt: string;
}
