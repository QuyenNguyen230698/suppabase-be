// Fetch per-request usage details from the Cloudflare AI Gateway Logs API.
//
// Endpoint:
//   GET /accounts/{account_id}/ai-gateway/gateways/{gateway_id}/logs/{log_id}
//
// Token must have BOTH "Workers AI:Read" and "AI Gateway:Read" scopes.

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '';
const AI_TOKEN = process.env.CF_AI_TOKEN || '';
const GATEWAY_ID = (process.env.CF_AI_GATEWAY_ID || '').replace(/^"|"$/g, '');

// Approx pricing: $0.011 per 1k neurons (Workers AI free tier billing rate).
// If the API returns neurons directly, we use that instead.
const USD_PER_NEURON = 0.011 / 1000;

export function isGatewayConfigured() {
  return !!(ACCOUNT_ID && AI_TOKEN && GATEWAY_ID);
}

export async function fetchLog(logId) {
  if (!isGatewayConfigured()) {
    throw Object.assign(new Error('AI Gateway not configured'), { code: 'ERR_GATEWAY_NOT_CONFIGURED' });
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai-gateway/gateways/${GATEWAY_ID}/logs/${logId}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${AI_TOKEN}` },
  });
  if (res.status === 404) {
    const err = new Error('Log not found yet');
    err.code = 'ERR_LOG_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Gateway logs fetch failed (${res.status}): ${text}`);
    err.code = 'ERR_GATEWAY_LOGS';
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return parseLog(data);
}

function parseLog(data) {
  const r = data.result ?? data;
  const tokens_in = numOrNull(r.tokens_in ?? r.prompt_tokens ?? r.usage?.prompt_tokens);
  const tokens_out = numOrNull(r.tokens_out ?? r.completion_tokens ?? r.usage?.completion_tokens);
  const cost_usd = numOrNull(r.cost ?? r.cost_usd);
  const neuronsField = numOrNull(r.neurons ?? r.usage?.neurons);
  const neurons = neuronsField != null
    ? neuronsField
    : (cost_usd != null ? cost_usd / USD_PER_NEURON : null);
  return {
    tokens_in,
    tokens_out,
    neurons,
    cost_usd,
    duration_ms: numOrNull(r.duration ?? r.duration_ms),
    cached: !!(r.cached ?? r.cache_status === 'HIT'),
    model: r.model || null,
    raw: r,
  };
}

function numOrNull(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}
