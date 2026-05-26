-- ============================================================
-- 021_tags.sql
-- Per-user free-form tags for conversations.
-- ============================================================

CREATE TABLE IF NOT EXISTS tags (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        VARCHAR(40) NOT NULL,
  color       VARCHAR(20) DEFAULT 'gray',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_tags_user ON tags(user_id);

CREATE TABLE IF NOT EXISTS conversation_tags (
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tag_id           UUID NOT NULL REFERENCES tags(id)          ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_tags_tag ON conversation_tags(tag_id);
