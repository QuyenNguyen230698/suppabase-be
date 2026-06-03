// Neurons usage tracker.
//
// Source of truth is `ai_usage_log` — each row is reconciled from the AI Gateway
// Logs API with precise neurons/cost. The window for "currently used" is a
// ROLLING 24 HOURS, not a UTC calendar day, because Cloudflare Workers AI's
// free-tier quota is enforced as a sliding window — there is no fixed midnight
// reset. Each request "expires" 24h after it was made, freeing up budget
// gradually. Previous UTC-midnight logic produced UI/reality drift: DB showed
// 0/9500 while CF still returned 429 (e.g. yesterday's burst at 15:00 UTC kept
// blocking until 15:00 UTC the next day, not at 00:00 UTC).
//
// `ai_usage_daily` is still maintained as a CALENDAR-day archive (one row per
// UTC day) for the admin history chart and reporting. It's NOT the source of
// truth for live quota decisions — those use the rolling window directly.

import { query } from '../db/index.js';
import { fetchNeuronsUsage, isConfigured as analyticsConfigured } from './cfAnalyticsService.js';

// Authoritative CF neuron usage (GraphQL Analytics), cached separately. When
// available it's the source of truth for the quota number; otherwise we fall
// back to the estimated sum from ai_usage_log (the legacy behaviour).
let cfCache = { at: 0, data: null, ok: false };
const CF_CACHE_TTL_MS = 60 * 1000;

async function loadCfUsage(force = false) {
  if (!analyticsConfigured()) return { ok: false, data: null };
  if (!force && cfCache.data && (Date.now() - cfCache.at) < CF_CACHE_TTL_MS) return cfCache;
  try {
    const data = await fetchNeuronsUsage(); // rolling 24h
    cfCache = { at: Date.now(), data, ok: true };
  } catch (err) {
    // Forbidden (token lacks Account Analytics:Read) or transient — fall back
    // silently to the estimate. Log once per TTL to avoid spam.
    if (cfCache.ok || !cfCache.at) console.warn('[neurons] CF analytics unavailable, using estimate:', err.code || err.message);
    cfCache = { at: Date.now(), data: null, ok: false };
  }
  return cfCache;
}

const DAILY_LIMIT = parseFloat(process.env.CF_NEURONS_DAILY_LIMIT || '9500');
const FALLBACK_THRESHOLD = parseFloat(process.env.CF_NEURONS_FALLBACK_THRESHOLD || '9500');
const CACHE_TTL_MS = 30 * 1000;
// Per-request optimistic estimate held while a CF call is in-flight and not
// yet reconciled. Prevents the race where many requests slip through before
// the AI Gateway Logs API has indexed any of them.
const PENDING_ESTIMATE_NEURONS = parseFloat(process.env.CF_NEURONS_PENDING_ESTIMATE || '300');
// Auto-release a reservation if reconcile never lands (e.g. gateway 404s past
// MAX_RETRIES). Generous enough to cover the full reconcile schedule.
const PENDING_TTL_MS = 10 * 60 * 1000;

// Cache holds the latest rolling-window snapshot. `at` is the timestamp the
// snapshot was computed; everything else is the result of one DB query.
let cache = {
  fetchedAt: 0,
  used: 0,
  requests: 0,
  fallbacks: 0,
  oldestInWindow: null,  // ISO string — used to estimate next partial reset
  newestInWindow: null,  // ISO string — used to estimate next full reset
};
const pending = new Map(); // logId -> { neurons, expiresAt }
let pendingSum = 0;

function gcPending() {
  const now = Date.now();
  for (const [id, p] of pending) {
    if (p.expiresAt <= now) {
      pendingSum -= p.neurons;
      pending.delete(id);
    }
  }
  if (pendingSum < 0) pendingSum = 0;
}

