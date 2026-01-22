-- Migration: Add extraction, embedding, and classification columns
-- Run this on existing databases to add the new columns

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add extraction metadata columns
ALTER TABLE documents ADD COLUMN IF NOT EXISTS extracted_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS word_count INTEGER;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS char_count INTEGER;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS table_count INTEGER;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS image_count INTEGER;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS extraction_error TEXT;

-- Add embedding columns
ALTER TABLE documents ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS embedding_model VARCHAR(50);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS embedding vector(3072);

-- Add classification columns
ALTER TABLE documents ADD COLUMN IF NOT EXISTS cluster_id INTEGER;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS cluster_label VARCHAR(255);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS classified_at TIMESTAMP WITH TIME ZONE;

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_documents_extracted ON documents(extracted_at) WHERE extracted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_embedded ON documents(embedded_at) WHERE embedded_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_cluster ON documents(cluster_id) WHERE cluster_id IS NOT NULL;

-- Note: Vector index should be created AFTER populating embeddings
-- Run this manually when you have embeddings:
-- CREATE INDEX IF NOT EXISTS idx_documents_embedding ON documents USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
