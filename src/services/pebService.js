const PEB_API_URL = 'https://supabase.pebsteel.com/functions/v1/ollama-proxy';
const PEB_API_KEY = process.env.PEB_API_KEY || '';
const PEB_MODEL = process.env.PEB_MODEL || 'qwen3.6:35b';

export const PEB_FALLBACK_MODEL = PEB_MODEL;

export function isConfigured() {
  return !!PEB_API_KEY;
}

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${PEB_API_KEY}`, ...extra };
}

// Returns the raw upstream Response — caller pipes the stream (SSE / NDJSON).
export async function chatStream({ messages, model = PEB_MODEL, signal, options = {} }) {
  if (!PEB_API_KEY) {
    const err = new Error('PEB API key not configured');
    err.code = 'ERR_PEB_NOT_CONFIGURED';
    throw err;
  }
  const payload = {
    model,
    messages,
    stream: true,
    temperature: options.temperature ?? 0,
    top_p: options.top_p ?? 0.9,
  };
  const res = await fetch(PEB_API_URL, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`PEB upstream error (${res.status}): ${text}`);
    err.code = 'ERR_PEB_UPSTREAM';
    err.status = res.status;
    throw err;
  }
  return res;
}

export async function chat({ messages, model = PEB_MODEL, signal, options = {} }) {
  if (!PEB_API_KEY) {
    const err = new Error('PEB API key not configured');
    err.code = 'ERR_PEB_NOT_CONFIGURED';
    throw err;
  }
  const payload = {
    model,
    messages,
    stream: false,
    temperature: options.temperature ?? 0,
    top_p: options.top_p ?? 0.9,
  };
  const res = await fetch(PEB_API_URL, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`PEB upstream error (${res.status}): ${text}`);
    err.code = 'ERR_PEB_UPSTREAM';
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const msg = data.message?.content != null ? data.message : data.choices?.[0]?.message;
  const raw = msg?.content || '';
  const reasoning = (msg?.thinking || msg?.reasoning || '').trim();
  const thinkMatch = !reasoning && raw.match(/^<think>([\s\S]*?)<\/think>\s*/);
  const content = thinkMatch ? raw.slice(thinkMatch[0].length) : raw;
  const finalReasoning = reasoning || (thinkMatch ? thinkMatch[1].trim() : '');
  return { content, reasoning: finalReasoning, raw: data };
}
