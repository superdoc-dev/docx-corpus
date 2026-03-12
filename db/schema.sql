-- Schema for docx-corpus document tracking

-- Enable pgvector extension for embedding storage
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
    id VARCHAR(255) PRIMARY KEY,
    source_url TEXT NOT NULL,
    crawl_id VARCHAR(100) NOT NULL,
    original_filename TEXT,
    file_size_bytes BIGINT,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    error_message TEXT,
    is_valid_docx BOOLEAN,
    discovered_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    downloaded_at TIMESTAMP WITH TIME ZONE,
    uploaded_at TIMESTAMP WITH TIME ZONE,

    -- Extraction metadata
    extracted_at TIMESTAMP WITH TIME ZONE,
    word_count INTEGER,
    char_count INTEGER,
    table_count INTEGER,
    image_count INTEGER,
    language VARCHAR(10),
    language_confidence REAL,
    extraction_error TEXT,

    -- Embedding data
    -- Using Google's gemini-embedding-001 (3072 dimensions)
    embedded_at TIMESTAMP WITH TIME ZONE,
    embedding_model VARCHAR(50),
    embedding vector(3072),

    -- Classification data (clustering)
    cluster_id INTEGER,
    cluster_label VARCHAR(255),
    classified_at TIMESTAMP WITH TIME ZONE,

    -- Classification data (type/topic from LLM pipeline)
    document_type VARCHAR(50),
    document_topic VARCHAR(50),
    classification_confidence REAL,
    classification_model VARCHAR(50),

    CONSTRAINT valid_status CHECK (status IN ('uploaded', 'failed', 'duplicate'))
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_crawl_id ON documents(crawl_id);
CREATE INDEX IF NOT EXISTS idx_documents_source_url ON documents(source_url);

-- Covering indexes for scraper URL loading (index-only scans)
CREATE INDEX IF NOT EXISTS idx_documents_status_url ON documents(status, source_url);
CREATE INDEX IF NOT EXISTS idx_documents_crawl_url ON documents(crawl_id, source_url);

-- Indexes for extraction/embedding/classification queries
CREATE INDEX IF NOT EXISTS idx_documents_extracted ON documents(extracted_at) WHERE extracted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_embedded ON documents(embedded_at) WHERE embedded_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_cluster ON documents(cluster_id) WHERE cluster_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_language ON documents(language) WHERE language IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(document_type) WHERE document_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_topic ON documents(document_topic) WHERE document_topic IS NOT NULL;

-- Vector similarity search index (IVFFlat for approximate nearest neighbor)
-- Note: Run this AFTER populating embeddings for better index quality
-- CREATE INDEX IF NOT EXISTS idx_documents_embedding ON documents USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