function utcDateString(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

// Compute the rolling-24h snapshot from ai_usage_log. Single query — sums
// neurons + counts requests + grabs oldest/newest row in the window for
// reset-time estimation.
async function loadRolling(force = false) {
  const fresh = (Date.now() - cache.fetchedAt) < CACHE_TTL_MS;
  if (fresh && !force) return cache;

  const { rows: sumRows } = await query(
    `SELECT
       COALESCE(SUM(neurons), 0)::numeric AS neurons_used,
       COUNT(*)::int                       AS requests_total,
       COUNT(*) FILTER (WHERE provider = 'peb')::int AS fallbacks,
       MIN(created_at) AS oldest_in_window,
       MAX(created_at) AS newest_in_window
     FROM ai_usage_log
     WHERE created_at >= NOW() - INTERVAL '24 hours'
       AND neurons IS NOT NULL`,
  );

  const used = parseFloat(sumRows[0]?.neurons_used ?? 0) || 0;
  const requests = sumRows[0]?.requests_total ?? 0;
  const fallbacks = sumRows[0]?.fallbacks ?? 0;
  const oldestInWindow = sumRows[0]?.oldest_in_window || null;
  const newestInWindow = sumRows[0]?.newest_in_window || null;

  // Maintain ai_usage_daily as a calendar-day archive for the admin history
  // chart. Sum TODAY (calendar UTC) separately so the archive stays accurate
  // per day, not biased by the rolling window.
  const today = utcDateString();
  const { rows: todayRows } = await query(
    `SELECT
       COALESCE(SUM(neurons), 0)::numeric AS neurons_used,
       COUNT(*)::int AS requests_total,
       COUNT(*) FILTER (WHERE provider = 'peb')::int AS fallbacks
     FROM ai_usage_log
     WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`
  );
  const todayUsed = parseFloat(todayRows[0]?.neurons_used ?? 0) || 0;
  const todayRequests = todayRows[0]?.requests_total ?? 0;
  const todayFallbacks = todayRows[0]?.fallbacks ?? 0;
  await query(
    `INSERT INTO ai_usage_daily (date, neurons_used, request_count, fallback_count, last_updated)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (date) DO UPDATE
       SET neurons_used  = EXCLUDED.neurons_used,
           request_count = EXCLUDED.request_count,
           fallback_count = EXCLUDED.fallback_count,
           last_updated  = NOW()`,
    [today, todayUsed, todayRequests, todayFallbacks],
  ).catch(() => {});

  cache = { fetchedAt: Date.now(), used, requests, fallbacks, oldestInWindow, newestInWindow };
  return cache;
}

// Back-compat alias — old code calls loadToday().
const loadToday = loadRolling;

// Bump request counter only — neurons are recorded later via ai_usage_log when
// the AI Gateway Logs API has reconciled the request. Called by cloudflareAIService
// after every request to keep request_count fresh between recompute cycles.
export async function recordUsage({ fallback = false } = {}) {
  const today = utcDateString();
  await query(
    `INSERT INTO ai_usage_daily (date, neurons_used, request_count, fallback_count, last_updated)
     VALUES ($1, 0, 1, $2, NOW())
     ON CONFLICT (date) DO UPDATE
       SET request_count = ai_usage_daily.request_count + 1,
           fallback_count = ai_usage_daily.fallback_count + EXCLUDED.fallback_count,
           last_updated  = NOW()`,
    [today, fallback ? 1 : 0],
  );
  cache.requests += 1;
  if (fallback) cache.fallbacks += 1;
}

// Invalidate the in-memory cache so the next getToday() recomputes from
// ai_usage_log. Called by usageReconciler after a row is reconciled.
export function invalidateCache() {
  cache.fetchedAt = 0;
}

/**
 * Estimate when budget will next free up. Two milestones:
 *   - next_partial_reset: oldest row in window + 24h. This is when SOMETHING
 *     leaves the window — could be a small request (5 neurons) or large (500).
 *     Useful only to tell the user "wait at least until X".
 *   - next_full_reset:    newest row in window + 24h. Pessimistic upper bound:
 *     by this time EVERY request currently counted has aged out, so quota
 *     is fully fresh.
 *
 * Returns null timestamps if the window is empty (nothing to expire).
 */
function estimateResetTimes(oldestIso, newestIso) {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const partial = oldestIso ? new Date(new Date(oldestIso).getTime() + ONE_DAY_MS) : null;
  const full = newestIso ? new Date(new Date(newestIso).getTime() + ONE_DAY_MS) : null;
  return {
    next_partial_reset: partial ? partial.toISOString() : null,
    next_full_reset:    full    ? full.toISOString()    : null,
    seconds_to_partial_reset: partial ? Math.max(0, Math.floor((partial.getTime() - Date.now()) / 1000)) : null,
    seconds_to_full_reset:    full    ? Math.max(0, Math.floor((full.getTime()    - Date.now()) / 1000)) : null,
  };
}

// Next UTC midnight — when CF's free-tier daily quota resets.
function nextUtcMidnight() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0));
}

