-- Refresh tokens (long-lived, rotated on each /refresh) and a revocation list
-- for access tokens by jti. Both tables are append-only with a TTL cleanup.

CREATE TABLE IF NOT EXISTS refresh_tokens (
  jti          UUID PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  replaced_by  UUID,
  user_agent   TEXT,
  ip           INET
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user      ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires   ON refresh_tokens(expires_at);

-- Access-token revocation list. We only insert here on /logout or explicit
-- admin revoke — every access token is short-lived so we don't need to track
-- the universe of issued tokens.
CREATE TABLE IF NOT EXISTS revoked_access_tokens (
  jti        UUID PRIMARY KEY,
  user_id    UUID NOT NULL,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revoked_access_expires ON revoked_access_tokens(expires_at);
