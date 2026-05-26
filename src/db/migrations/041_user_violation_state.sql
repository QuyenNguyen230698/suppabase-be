-- Tier 2 — Per-user violation state for rate-limiting.
--
-- Tracks accumulated guardrail violations and applies progressive sanctions:
--   - soft_block_until:  user can only ask safe questions (extra LLM check on every msg)
--   - hard_block_until:  user fully blocked from chat endpoints
--
-- Counters reset every 24h via cron job — see scripts/reset_violation_counters.js.

CREATE TABLE IF NOT EXISTS user_violation_state (
  user_id            UUID         PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Rolling counters (window = 1h for sev4, 24h for sev5).
  sev4_count_1h      INTEGER      NOT NULL DEFAULT 0,
  sev5_count_24h     INTEGER      NOT NULL DEFAULT 0,
  total_count_24h    INTEGER      NOT NULL DEFAULT 0,
  -- Window anchors — reset counters when window expires.
  sev4_window_start  TIMESTAMPTZ,
  sev5_window_start  TIMESTAMPTZ,
  total_window_start TIMESTAMPTZ,
  -- Sanctions.
  soft_block_until   TIMESTAMPTZ,
  hard_block_until   TIMESTAMPTZ,
  -- Audit trail.
  last_violation_at  TIMESTAMPTZ,
  last_category      VARCHAR(40),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_uvs_hard_block ON user_violation_state(hard_block_until) WHERE hard_block_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_uvs_soft_block ON user_violation_state(soft_block_until) WHERE soft_block_until IS NOT NULL;