export async function getToday() {
  const [c, cf] = await Promise.all([loadRolling(), loadCfUsage()]);
  gcPending();

  // Prefer CF's authoritative number when the analytics token is available;
  // otherwise use the ai_usage_log estimate. `pending` reservations still count
  // on top so in-flight requests don't slip past the cap.
  const source = cf.ok ? 'cloudflare_gateway' : 'estimated_logs';
  const baseUsed = cf.ok ? cf.data.totalNeurons : c.used;
  const effective = baseUsed + pendingSum;
  const remaining = Math.max(0, DAILY_LIMIT - effective);
  const isOverQuota = effective >= FALLBACK_THRESHOLD;

  // Window + reset semantics differ by source:
  //   CF gateway → UTC calendar day, resets at 00:00 UTC (matches CF dashboard).
  //   estimate   → rolling 24h (legacy), reset estimated from oldest/newest row.
  let windowKind, reset;
  if (cf.ok) {
    const resetAt = nextUtcMidnight();
    windowKind = 'utc_day';
    reset = {
      next_partial_reset: resetAt.toISOString(),
      next_full_reset:    resetAt.toISOString(),
      seconds_to_partial_reset: Math.max(0, Math.floor((resetAt.getTime() - Date.now()) / 1000)),
      seconds_to_full_reset:    Math.max(0, Math.floor((resetAt.getTime() - Date.now()) / 1000)),
    };
  } else {
    windowKind = 'rolling_24h';
    reset = estimateResetTimes(c.oldestInWindow, c.newestInWindow);
  }

  return {
    window: windowKind,
    source,

    // Quota numbers.
    neurons_used:       round4(baseUsed),
    neurons_pending:    round4(pendingSum),
    neurons_effective:  round4(effective),
    neurons_limit:      DAILY_LIMIT,
    neurons_remaining:  round4(remaining),
    percent_used:       DAILY_LIMIT ? round2((effective / DAILY_LIMIT) * 100) : 0,

    // Token usage (only from CF analytics; null on estimate).
    tokens_in:  cf.ok ? cf.data.totalInputTokens : null,
    tokens_out: cf.ok ? cf.data.totalOutputTokens : null,

    // Breakdown (CF only).
    by_model: cf.ok ? cf.data.byModel : null,

    // Counters.
    request_count:  cf.ok ? cf.data.requests : c.requests,
    fallback_count: c.fallbacks,
    pending_count:  pending.size,

    // Reset estimation.
    window_oldest_at: c.oldestInWindow,
    window_newest_at: c.newestInWindow,
    ...reset,

    // Status flags.
    is_over_quota: isOverQuota,

    // Deprecated aliases — keep until FE switches off them.
    fallback_threshold: FALLBACK_THRESHOLD,
    should_fallback: isOverQuota,
  };
}

export async function shouldFallback() {
  const [c, cf] = await Promise.all([loadRolling(), loadCfUsage()]);
  gcPending();
  const baseUsed = cf.ok ? cf.data.totalNeurons : c.used;
  return (baseUsed + pendingSum) >= FALLBACK_THRESHOLD;
}

// Reserve an optimistic neurons estimate for an in-flight CF request. The
// reservation is keyed by a caller-supplied id (logId once known, or a temp
// id beforehand) and counts toward shouldFallback() until releasePending() is
// called by the reconciler.
export function reservePending(id, neurons = PENDING_ESTIMATE_NEURONS) {
  if (!id) return;
  gcPending();
  if (pending.has(id)) return;
  pending.set(id, { neurons, expiresAt: Date.now() + PENDING_TTL_MS });
  pendingSum += neurons;
}

export function releasePending(id) {
  if (!id) return;
  const p = pending.get(id);
  if (!p) return;
  pendingSum -= p.neurons;
  pending.delete(id);
  if (pendingSum < 0) pendingSum = 0;
}

// Rekey a reservation made under a temporary id (used before we know the
// real cf-aig-log-id). No-op if the temp id is unknown.
export function rekeyPending(tempId, realId) {
  if (!tempId || !realId || tempId === realId) return;
  const p = pending.get(tempId);
  if (!p) return;
  pending.delete(tempId);
  pending.set(realId, p);
}

export async function getHistory(days = 7) {
  const { rows } = await query(
    `SELECT date::text AS date,
            neurons_used::float AS neurons_used,
            request_count,
            fallback_count,
            last_updated
     FROM ai_usage_daily
     WHERE date >= (CURRENT_DATE AT TIME ZONE 'UTC')::date - ($1::int - 1)
     ORDER BY date DESC`,
    [days],
  );
  return rows;
}

function round4(n) { return Math.round(n * 10000) / 10000; }
function round2(n) { return Math.round(n * 100) / 100; }
