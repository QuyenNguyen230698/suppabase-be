-- ============================================================
-- 050_documents_router.sql
-- Router metadata on documents — populated by the magic-bytes router
-- (services/ingest/router.js) at ingestion time.
--
--   detected_mime — true MIME sniffed from the file's magic bytes (file-type),
--                   independent of the client-supplied Content-Type which can
--                   lie or be application/octet-stream.
--   magic_ok      — did the sniffed type match an allowed/expected family?
--                   FALSE → router quarantines the document.
--   router_core   — which ingestion core the router dispatched to.
--
-- Also widen documents.status to allow 'quarantined' (sniff failed / unknown
-- type). Existing states from earlier migrations: processing, ready, error,
-- reindexing (see 025_embedding_bge_m3.sql).
-- ============================================================

ALTER TABLE documents ADD COLUMN IF NOT EXISTS detected_mime TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS magic_ok      BOOLEAN;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS router_core   TEXT;

ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_router_core_check;
ALTER TABLE documents ADD CONSTRAINT documents_router_core_check
  CHECK (router_core IS NULL OR router_core IN ('ocr', 'image', 'code', 'text'));

ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_status_check;
ALTER TABLE documents
  ADD CONSTRAINT documents_status_check
  CHECK (status IN ('processing', 'ready', 'error', 'reindexing', 'quarantined'));

CREATE INDEX IF NOT EXISTS idx_documents_router_core ON documents (router_core);
