-- ============================================================
-- 034_qa_audit.sql
-- Audit log for admin/super_admin to review user Q&A pairs.
--   • v_qa_audit  — joined view (message + conversation + user + agent)
--   • qa_review   — admin flags/notes attached to a specific message
-- ============================================================

-- ── View for joined Q&A audit reads ───────────────────────────
CREATE OR REPLACE VIEW v_qa_audit AS
SELECT
  m.id              AS message_id,
  m.conversation_id,
  c.title           AS conversation_title,
  c.user_id,
  u.username,
  u.email,
  u.full_name,
  m.role,
  m.content,
  m.tokens_in,
  m.tokens_out,
  m.model,
  m.created_at,
  c.agent_template_id,
  at.slug           AS agent_slug,
  at.name           AS agent_name
FROM messages m
JOIN conversations  c  ON c.id = m.conversation_id
LEFT JOIN users u      ON u.id = c.user_id
LEFT JOIN agent_templates at ON at.id = c.agent_template_id
WHERE m.is_deleted = FALSE;

-- ── Admin reviews / flags ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS qa_review (
  message_id   UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  flagged      BOOLEAN NOT NULL DEFAULT FALSE,
  flag_reason  VARCHAR(40),   -- 'unsafe' | 'low_quality' | 'pii_leak' | 'off_topic' | 'other'
  note         TEXT,
  reviewed_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_qa_review_flagged ON qa_review(flagged) WHERE flagged = TRUE;

-- ── Audit log of admin reveals (PII access trail) ─────────────
CREATE TABLE IF NOT EXISTS qa_access_log (
  id          BIGSERIAL PRIMARY KEY,
  admin_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  admin_role  VARCHAR(50),
  action      VARCHAR(40) NOT NULL,           -- 'list' | 'reveal' | 'export' | 'flag'
  target_id   UUID,                            -- message_id / conversation_id
  meta        JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_qa_access_log_admin   ON qa_access_log(admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qa_access_log_target  ON qa_access_log(target_id);
