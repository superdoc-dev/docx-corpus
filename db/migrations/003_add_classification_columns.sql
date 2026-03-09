-- Migration: Add document type/topic classification columns
-- These columns are written by the classification pipeline (classify_documents.py)
-- which uses HDBSCAN clustering + LLM labeling to assign types and topics

ALTER TABLE documents ADD COLUMN IF NOT EXISTS document_type VARCHAR(50);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS document_topic VARCHAR(50);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS classification_confidence REAL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS classification_model VARCHAR(50);

-- Indexes for filtering by type/topic
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(document_type) WHERE document_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_topic ON documents(document_topic) WHERE document_topic IS NOT NULL;
