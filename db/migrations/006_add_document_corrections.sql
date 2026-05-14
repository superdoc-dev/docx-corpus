-- Tracking table for republished/corrected R2 objects.
--
-- Background: documents scraped before commit 477d1b9 carry 4 trailing bytes
-- (\r\n\r\n, the WARC record terminator) after the ZIP EOCD. The WARC parser
-- bug is fixed for new scrapes; this table records the result of inspecting
-- and (when --commit) republishing each existing object under its corrected
-- SHA-256 key. The original documents/{raw_id}.docx objects are NOT deleted
-- or modified; corrected objects are additive at documents/{corrected_id}.docx.
--
-- One row per inspected raw_id, regardless of outcome. Reruns of the
-- republish script use a LEFT JOIN on this table to skip already-inspected
-- objects.

CREATE TABLE IF NOT EXISTS document_corrections (
    raw_id TEXT PRIMARY KEY,
    corrected_id TEXT,
    status TEXT NOT NULL,                              -- corrected | already_clean | skipped | error
    reason TEXT,                                        -- detail (e.g. "excess-differs", "no-eocd", error message)
    raw_file_size_bytes BIGINT,
    corrected_file_size_bytes BIGINT,
    correction_type TEXT NOT NULL DEFAULT 'warc_trailing_crlf',
    inspected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    corrected_at TIMESTAMPTZ
);

-- Skip-already-inspected query plans (LEFT JOIN documents on raw_id)
-- benefit from the implicit PK btree on raw_id.

-- Status filtering: e.g. selecting only errors for --retry-errors,
-- or counting outcomes for reporting.
CREATE INDEX IF NOT EXISTS idx_document_corrections_status
  ON document_corrections(status);

-- corrected_id lookups: e.g. finding all raw_ids that map to a given
-- corrected object. NOT unique - multiple raw_ids may share corrected
-- bytes when their only difference was the WARC tail.
CREATE INDEX IF NOT EXISTS idx_document_corrections_corrected_id
  ON document_corrections(corrected_id);
