// worker — the ingestion retry worker (left rail of the sitemap: RESILIENCE).
//
// Loop: every tick, claim a batch of due jobs (SKIP LOCKED + lease), dispatch
// each to its core handler, then:
//   success           → status 'done'
//   failure, retries  → status 'queued', next_attempt_at = now + backoff(jitter)
//   failure, exhausted→ status 'dead' + copy into ingest_dlq
//
// Worker lock (claim.js lease) makes this safe to run in multiple processes —
// each job is handled by exactly one worker, and a crashed worker's in-flight
// job becomes reclaimable once its lease expires.

import crypto from 'crypto';
import pool, { query } from '../../../db/index.js';
import { claimJobs } from './claim.js';
import { nextAttemptAt } from './backoff.js';
import { dispatch } from '../dispatcher.js';
import { incCounter, setGauge } from '../metrics.js';

const WORKER_ID    = `${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
const POLL_MS      = Number(process.env.INGEST_POLL_MS || 2000);
const BATCH        = Number(process.env.INGEST_BATCH || 2);

let running = false;
let timer = null;

async function markDone(jobId) {
  await query(
    `UPDATE ingest_jobs SET status='done', last_error=NULL, updated_at=NOW() WHERE id=$1`,
    [jobId],
  );
}

async function markRetryOrDead(job, err) {
  const msg = (err?.message || String(err)).slice(0, 1000);
  if (job.attempts >= job.max_attempts) {
    // Terminal — mirror into DLQ then mark dead.
    await query(
      `INSERT INTO ingest_dlq (job_id, document_id, core, attempts, error, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [job.id, job.document_id, job.core, job.attempts, msg, job.payload || null],
    );
    await query(
      `UPDATE ingest_jobs SET status='dead', last_error=$2, updated_at=NOW() WHERE id=$1`,
      [job.id, msg],
    );
    await query(
      `UPDATE documents SET status='error', error_msg=$2 WHERE id=$1 AND status NOT IN ('ready')`,
      [job.document_id, `ingest failed: ${msg}`.slice(0, 500)],
    ).catch(() => {});
    console.warn(`[ingest] job ${job.id} (${job.core}) DEAD after ${job.attempts} attempts: ${msg}`);
  } else {
    await query(
      `UPDATE ingest_jobs
          SET status='queued', last_error=$2, next_attempt_at=$3,
              locked_by=NULL, lease_until=NULL, updated_at=NOW()
        WHERE id=$1`,
      [job.id, msg, nextAttemptAt(job.attempts)],
    );
    console.warn(`[ingest] job ${job.id} (${job.core}) retry ${job.attempts}/${job.max_attempts}: ${msg}`);
  }
}

async function tick() {
  let claimed;
  try {
    claimed = await claimJobs(WORKER_ID, BATCH);
  } catch (err) {
    console.warn('[ingest] claim failed:', err.message);
    return;
  }
  for (const job of claimed) {
    try {
      await dispatch(job);
      await markDone(job.id);
      incCounter('ingest_jobs_total', { core: job.core, outcome: 'done' });
    } catch (err) {
      const dead = job.attempts >= job.max_attempts;
      incCounter('ingest_jobs_total', { core: job.core, outcome: dead ? 'dead' : 'retry' });
      await markRetryOrDead(job, err).catch((e) =>
        console.error('[ingest] markRetryOrDead failed:', e.message));
    }
  }
}

// Start the polling loop. Idempotent — calling twice is a no-op.
export function startWorker() {
  if (running) return;
  running = true;
  setGauge('ingest_worker_up', 1);
  const loop = async () => {
    if (!running) return;
    await tick().catch((e) => console.error('[ingest] tick error:', e.message));
    timer = setTimeout(loop, POLL_MS);
    timer.unref?.();
  };
  loop();
  console.log(`[ingest] worker ${WORKER_ID} started (poll ${POLL_MS}ms, batch ${BATCH})`);
}

export function stopWorker() {
  running = false;
  setGauge('ingest_worker_up', 0);
  if (timer) clearTimeout(timer);
}

export const workerId = WORKER_ID;
