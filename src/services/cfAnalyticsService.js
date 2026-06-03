// cfAnalyticsService — authoritative Workers AI usage from the Cloudflare AI
// Gateway Logs REST API (the same numbers the gateway dashboard shows).
//
// Why this exists: neuronsTracker historically ESTIMATED usage by summing each
// request reconciled one-by-one via the per-request Logs API, which drifts from
// CF's real count when a request never reconciles. This service instead reads
// the gateway's own log list, which CF maintains authoritatively:
//
//   GET /accounts/{acct}/ai-gateway/gateways/{gw}/logs?per_page=1&page=1
//     → result_info.total_count   (exact request count; with a created_at
//       filter this is the rolling-window request count — matches the
//       dashboard's "Requests · Last 24 hours")
//
// Each log row carries tokens_in / tokens_out / cost (but NOT neurons — that
// field is null on the gateway logs), so we sum tokens + cost across the window
// and derive neurons from cost at CF's published rate ($0.011 / 1k neurons),
// matching gatewayLogsService.
//
// Auth: the existing CF_AI_TOKEN (Workers AI:Read + AI Gateway:Read) is enough —
// verified working. CF_ANALYTICS_TOKEN overrides it if set.

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '';
const TOKEN = process.env.CF_ANALYTICS_TOKEN || process.env.CF_AI_TOKEN || '';
const GATEWAY_ID = (process.env.CF_AI_GATEWAY_ID || '').replace(/^"|"$/g, '');
const USD_PER_NEURON = 0.011 / 1000;   // same rate as gatewayLogsService
const CACHE_TTL_MS = 60 * 1000;
const PAGE_SIZE = 50;
const MAX_PAGES = 40;                  // safety cap: 2000 logs/window

let cache = { at: 0, key: '', data: null };

export function isConfigured() {
  return !!(ACCOUNT_ID && TOKEN && GATEWAY_ID);
}

function logsUrl() {
  return `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai-gateway/gateways/${GATEWAY_ID}/logs`;
}

// created_at filter: CF expects value as an ARRAY (verified — a string yields
// "Expected array, received string").
function sinceFilter(sinceIso) {
  return JSON.stringify([{ key: 'created_at', operator: 'gt', value: [sinceIso] }]);
}

async function fetchPage({ sinceIso, page, perPage }) {
  const u = new URL(logsUrl());
  u.searchParams.set('per_page', String(perPage));
  u.searchParams.set('page', String(page));
  if (sinceIso) u.searchParams.set('filters', sinceFilter(sinceIso));
  const res = await fetch(u, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(new Error(`CF gateway logs ${res.status}: ${text.slice(0, 200)}`), {
      code: res.status === 403 ? 'ERR_ANALYTICS_FORBIDDEN' : 'ERR_ANALYTICS_HTTP', status: res.status,
    });
  }
  const json = await res.json();
  if (!json.success) {
    const msg = (json.errors || []).map((e) => e.message).join('; ');
    throw Object.assign(new Error(`CF gateway logs error: ${msg}`), { code: 'ERR_ANALYTICS_QUERY' });
  }
  return json;
}

function num(v) { const n = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(n) ? n : 0; }

// Start of the current UTC calendar day (00:00:00 UTC). Cloudflare's Workers AI
// free-tier quota "resets at 00:00 UTC" (per the dashboard), so the window for
// "neurons used today" is [today 00:00 UTC, now] — NOT a rolling 24h.
function startOfUtcDay() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

/**
 * Aggregate usage over the current UTC day [00:00 UTC, now] — matches CF's
 * dashboard "Neurons used today: x/10k (resets at 00:00 UTC)".
 * Returns { totalNeurons, totalInputTokens, totalOutputTokens, totalCostUsd,
 *           requests, byModel[] }.
 *   - requests   = result_info.total_count (exact, 1 call).
 *   - tokens/cost = summed across paginated logs (cap MAX_PAGES).
 *   - neurons     = derived from cost (gateway logs carry cost, neurons=null).
 * Throws (.code) on auth/network failure so neuronsTracker can fall back.
 */
export async function fetchNeuronsUsage({ since } = {}) {
  if (!isConfigured()) {
    throw Object.assign(new Error('CF analytics not configured'), { code: 'ERR_ANALYTICS_NOT_CONFIGURED' });
  }
  const sinceIso = (since ? new Date(since) : startOfUtcDay()).toISOString();
  if (cache.data && cache.key === sinceIso && (Date.now() - cache.at) < CACHE_TTL_MS) return cache.data;

  // Page 1 also gives us the authoritative request count.
  const first = await fetchPage({ sinceIso, page: 1, perPage: PAGE_SIZE });
  const requests = num(first.result_info?.total_count);

  let ti = 0, to = 0, cost = 0;
  const byModel = new Map();
  const accumulate = (rows) => {
    for (const r of rows || []) {
      ti += num(r.tokens_in); to += num(r.tokens_out); cost += num(r.cost);
      const model = r.model || 'unknown';
      const m = byModel.get(model) || { model, requests: 0, tokens: 0, costUsd: 0 };
      m.requests += 1; m.tokens += num(r.tokens_in) + num(r.tokens_out); m.costUsd += num(r.cost);
      byModel.set(model, m);
    }
  };
  accumulate(first.result);

  const totalPages = Math.min(MAX_PAGES, Math.ceil(requests / PAGE_SIZE) || 1);
  for (let page = 2; page <= totalPages; page++) {
    const p = await fetchPage({ sinceIso, page, perPage: PAGE_SIZE });
    accumulate(p.result);
  }

  const totalNeurons = cost / USD_PER_NEURON;
  const data = {
    totalNeurons: Math.round(totalNeurons * 10000) / 10000,
    totalInputTokens: ti,
    totalOutputTokens: to,
    totalCostUsd: Math.round(cost * 1e6) / 1e6,
    requests,
    byModel: [...byModel.values()]
      .map((m) => ({ ...m, neurons: Math.round((m.costUsd / USD_PER_NEURON) * 100) / 100 }))
      .sort((a, b) => b.neurons - a.neurons),
    window_since: sinceIso,        // 00:00 UTC today
    window_kind: 'utc_day',
    truncated: (Math.ceil(requests / PAGE_SIZE) || 1) > MAX_PAGES,
  };
  cache = { at: Date.now(), key: sinceIso, data };
  return data;
}
