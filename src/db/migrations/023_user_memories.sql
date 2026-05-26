-- ============================================================
-- 023_user_memories.sql
-- "Memory" feature (claude.ai parity):
--   • Compact facts/preferences the assistant should remember about a user.
--   • Extracted lazily by a background job from conversations.
--   • Always injected into the system prompt at chat time (top-K most recent).
--   • Users can review/delete on /me.
-- ============================================================

CREATE TABLE IF NOT EXISTS user_memories (
  id                 UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content            TEXT NOT NULL,
  source_message_id  UUID REFERENCES messages(id) ON DELETE SET NULL,
  source_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  -- 'auto' = extracted by job, 'manual' = user-added
  origin             VARCHAR(10) NOT NULL DEFAULT 'auto' CHECK (origin IN ('auto', 'manual')),
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_memories_user
  ON user_memories(user_id, is_active, created_at DESC);

-- Track which conversations have already been scanned by the extract job
-- so we don't re-process every hour.
CREATE TABLE IF NOT EXISTS memory_extract_log (
  conversation_id  UUID PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  last_message_at  TIMESTAMPTZ NOT NULL,
  scanned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
