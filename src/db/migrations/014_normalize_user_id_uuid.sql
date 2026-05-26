-- ============================================================
-- 014_normalize_user_id_uuid.sql
-- conversations.user_id, documents.user_id, api_tokens.created_by
-- hiện đang lưu USERNAME (VARCHAR) thay vì UUID → request hiện tại
-- dùng req.user.id (UUID) filter ra 0 rows → mất lịch sử hội thoại.
--
-- Strategy:
-- 1. Backfill: UPDATE … SET user_id = u.id WHERE user_id = u.username
-- 2. Xoá rows orphan (username không tồn tại trong users)
-- 3. ALTER COLUMN sang UUID + thêm FK ON DELETE CASCADE
-- ============================================================

-- ── conversations ────────────────────────────────────────────
-- Backfill từ username → UUID
UPDATE conversations c
   SET user_id = u.id::text
  FROM users u
 WHERE c.user_id = u.username;

-- Xoá orphan (username không khớp user nào)
DELETE FROM conversations
 WHERE user_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- ALTER sang UUID + FK
ALTER TABLE conversations
  ALTER COLUMN user_id TYPE UUID USING user_id::uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_conversations_user'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT fk_conversations_user
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END$$;

-- ── documents ────────────────────────────────────────────────
UPDATE documents d
   SET user_id = u.id::text
  FROM users u
 WHERE d.user_id = u.username;

DELETE FROM documents
 WHERE user_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

ALTER TABLE documents
  ALTER COLUMN user_id TYPE UUID USING user_id::uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_documents_user'
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT fk_documents_user
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END$$;

-- ── api_tokens.created_by ────────────────────────────────────
UPDATE api_tokens a
   SET created_by = u.id::text
  FROM users u
 WHERE a.created_by = u.username;

DELETE FROM api_tokens
 WHERE created_by !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

ALTER TABLE api_tokens
  ALTER COLUMN created_by TYPE UUID USING created_by::uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_api_tokens_creator'
  ) THEN
    ALTER TABLE api_tokens
      ADD CONSTRAINT fk_api_tokens_creator
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END$$;
