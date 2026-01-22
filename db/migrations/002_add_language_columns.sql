-- Migration: Add language detection columns
-- Run this on existing databases to add language support

-- Add language columns to extraction metadata
ALTER TABLE documents ADD COLUMN IF NOT EXISTS language VARCHAR(10);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS language_confidence REAL;

-- Create index for language filtering
CREATE INDEX IF NOT EXISTS idx_documents_language ON documents(language) WHERE language IS NOT NULL;
