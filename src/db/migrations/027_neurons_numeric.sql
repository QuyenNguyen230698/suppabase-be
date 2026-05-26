-- neurons_used was INTEGER, which truncated fractional neurons (e.g. 224.7073
-- collapsed to 224). Going forward we treat ai_usage_log as the source of
-- truth for today's tally and only keep ai_usage_daily around as a coarse
-- counter; still, widen the column so any direct writes don't truncate.

ALTER TABLE ai_usage_daily
  ALTER COLUMN neurons_used TYPE NUMERIC(14,4) USING neurons_used::numeric;

-- Drop legacy estimate so subsequent reads (now computed from ai_usage_log)
-- start clean. Daily_request_count + fallback_count are still useful, keep them.
UPDATE ai_usage_daily SET neurons_used = 0;
