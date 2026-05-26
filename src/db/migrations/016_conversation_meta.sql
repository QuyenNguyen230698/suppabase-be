-- ============================================================
-- 016_conversation_meta.sql
-- Tracking last_message_at via trigger so the conversation list can sort by
-- "most recent activity" without touching updated_at on every UPDATE call.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ;

-- Backfill from existing messages
UPDATE conversations c
   SET last_message_at = (
     SELECT MAX(created_at) FROM messages WHERE conversation_id = c.id
   )
 WHERE last_message_at IS NULL;

-- Fallback: if conversation has no messages, use created_at
UPDATE conversations
   SET last_message_at = created_at
 WHERE last_message_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_last_msg
  ON conversations(user_id, last_message_at DESC);

-- Trigger: bump last_message_at when a new message is inserted
CREATE OR REPLACE FUNCTION fn_conversations_bump_last_msg()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE conversations
     SET last_message_at = NEW.created_at,
         updated_at      = NEW.created_at
   WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_conversations_bump_last_msg ON messages;
CREATE TRIGGER trg_conversations_bump_last_msg
  AFTER INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION fn_conversations_bump_last_msg();
