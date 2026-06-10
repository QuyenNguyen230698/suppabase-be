// Lightweight in-process scheduler — no Redis, no extra deps.
//
// Each job declares:
//   { name, intervalMs, runAtBoot, run(ctx) }
//
// We persist last run time in a tiny `_jobs` table so a restart loop
// won't double-execute long-period jobs.
//
// Swap-in plan for prod: replace `start()` with pg-boss boot; jobs already
// declare `run` as plain async functions so the contract is portable.

import { query } from '../../db/index.js';

const REGISTRY = new Map();
let started = false;

export function registerJob(job) {
  if (!job?.name || typeof job.run !== 'function' || !job.intervalMs) {
    throw new Error('registerJob: name, intervalMs, run() required');
  }
  REGISTRY.set(job.name, job);
}

async function ensureTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS _jobs (
      name           VARCHAR(80) PRIMARY KEY,
      last_run_at    TIMESTAMPTZ,
      last_run_ms    INTEGER,
      last_run_ok    BOOLEAN,
      last_error     TEXT
    )
  `);
}

async function getLastRun(name) {
  const { rows } = await query('SELECT last_run_at FROM _jobs WHERE name = $1', [name]);
  return rows[0]?.last_run_at ? new Date(rows[0].last_run_at) : null;
}

async function recordRun(name, ok, ms, error) {
  await query(
    `INSERT INTO _jobs (name, last_run_at, last_run_ms, last_run_ok, last_error)
     VALUES ($1, NOW(), $2, $3, $4)
     ON CONFLICT (name) DO UPDATE
        SET last_run_at = NOW(),
            last_run_ms = EXCLUDED.last_run_ms,
            last_run_ok = EXCLUDED.last_run_ok,
            last_error  = EXCLUDED.last_error`,
    [name, ms, ok, error || null]
  );
}

async function runOnce(job) {
  const start = Date.now();
  try {
    await job.run();
    const ms = Date.now() - start;
    await recordRun(job.name, true, ms, null);
    console.log(`[jobs] ${job.name} ok (${ms}ms)`);
  } catch (err) {
    const ms = Date.now() - start;
    await recordRun(job.name, false, ms, err?.message || String(err));
    console.error(`[jobs] ${job.name} FAILED:`, err?.message || err);
  }
}

export async function start() {
  if (started) return;
  started = true;

  await ensureTable();

  for (const job of REGISTRY.values()) {
    const last = await getLastRun(job.name);
    const dueIn = job.runAtBoot
      ? 5_000                                                    // run 5s after boot
      : last
        ? Math.max(0, job.intervalMs - (Date.now() - last.getTime()))
        : job.intervalMs;

    setTimeout(function loop() {
      runOnce(job).finally(() => setTimeout(loop, job.intervalMs));
    }, dueIn);

    console.log(`[jobs] scheduled "${job.name}" every ${Math.round(job.intervalMs/1000)}s (first in ${Math.round(dueIn/1000)}s)`);
  }
}

/** Run a job manually (admin trigger). */
export async function runNow(name) {
  const job = REGISTRY.get(name);
  if (!job) throw new Error(`Unknown job: ${name}`);
  await runOnce(job);
}

/** Status snapshot for admin dashboard. */
export async function listJobs() {
  const { rows } = await query(
    'SELECT name, last_run_at, last_run_ms, last_run_ok, last_error FROM _jobs ORDER BY name'
  );
  const known = [...REGISTRY.values()].map(j => ({
    name: j.name,
    interval_ms: j.intervalMs,
    description: j.description || '',
  }));
  return known.map(j => ({ ...j, ...(rows.find(r => r.name === j.name) || {}) }));
}
