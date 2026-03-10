-- Replace status constraint to match reality:
-- Remove unused statuses (pending, downloading, validating)
-- Add 'duplicate' for content-dedup tracking
ALTER TABLE documents DROP CONSTRAINT valid_status;
ALTER TABLE documents ADD CONSTRAINT valid_status
  CHECK (status IN ('uploaded', 'failed', 'duplicate'));
