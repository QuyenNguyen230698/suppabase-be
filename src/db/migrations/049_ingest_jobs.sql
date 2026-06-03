-- ============================================================
-- 049_ingest_jobs.sql
-- Durable ingestion queue + dead-letter queue for the document pipeline.
--
-- Replaces the in-process extractorQueue (which loses jobs on restart — see
-- the "stopgap" note in services/extractorQueue.js). Jobs now live in Postgres
-- so they survive restarts and can be claimed safely by multiple workers via
-- SELECT ... FOR UPDATE SKIP LOCKED + a lease (worker lock, see queue/claim.js).
--
-- Lifecycle:
--   queued → (claim) locked → processing → done
--                                        ↘ failed → (backoff) queued ...
--                                        ↘ dead   → row copied into ingest_dlq
-- Retry/backoff is driven by next_attempt_at; a job whose attempts exceed
-- max_attempts is marked 'dead' and mirrored into ingest_dlq for inspection.
-- ============================================================

CREATE TABLE IF NOT EXISTS ingest_jobs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- Which core handles this job — set by the router (magic-bytes classify).
  core            TEXT NOT NULL CHECK (core IN ('ocr', 'image', 'code', 'text')),
  status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'locked', 'processing', 'done', 'failed', 'dead')),
  attempts        INT  NOT NULL DEFAULT 0,
  max_attempts    INT  NOT NULL DEFAULT 5,
  -- Worker lock: which worker holds this job and until when the lease is valid.
  -- A lease in the past means the worker died → the job is reclaimable.
  locked_by       TEXT,
  lease_until     TIMESTAMPTZ,
  -- Backoff: a queued job is only claimable once NOW() >= next_attempt_at.
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error      TEXT,
  payload         JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Claim query orders by (status, next_attempt_at); this index serves it.
CREATE INDEX IF NOT EXISTS idx_ingest_jobs_claim
  ON ingest_jobs (status, next_attempt_at);
-- Reclaiming expired leases scans locked rows by lease_until.
CREATE INDEX IF NOT EXISTS idx_ingest_jobs_lease
  ON ingest_jobs (lease_until)
  WHERE status IN ('locked', 'processing');
CREATE INDEX IF NOT EXISTS idx_ingest_jobs_document
  ON ingest_jobs (document_id);

-- Dead-letter queue — terminal failures, kept for inspection/manual replay.
CREATE TABLE IF NOT EXISTS ingest_dlq (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id        UUID,                       -- original ingest_jobs.id (row may be gone)
  document_id   UUID,
  core          TEXT,
  attempts      INT,
  error         TEXT,
  payload       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ingest_dlq_created ON ingest_dlq (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ingest_dlq_document ON ingest_dlq (document_id);
