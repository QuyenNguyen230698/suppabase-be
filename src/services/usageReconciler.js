// Reconcile per-request Cloudflare usage from the AI Gateway Logs API.
//
// Flow:
//   1. cloudflareAIService reads `cf-aig-log-id` from response headers.
//   2. aiProvider calls recordPending(logId, meta) BEFORE the stream starts so
//      a row exists in ai_usage_log immediately. No reconcile is scheduled yet
//      because the upstream stream may still be running (logs are only indexed
//      after the request finishes — can take 60-90s for long completions).
//   3. When the stream ends (chatCore / non-stream caller), call
//      scheduleReconcile(logId) so we start polling the Logs API. Retries with
//      exponential-ish backoff up to ~5 minutes.
//   4. On success, store tokens/neurons/cost/duration and bust the daily-cache
//      so the next getToday() recomputes from ai_usage_log.

import { query } from '../db/index.js';
import { fetchLog, isGatewayConfigured } from './gatewayLogsService.js';
import { invalidateCache, releasePending } from './neuronsTracker.js';

// Backoff schedule (ms). Total ≈ 5 minutes — enough for any reasonable stream
// to finish AND get indexed by the AI Gateway Logs pipeline.
const RECONCILE_BACKOFF_MS = [
  3000, 5000, 8000, 15000, 30000, 60000, 60000, 60000, 60000,
];
const MAX_RETRIES = RECONCILE_BACKOFF_MS.length;

export async function recordPending({
  logId, userId, conversationId, model, provider, endpoint,
}) {
  if (!logId) return;
  try {
    await query(
      `INSERT INTO ai_usage_log
         (log_id, user_id, conversation_id, model, provider, endpoint)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (log_id) DO NOTHING`,
      [logId, userId || null, conversationId || null, model || '', provider, endpoint],
    );
  } catch (err) {
    console.warn('[usageReconciler] insert pending failed:', err.message);
  }
}

// Kick off the reconcile poller for a log_id. Safe to call repeatedly; only
// the first call schedules retries (we no-op if already reconciled or maxed).
export function scheduleReconcile(logId, provider = 'cloudflare') {
  if (!logId) return;
  if (provider !== 'cloudflare') return;
  if (!isGatewayConfigured()) return;
  setTimeout(() => reconcileOne(logId).catch(() => {}), RECONCILE_BACKOFF_MS[0]);
}

async function reconcileOne(logId) {
  const { rows } = await query(
    `SELECT reconcile_attempts, reconciled_at FROM ai_usage_log WHERE log_id = $1`,
    [logId],
  );
  const row = rows[0];
  if (!row || row.reconciled_at) return;
  if (row.reconcile_attempts >= MAX_RETRIES) return;

  const attempt = row.reconcile_attempts; // 0-based for backoff index
  await query(
    `UPDATE ai_usage_log SET reconcile_attempts = reconcile_attempts + 1 WHERE log_id = $1`,
    [logId],
  );

  let parsed;
  try {
    parsed = await fetchLog(logId);
  } catch (err) {
    const nextAttempt = attempt + 1;
    const retriable = err.code === 'ERR_LOG_NOT_FOUND' || err.status === 404;
    if (retriable && nextAttempt < MAX_RETRIES) {
      const delay = RECONCILE_BACKOFF_MS[nextAttempt] ?? 60000;
      setTimeout(() => reconcileOne(logId).catch(() => {}), delay);
      return;
    }
    console.warn(`[usageReconciler] ${logId} gave up after ${nextAttempt} tries:`, err.message);
    releasePending(logId);
    return;
  }

  await query(
    `UPDATE ai_usage_log
        SET tokens_in   = $2,
            tokens_out  = $3,
            neurons     = $4,
            cost_usd    = $5,
            duration_ms = $6,
            cached      = $7,
            raw         = $8,
            reconciled_at = NOW()
      WHERE log_id = $1`,
    [
      logId,
      parsed.tokens_in,
      parsed.tokens_out,
      parsed.neurons,
      parsed.cost_usd,
      parsed.duration_ms,
      parsed.cached,
      parsed.raw,
    ],
  );

  releasePending(logId);
  invalidateCache();
}

// On-demand fetch — used by GET /api/admin/ai-usage/log/:log_id. If the row is
// still pending, attempt one immediate reconcile so the FE doesn't have to poll
// past the first 5-second wait.
export async function getOrReconcile(logId) {
  const { rows } = await query(
    `SELECT * FROM ai_usage_log WHERE log_id = $1`,
    [logId],
  );
  if (!rows[0]) return null;
  if (rows[0].reconciled_at) return rows[0];

  try {
    await reconcileOne(logId);
  } catch { /* swallow — return latest state */ }

  const { rows: after } = await query(
    `SELECT * FROM ai_usage_log WHERE log_id = $1`,
    [logId],
  );
  return after[0] || null;
}

// Resume reconcile for any pending rows from earlier server runs. Called at
// boot; gives up rows that already hit MAX_RETRIES.
export async function resumePending() {
  if (!isGatewayConfigured()) return;
  const { rows } = await query(
    `SELECT log_id FROM ai_usage_log
     WHERE reconciled_at IS NULL
       AND reconcile_attempts < $1
       AND provider = 'cloudflare'
       AND created_at > NOW() - INTERVAL '2 hours'`,
    [MAX_RETRIES],
  );
  for (const r of rows) scheduleReconcile(r.log_id);
  if (rows.length) console.log(`[usageReconciler] resumed ${rows.length} pending rows`);
}
