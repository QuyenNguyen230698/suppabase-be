CREATE TABLE IF NOT EXISTS ai_usage_daily (
  date            DATE PRIMARY KEY,
  neurons_used   INTEGER NOT NULL DEFAULT 0,
  request_count  INTEGER NOT NULL DEFAULT 0,
  fallback_count INTEGER NOT NULL DEFAULT 0,
  last_updated   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_daily_date_desc ON ai_usage_daily (date DESC);
