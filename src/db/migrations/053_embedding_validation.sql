-- ============================================================
-- 053_embedding_validation.sql
-- Embedding validation trail for the embed step (services/ingest/embedGuard.js).
--
-- Before a vector is written, embedGuard checks: it's an array, length === 1024
-- (bge-m3), and every component is finite (no NaN/Inf). A chunk that fails goes
-- to the DLQ instead of polluting the index with a garbage vector. These columns
-- record the outcome so we can audit/re-embed; the vector column itself stays
-- VECTOR(1024) (already set in 025_embedding_bge_m3.sql).
--
-- Additive + nullable — existing chunks keep NULL until re-embedded.
-- ============================================================

ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS embedding_dim INT;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS embed_ok      BOOLEAN;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS embedded_at   TIMESTAMPTZ;

-- Find chunks that still need a (re-)embed: written but never validated-ok.
CREATE INDEX IF NOT EXISTS idx_doc_chunks_embed_pending
  ON document_chunks (document_id)
  WHERE embed_ok IS NOT TRUE;
