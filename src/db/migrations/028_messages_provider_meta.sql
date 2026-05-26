-- Persist per-message provider/usage metadata so the FE can show consistent
-- usage info after a page reload (model badge, log_id for neurons re-fetch,
-- fallback reason).

ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider        TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS log_id          TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS fallback_reason TEXT;
