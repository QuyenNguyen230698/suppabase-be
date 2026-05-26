-- Runtime-mutable system settings.
--
-- Replaces boot-time env vars where ops needs to change behavior without a
-- restart. Initial use case: AI provider routing (ai_provider_rule +
-- ai_provider_manual_override) so admins can flip CF↔PEB or trigger an auto-
-- fallback rule via API instead of editing .env and restarting.
--
-- Each row is independently versioned via updated_at. Cache layer in
-- providerRouter.js reads with 30s TTL.

CREATE TABLE IF NOT EXISTS system_settings (
  key         VARCHAR(64) PRIMARY KEY,
  value       JSONB       NOT NULL,
  description TEXT,
  updated_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit trail for compliance — every change is appended, never overwritten.
CREATE TABLE IF NOT EXISTS system_settings_audit (
  id          BIGSERIAL    PRIMARY KEY,
  key         VARCHAR(64)  NOT NULL,
  old_value   JSONB,
  new_value   JSONB        NOT NULL,
  reason      TEXT,
  changed_by  UUID         REFERENCES users(id) ON DELETE SET NULL,
  changed_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settings_audit_key ON system_settings_audit(key, changed_at DESC);

-- Seed AI-provider routing keys.
--   ai_provider_rule:
--     "auto"      — default: CF if quota OK, else PEB (recommended)
--     "cf_first"  — always CF, no fallback (test CF in isolation)
--     "peb_first" — always PEB (when CF is degraded/over-quota)
--   ai_provider_manual_override:
--     null  — rule applies
--     "cloudflare" / "peb"  — panic kill-switch, bypasses rule entirely

INSERT INTO system_settings (key, value, description) VALUES
  ('ai_provider_rule',
   '"auto"'::jsonb,
   'Routing rule: auto | cf_first | peb_first. "auto" prefers CF and falls back to PEB when CF quota is exhausted.'),
  ('ai_provider_manual_override',
   'null'::jsonb,
   'Panic override. When set to "cloudflare" or "peb", forces that provider regardless of rule. Set to null to resume rule.')
ON CONFLICT (key) DO NOTHING;
