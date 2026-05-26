// semanticCache — in-memory L2 cache for chat responses.
//
// Two tiers inside the app layer:
//   1. Exact-hash:  hash(agent_template_id + system_prompt + last_user_msg + model) → response
//      O(1) lookup; only catches verbatim repeats. Free, instant.
//   2. Semantic:    cosine similarity over user-message embeddings within the
//      same (agent_template_id, model) bucket. Catches paraphrases.
//      Costs 1 embed call per miss to populate, hits are pure RAM.
//
// Storage: in-memory Map with LRU + TTL eviction. Bounded size.
//
// Caveats:
//   • Streaming responses are NOT cached on the streaming path — we cache the
//     final concatenated content after the stream finishes, then replay synthetically
//     on cache hit (chunked SSE) so the client UX is identical.
//   • We skip caching when the message has document attachments (RAG context
//     changes per conversation) or images.

import crypto from 'crypto';

const MAX_ENTRIES = parseInt(process.env.CACHE_MAX_ENTRIES || '500', 10);
const DEFAULT_TTL_MS = (parseInt(process.env.CACHE_TTL_S || '3600', 10)) * 1000;
const SIM_THRESHOLD = parseFloat(process.env.CACHE_SIM_THRESHOLD || '0.92');
// Stale entries stay in memory up to STALE_MAX_AGE_MS, served only as fallback.
const STALE_MAX_AGE_MS = (parseInt(process.env.CACHE_STALE_MAX_S || '86400', 10)) * 1000;

// Map<key, { content, reasoning, model, embedding, agentBucket, at }>
const store = new Map();

// Counters for stats endpoint
const stats = {
  exact_hits: 0,
  semantic_hits: 0,
  stale_hits: 0,
  misses: 0,
  evictions: 0,
  stored: 0,
  skipped: 0,
};

// Only fully expired entries (past STALE_MAX_AGE_MS) get evicted, plus LRU overflow.
function evictExpiredAndOverflow() {
  const now = Date.now();
  for (const [k, v] of store) {
    if (now - v.at > STALE_MAX_AGE_MS) {
      store.delete(k);
      stats.evictions++;
    }
  }
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
    stats.evictions++;
  }
}

function isFresh(entry) {
  return Date.now() - entry.at <= DEFAULT_TTL_MS;
}

// Cache is scoped per (userId, agentTemplateId, model) so two users asking
// semantically similar questions can never share a cached answer — the system
// prompt may already contain user memories/PII, and even when it doesn't,
// agent-level personalisation differs across accounts. `userId='public'` is
// reserved for the unauthenticated widget where there's no per-user state.
function scopeOf({ userId, agentTemplateId, model }) {
  return `${userId || 'public'}::${agentTemplateId || 'none'}::${model || 'default'}`;
}

function exactKey({ userId, agentTemplateId, model, systemPrompt, userContent }) {
  return crypto
    .createHash('sha256')
    .update(`${scopeOf({ userId, agentTemplateId, model })}::${systemPrompt}::${userContent}`)
    .digest('hex')
    .slice(0, 32);
}

