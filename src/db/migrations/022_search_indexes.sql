-- ============================================================
-- 022_search_indexes.sql
-- Full-text search (Postgres tsvector) on:
--   • conversations.title
--   • messages.content
-- Uses 'simple' dictionary so Vietnamese + English both index sanely
-- (no stemming, but matches accent-folded terms well enough for chat UX).
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS title_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_conversations_title_tsv
  ON conversations USING GIN (title_tsv);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_messages_content_tsv
  ON messages USING GIN (content_tsv);
