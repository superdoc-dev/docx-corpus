-- Schema for docx-corpus document tracking

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

    CONSTRAINT valid_status CHECK (status IN ('pending', 'downloading', 'validating', 'uploaded', 'failed'))
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_crawl_id ON documents(crawl_id);
CREATE INDEX IF NOT EXISTS idx_documents_source_url ON documents(source_url);
