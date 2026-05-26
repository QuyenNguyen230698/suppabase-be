-- ============================================================
-- 037_qa_rating.sql
-- User feedback on assistant messages — thumbs up/down + optional reason.
-- Distinct from qa_review (admin-side flag) — this is user-initiated quality signal.
-- ============================================================

CREATE TABLE IF NOT EXISTS qa_rating (
  message_id   UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating       SMALLINT NOT NULL CHECK (rating IN (-1, 1)),  -- -1 = down, 1 = up
  reason       VARCHAR(40),       -- 'inaccurate' | 'harmful' | 'off_topic' | 'verbose' | 'other' | null
  comment      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_qa_rating_message ON qa_rating(message_id);
CREATE INDEX IF NOT EXISTS idx_qa_rating_created ON qa_rating(created_at DESC);

-- Quality stats per agent over a rolling window — view for cheap reads.
CREATE OR REPLACE VIEW v_agent_quality AS
SELECT
  c.agent_template_id,
  at.slug             AS agent_slug,
  at.name             AS agent_name,
  COUNT(r.*)::int                                       AS ratings_total,
  COUNT(*) FILTER (WHERE r.rating =  1)::int            AS up_count,
  COUNT(*) FILTER (WHERE r.rating = -1)::int            AS down_count,
  ROUND(AVG(r.rating)::numeric, 3)                      AS avg_rating,
  ROUND(
    (COUNT(*) FILTER (WHERE r.rating = 1)::numeric
     / NULLIF(COUNT(r.*), 0)) * 100, 1
  )                                                     AS positive_pct
FROM qa_rating r
JOIN messages m       ON m.id = r.message_id
JOIN conversations c  ON c.id = m.conversation_id
LEFT JOIN agent_templates at ON at.id = c.agent_template_id
GROUP BY c.agent_template_id, at.slug, at.name;
