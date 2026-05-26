-- ============================================================
-- 019_messages_expand.sql
-- Per-message metadata for branching, editing, tokens, reasoning:
--   • parent_message_id  — branching tree (NULL = root)
--   • model              — which model produced an assistant msg
--   • tokens_in / out    — cost accounting
--   • reasoning          — separated from content (was inlined as <think>)
--   • edited_at / original_content — edit history (1 level — full audit lives in messages tree)
--   • is_deleted         — soft delete so branches survive
--   • tool_calls         — placeholder for future tool/function calls
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS parent_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS model             VARCHAR(100),
  ADD COLUMN IF NOT EXISTS tokens_in         INTEGER,
  ADD COLUMN IF NOT EXISTS tokens_out        INTEGER,
  ADD COLUMN IF NOT EXISTS reasoning         TEXT,
  ADD COLUMN IF NOT EXISTS edited_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS original_content  TEXT,
  ADD COLUMN IF NOT EXISTS is_deleted        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS tool_calls        JSONB;

CREATE INDEX IF NOT EXISTS idx_messages_parent
  ON messages(parent_message_id) WHERE parent_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_conv_active
  ON messages(conversation_id, created_at)
  WHERE is_deleted = FALSE;

-- Bump conversations.tokens_used when an assistant message records tokens_out.
CREATE OR REPLACE FUNCTION fn_messages_bump_tokens()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.tokens_in IS NOT NULL OR NEW.tokens_out IS NOT NULL THEN
    UPDATE conversations
       SET tokens_used = tokens_used
                        + COALESCE(NEW.tokens_in, 0)
                        + COALESCE(NEW.tokens_out, 0)
     WHERE id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_messages_bump_tokens ON messages;
CREATE TRIGGER trg_messages_bump_tokens
  AFTER INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION fn_messages_bump_tokens();
