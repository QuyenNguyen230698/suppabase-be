-- ============================================================
-- 059_email_otp.sql
-- Email OTP login: one-time 6-digit codes for the "sign in with email" flow.
--
-- Mirrors the refresh_tokens pattern (047): store a HASH of the code, never the
-- plaintext; track expiry + attempt count so a code can be rate-limited and
-- invalidated. A code is consumed (consumed_at) on successful verify.
-- ============================================================

CREATE TABLE IF NOT EXISTS email_otp_codes (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash    TEXT NOT NULL,                 -- sha256(code) — plaintext is never stored
  attempts     SMALLINT NOT NULL DEFAULT 0,   -- wrong-guess counter
  max_attempts SMALLINT NOT NULL DEFAULT 5,
  expires_at   TIMESTAMPTZ NOT NULL,          -- now() + 5 minutes
  consumed_at  TIMESTAMPTZ,                   -- set when verified OK
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip           INET,
  user_agent   TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_otp_user    ON email_otp_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_email_otp_expires ON email_otp_codes(expires_at);
