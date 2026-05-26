-- ============================================================
-- 018_conversations_expand.sql
-- Foundation columns for claude.ai-style UX:
--   • pinned / archived / starred         — sidebar UX states
--   • summary                              — AI-generated short blurb (cron)
--   • share_token / share_expires_at       — read-only public links
--   • tokens_used                          — running token cost per convo
--   • project_id                           — projects feature (FK added in 020)
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS pinned             BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS archived           BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS starred            BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS summary            TEXT,
  ADD COLUMN IF NOT EXISTS share_token        VARCHAR(48) UNIQUE,
  ADD COLUMN IF NOT EXISTS share_expires_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tokens_used        INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS project_id         UUID;
  -- FK on project_id is added in 020_projects.sql after the projects table exists.

CREATE INDEX IF NOT EXISTS idx_conversations_pinned
  ON conversations(user_id, pinned) WHERE pinned = TRUE;

CREATE INDEX IF NOT EXISTS idx_conversations_archived
  ON conversations(user_id, archived);

CREATE INDEX IF NOT EXISTS idx_conversations_starred
  ON conversations(user_id, starred) WHERE starred = TRUE;

CREATE INDEX IF NOT EXISTS idx_conversations_share_token
  ON conversations(share_token) WHERE share_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_project
  ON conversations(project_id) WHERE project_id IS NOT NULL;
