-- ============================================================
-- 048_user_memories_embedding.sql
-- Add embedding column so memory recall can rank by semantic similarity to
-- the current question, not just by recency. Backfill happens lazily — new
-- memories embed on insert; existing rows are embedded on first read miss
-- (handled in memoryService).
-- ============================================================

ALTER TABLE user_memories
  ADD COLUMN IF NOT EXISTS embedding vector(1024);

CREATE INDEX IF NOT EXISTS idx_user_memories_embedding
  ON user_memories USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50)
  WHERE is_active = TRUE AND embedding IS NOT NULL;
