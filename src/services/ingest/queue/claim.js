// claim — atomic job claiming for the ingestion worker, safe under N workers.
//
// Uses the classic Postgres work-queue pattern:
//   SELECT ... FOR UPDATE SKIP LOCKED
// inside a transaction. SKIP LOCKED means a row another worker has row-locked
// is invisible to this SELECT, so two workers never grab the same job — no
// advisory locks, no external queue. We then stamp a lease (locked_by +
// lease_until) and flip status to 'locked' so even after the txn commits, a
// crashed worker's job becomes reclaimable once the lease expires.
//
// A job is claimable when:
//   • status = 'queued' AND next_attempt_at <= NOW()          (fresh / backed-off), OR
//   • status IN ('locked','processing') AND lease_until < NOW() (worker died mid-job)

import pool from '../../../db/index.js';

const LEASE_MS = Number(process.env.INGEST_LEASE_MS || 120000); // 2m

// Claim up to `limit` jobs for this worker. Returns the claimed job rows.
export async function claimJobs(workerId, limit = 1) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id
         FROM ingest_jobs
        WHERE (status = 'queued' AND next_attempt_at <= NOW())
           OR (status IN ('locked', 'processing') AND lease_until < NOW())
        ORDER BY next_attempt_at
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [limit],
    );
    if (!rows.length) {
      await client.query('COMMIT');
      return [];
    }
    const ids = rows.map((r) => r.id);
    const leaseUntil = new Date(Date.now() + LEASE_MS);
    const { rows: claimed } = await client.query(
      `UPDATE ingest_jobs
          SET status = 'locked',
              locked_by = $1,
              lease_until = $2,
              attempts = attempts + 1,
              updated_at = NOW()
        WHERE id = ANY($3::uuid[])
        RETURNING *`,
      [workerId, leaseUntil, ids],
    );
    await client.query('COMMIT');
    return claimed;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Extend the lease while a long job is still running (heartbeat). Returns false
// if the lease was already stolen (another worker reclaimed it) so the caller
// can abort gracefully instead of double-writing results.
export async function renewLease(jobId, workerId) {
  const leaseUntil = new Date(Date.now() + LEASE_MS);
  const { rowCount } = await pool.query(
    `UPDATE ingest_jobs
        SET lease_until = $1, status = 'processing', updated_at = NOW()
      WHERE id = $2 AND locked_by = $3`,
    [leaseUntil, jobId, workerId],
  );
  return rowCount > 0;
}
