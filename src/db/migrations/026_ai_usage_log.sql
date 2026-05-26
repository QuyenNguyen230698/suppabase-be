-- Per-request Cloudflare AI usage log. Reconciled asynchronously from the
-- AI Gateway Logs API ~5s after each request completes.

CREATE TABLE IF NOT EXISTS ai_usage_log (
  log_id          TEXT PRIMARY KEY,            -- cf-aig-log-id header
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id         UUID,
  conversation_id UUID,
  model           TEXT NOT NULL,
  provider        TEXT NOT NULL,               -- 'cloudflare' | 'peb'
  endpoint        TEXT,                        -- 'chat' | 'embed' | 'vision'
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  neurons         NUMERIC(14,4),
  cost_usd        NUMERIC(14,8),
  duration_ms     INTEGER,
  cached          BOOLEAN DEFAULT FALSE,
  reconciled_at   TIMESTAMPTZ,                 -- null = pending Logs API
  reconcile_attempts INTEGER NOT NULL DEFAULT 0,
  raw             JSONB
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_log_created ON ai_usage_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_user    ON ai_usage_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_pending ON ai_usage_log (reconciled_at) WHERE reconciled_at IS NULL;