function bucketOf({ userId, agentTemplateId, model }) {
  return scopeOf({ userId, agentTemplateId, model });
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Look up cached response.
 *   - opts.userContent       : last user message text
 *   - opts.systemPrompt      : assembled system prompt (includes agent rules)
 *   - opts.agentTemplateId   : agent id (may be null)
 *   - opts.model             : model id (may be null)
 *   - opts.embedFn?          : async (text) => number[] — optional, enables semantic layer
 *
 * Returns { hit: 'exact'|'semantic'|null, content, reasoning, similarity? }
 */
export async function lookup(opts) {
  evictExpiredAndOverflow();

  const ek = exactKey(opts);
  if (store.has(ek)) {
    const hit = store.get(ek);
    if (isFresh(hit)) {
      // Touch (re-insert) for LRU recency
      store.delete(ek);
      store.set(ek, hit);
      stats.exact_hits++;
      return { hit: 'exact', content: hit.content, reasoning: hit.reasoning, model: hit.model };
    }
    // exact entry exists but stale → fall through to semantic, may serve via stale fallback
  }

  // Semantic layer — only if caller provides embedFn
  if (opts.embedFn) {
    const bucket = bucketOf(opts);
    let q;
    try {
      q = await opts.embedFn(opts.userContent);
    } catch {
      stats.misses++;
      return { hit: null };
    }
    let best = { score: 0, entry: null };
    for (const v of store.values()) {
      if (v.agentBucket !== bucket || !v.embedding) continue;
      if (!isFresh(v)) continue;
      const s = cosine(q, v.embedding);
      if (s > best.score) best = { score: s, entry: v };
    }
    if (best.score >= SIM_THRESHOLD && best.entry) {
      stats.semantic_hits++;
      return {
        hit: 'semantic',
        content: best.entry.content,
        reasoning: best.entry.reasoning,
        model: best.entry.model,
        similarity: best.score,
      };
    }
  }

  stats.misses++;
  return { hit: null };
}

/**
 * Stale fallback — only used when upstream fails. Returns any entry (fresh or
 * stale up to STALE_MAX_AGE_MS) that matches exactly or is semantically close.
 * Caller MUST signal this came from stale cache so user knows it may be old.
 */
export async function lookupStale(opts) {
  evictExpiredAndOverflow();
  const ek = exactKey(opts);
  if (store.has(ek)) {
    const hit = store.get(ek);
    stats.stale_hits++;
    return {
      hit: 'stale_exact',
      content: hit.content,
      reasoning: hit.reasoning,
      model: hit.model,
      age_ms: Date.now() - hit.at,
    };
  }
  if (opts.embedFn) {
    const bucket = bucketOf(opts);
    let q;
    try { q = await opts.embedFn(opts.userContent); } catch { return { hit: null }; }
    // For stale fallback we relax the threshold slightly to maximise availability
    const threshold = Math.max(0.85, SIM_THRESHOLD - 0.05);
    let best = { score: 0, entry: null };
    for (const v of store.values()) {
      if (v.agentBucket !== bucket || !v.embedding) continue;
      const s = cosine(q, v.embedding);
      if (s > best.score) best = { score: s, entry: v };
    }
    if (best.score >= threshold && best.entry) {
      stats.stale_hits++;
      return {
        hit: 'stale_semantic',
        content: best.entry.content,
        reasoning: best.entry.reasoning,
        model: best.entry.model,
        similarity: best.score,
        age_ms: Date.now() - best.entry.at,
      };
    }
  }
  return { hit: null };
}

/**
 * Store a finalised response in cache.
 *   - opts.* same as lookup
 *   - opts.content / opts.reasoning
 *   - opts.embedding? : precomputed embedding of userContent (for semantic layer)
 */
export function store_(opts) {
  if (!opts.content) { stats.skipped++; return; }
  evictExpiredAndOverflow();
  const ek = exactKey(opts);
  store.set(ek, {
    content: opts.content,
    reasoning: opts.reasoning || null,
    model: opts.model || null,
    embedding: opts.embedding || null,
    agentBucket: bucketOf(opts),
    at: Date.now(),
  });
  stats.stored++;
}
export { store_ as save };

export function getStats() {
  const total = stats.exact_hits + stats.semantic_hits + stats.misses;
  return {
    ...stats,
    size: store.size,
    capacity: MAX_ENTRIES,
    ttl_seconds: DEFAULT_TTL_MS / 1000,
    sim_threshold: SIM_THRESHOLD,
    hit_rate: total ? ((stats.exact_hits + stats.semantic_hits) / total).toFixed(3) : '0',
  };
}

export function clear() {
  store.clear();
  for (const k of Object.keys(stats)) stats[k] = 0;
}

/**
 * Decide whether a chat request is cacheable at app level.
 * Skip when:
 *   - has document attachments (RAG context varies)
 *   - has images
 *   - explicit no-cache opt
 */
export function isCacheable({ docIds, hasImage, skipCache }) {
  if (skipCache) return false;
  if (docIds && docIds.length) return false;
  if (hasImage) return false;
  return true;
}
