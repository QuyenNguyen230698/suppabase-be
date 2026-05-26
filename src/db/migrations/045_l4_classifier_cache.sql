-- L4 — Per-input verdict cache.
-- Hash is SHA-256 of (prompt_version || normalized_text). Verdict is JSON
-- from classifier output. Garbage-collected by age (TTL handled in query).

CREATE TABLE IF NOT EXISTS l4_classifier_cache (
  hash          CHAR(64)    PRIMARY KEY,
  verdict_json  JSONB       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_l4_cache_created ON l4_classifier_cache(created_at);
