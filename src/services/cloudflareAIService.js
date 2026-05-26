import { recordUsage } from './neuronsTracker.js';

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '';
const AI_TOKEN = process.env.CF_AI_TOKEN || '';
// Strip any wrapping double quotes that may leak in from .env files.
const GATEWAY_ID = (process.env.CF_AI_GATEWAY_ID || '').replace(/^"|"$/g, '');

const DEFAULT_CHAT_MODEL = process.env.DEFAULT_MODEL || '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b';
const DEFAULT_VISION_MODEL = process.env.VISION_MODEL || '@cf/meta/llama-3.2-11b-vision-instruct';
const DEFAULT_EMBED_MODEL = process.env.EMBED_MODEL || '@cf/baai/bge-m3';

function assertConfigured() {
  if (!ACCOUNT_ID || !AI_TOKEN) {
    const err = new Error('Cloudflare Workers AI not configured (CF_ACCOUNT_ID / CF_AI_TOKEN)');
    err.code = 'ERR_CF_NOT_CONFIGURED';
    throw err;
  }
}

function endpoint(model) {
  if (GATEWAY_ID) {
    return `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/${GATEWAY_ID}/workers-ai/run/${model}`;
  }
  return `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${model}`;
}

// OpenAI-compatible endpoint — supports tool calling reliably across Llama 3.x
function openaiCompatEndpoint() {
  if (GATEWAY_ID) {
    return `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/${GATEWAY_ID}/workers-ai/v1/chat/completions`;
  }
  return `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1/chat/completions`;
}

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${AI_TOKEN}`, ...extra };
}

// Cloudflare Workers AI defaults max_tokens to ~256 which is far too low for
// reasoning models like DeepSeek R1 — the model spends the budget on <think>
// and never emits user-facing content. Default to 4096; callers can override.
const DEFAULT_MAX_TOKENS = parseInt(process.env.CF_MAX_TOKENS || '4096', 10);

// AI Gateway cache settings — only applied when GATEWAY_ID is configured.
// Default 1h TTL; callers can override via options.cacheTtl or disable via skipCache.
const DEFAULT_CACHE_TTL = parseInt(process.env.CF_AIG_CACHE_TTL || '3600', 10);

function gatewayCacheHeaders({ skipCache = false, cacheTtl = DEFAULT_CACHE_TTL } = {}) {
  if (!GATEWAY_ID) return {};
  if (skipCache) return { 'cf-aig-skip-cache': 'true' };
  return { 'cf-aig-cache-ttl': String(cacheTtl) };
}

export async function chat({ model, messages, stream = false, signal, options = {} }) {
  assertConfigured();
  const useModel = model || DEFAULT_CHAT_MODEL;
  const body = {
    messages,
    stream,
    temperature: options.temperature ?? 0.6,
    top_p: options.top_p ?? 0.95,
    max_tokens: options.max_tokens ?? DEFAULT_MAX_TOKENS,
  };

  // Cache only deterministic requests (low temperature). Skip when caller asks,
  // or when temperature suggests creative/varied output.
  const cacheable = !options.skipCache && (options.temperature ?? 0.6) <= 0.3;
  const cacheHeaders = gatewayCacheHeaders({
    skipCache: !cacheable,
    cacheTtl: options.cacheTtl,
  });

  const res = await fetch(endpoint(useModel), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', ...cacheHeaders }),
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Cloudflare AI chat failed (${res.status}): ${text}`);
    err.code = res.status >= 500 ? 'ERR_CF_UPSTREAM' : 'ERR_CF_REQUEST';
    err.status = res.status;
    throw err;
  }

  const logId = res.headers.get('cf-aig-log-id') || null;
  const cacheHit = res.headers.get('cf-aig-cache-status') === 'HIT';
  recordUsage({ cacheHit }).catch(() => {});   // bump request_count; neurons come from reconciler

  if (stream) return { response: res, logId, cacheHit };

  const data = await res.json();
  const result = data.result || data;
  const content = result.response ?? result.choices?.[0]?.message?.content ?? '';
  return { content, raw: data, logId, cacheHit };
}

