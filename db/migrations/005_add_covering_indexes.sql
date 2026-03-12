-- Covering indexes for common scraper queries
-- Allows index-only scans (no table lookups) for URL loading

-- Covers: SELECT source_url FROM documents WHERE status IN ('uploaded', 'duplicate')
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_documents_status_url
  ON documents(status, source_url);

-- Covers: SELECT source_url FROM documents WHERE crawl_id = $1
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_documents_crawl_url
  ON documents(crawl_id, source_url);
