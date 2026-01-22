import type { DbClient, Storage } from "@docx-corpus/shared";

/**
 * Supported embedding models
 */
export type EmbeddingModel = "google";

/**
 * Embedded document with vector
 */
export interface EmbeddedDocument {
  id: string;
  embedding: number[];
  model: EmbeddingModel;
  dimensions: number;
  embeddedAt: string;
}

/**
 * Configuration for the embedding process
 */
export interface EmbedConfig {
  db: DbClient;
  storage: Storage;
  inputPrefix: string;
  model: EmbeddingModel;
  batchSize: number;
}