// OpenAI-compatible chat (non-stream) — needed for tool calling because the
// native workers-ai/run/* endpoint doesn't expose tool_calls reliably.
export async function chatWithTools({ model, messages, tools, signal, options = {} }) {
  assertConfigured();
  const useModel = model || DEFAULT_CHAT_MODEL;
  const body = {
    model: useModel,
    messages,
    tools,
    tool_choice: options.tool_choice || 'auto',
    temperature: options.temperature ?? 0.3,
    max_tokens: options.max_tokens ?? DEFAULT_MAX_TOKENS,
  };
  const res = await fetch(openaiCompatEndpoint(), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Cloudflare OpenAI-compat failed (${res.status}): ${text.slice(0, 200)}`);
    err.code = res.status >= 500 ? 'ERR_CF_UPSTREAM' : 'ERR_CF_REQUEST';
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const choice = data.choices?.[0]?.message || {};
  return {
    message: choice,                    // { role, content, tool_calls? }
    usage: data.usage || {},
    logId: res.headers.get('cf-aig-log-id') || null,
    raw: data,
  };
}

export async function embed(text, model = DEFAULT_EMBED_MODEL) {
  assertConfigured();
  const res = await fetch(endpoint(model), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ text: Array.isArray(text) ? text : [text] }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`Cloudflare AI embed failed (${res.status}): ${errText}`);
    err.code = res.status >= 500 ? 'ERR_CF_UPSTREAM' : 'ERR_CF_REQUEST';
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  recordUsage({}).catch(() => {});
  const result = data.result || data;
  const vectors = result.data || result.embeddings || [];
  return Array.isArray(text) ? vectors : vectors[0] || [];
}

export async function vision({ imageBuffer, prompt, systemPrompt, model, signal }) {
  assertConfigured();
  const useModel = model || DEFAULT_VISION_MODEL;
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const body = {
    messages,
    image: Array.from(imageBuffer),
    max_tokens: 2048,
  };

  const res = await fetch(endpoint(useModel), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Cloudflare AI vision failed (${res.status}): ${text}`);
    err.code = res.status >= 500 ? 'ERR_CF_UPSTREAM' : 'ERR_CF_REQUEST';
    err.status = res.status;
    throw err;
  }
  const logId = res.headers.get('cf-aig-log-id') || null;
  recordUsage({}).catch(() => {});
  const data = await res.json();
  const result = data.result || data;
  const content = result.response ?? result.description ?? '';
  return { content, raw: data, logId };
}

// Vision via URL — uses the OpenAI-compatible chat/completions endpoint so we
// can pass `image_url` parts pointing at R2 directly. The model fetches the
// image itself; we never have to base64-encode + ship binary, and embedding
// quota is not consumed. Works on Llama 3.2 Vision and Llama 4 Scout.
export async function visionFromUrl({ imageUrls, prompt, systemPrompt, model, signal, options = {} }) {
  assertConfigured();
  const useModel = model || DEFAULT_VISION_MODEL;
  const urls = Array.isArray(imageUrls) ? imageUrls : [imageUrls];

  const userContent = [
    { type: 'text', text: prompt },
    ...urls.map((url) => ({ type: 'image_url', image_url: { url } })),
  ];

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userContent });

  const body = {
    model: useModel,
    messages,
    temperature: options.temperature ?? 0.2,
    max_tokens: options.max_tokens ?? 2048,
  };

  const res = await fetch(openaiCompatEndpoint(), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Cloudflare vision-by-url failed (${res.status}): ${text.slice(0, 300)}`);
    err.code = res.status >= 500 ? 'ERR_CF_UPSTREAM' : 'ERR_CF_REQUEST';
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  return { content, raw: data, logId: res.headers.get('cf-aig-log-id') || null };
}

export const models = {
  chat: DEFAULT_CHAT_MODEL,
  vision: DEFAULT_VISION_MODEL,
  embed: DEFAULT_EMBED_MODEL,
};
