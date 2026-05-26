-- Switch embeddings from nomic-embed-text (768-dim) to Cloudflare bge-m3 (1024-dim).
-- All existing embeddings are invalidated (different model + dimension); rows are kept
-- but cleared, and parent documents are flipped to 'reindexing' so RAG search skips them
-- until scripts/reembed-all.js refills them.

-- 1. Expand documents.status to allow 'reindexing'.
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_status_check;
ALTER TABLE documents
  ADD CONSTRAINT documents_status_check
  CHECK (status IN ('processing', 'ready', 'error', 'reindexing'));

-- 2. Mark every ready document as 'reindexing' (processing/error stay as-is).
UPDATE documents SET status = 'reindexing' WHERE status = 'ready';

-- 3. Drop the HNSW index (depends on the old column type).
DROP INDEX IF EXISTS idx_doc_chunks_embedding;

-- 4. Clear and resize the embedding column.
ALTER TABLE document_chunks ALTER COLUMN embedding DROP NOT NULL;
UPDATE document_chunks SET embedding = NULL;
ALTER TABLE document_chunks ALTER COLUMN embedding TYPE VECTOR(1024) USING NULL;

-- 5. Track which embedding model produced each chunk (helps future migrations).
ALTER TABLE document_chunks
  ADD COLUMN IF NOT EXISTS embedding_model VARCHAR(64);

-- 6. Recreate HNSW index for cosine similarity.
CREATE INDEX idx_doc_chunks_embedding
  ON document_chunks USING hnsw (embedding vector_cosine_ops);
