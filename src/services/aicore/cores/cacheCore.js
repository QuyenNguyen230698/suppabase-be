// CacheCore — L2 semantic cache: lookup+replay on hit, serve-stale on upstream
// failure, save after a successful generation.
//
// Ported from chatCore.streamChat (cache hit replay, tryServeStale, cache.save).

import * as cache from '../../semanticCache.js';
import { generateEmbedding } from '../../embeddingService.js';
import { saveAssistantMessage } from '../persistence.js';
import { scanOutput, autoFlagMessage } from '../../guardService.js';
import { chunkifyForReplay } from '../streamParser.js';

const embedFn = async (t) => generateEmbedding(t);

// Returns true if a cache hit was replayed + the sink ended (caller should stop).
export async function lookup(ctx, sink) {
  if (!ctx.cacheable) { ctx.userEmbedding = null; return false; }

  let result;
  try {
    result = await cache.lookup({ ...ctx.cacheKey, embedFn });
  } catch (err) {
    console.warn('[aicore] cache lookup failed:', err.message);
    return false;
  }

  if (!result.hit) {
    ctx.userEmbedding = result.embedding || null;
    return false;
  }

  // Hit — replay as a synthetic stream so client UX is identical.
  for (const c of chunkifyForReplay(result.content)) sink.emit({ type: 'chunk', content: c });
  if (result.reasoning) sink.emit({ type: 'thinking', content: result.reasoning });

  let cachedMsgId = null;
  if (ctx.persist && ctx.convId) {
    cachedMsgId = await saveAssistantMessage({
      convId: ctx.convId, content: result.content, reasoning: result.reasoning,
      model: result.model || ctx.model, tokensIn: 0, tokensOut: 0,
      provider: 'cache', logId: null, fallbackReason: null,
      agentTemplateId: ctx.agent?.id || null,
    });
    const pii = scanOutput(result.content);
    if (cachedMsgId && pii.count > 0) {
      autoFlagMessage(cachedMsgId, 'pii_leak', `Auto-flagged: ${pii.categories.join(', ')} detected in cached output`);
    }
  }

  sink.emit({
    type: 'usage', model: result.model || ctx.model,
    provider: 'cache', cache_hit: result.hit,
    message_id: cachedMsgId,
    similarity: result.similarity ?? null,
    prompt_tokens: 0, completion_tokens: 0,
  });
  sink.end();
  return true;
}

// Serve a stale cache entry when upstream is unavailable. Returns true if served.
export async function serveStale(ctx, sink, reason) {
  if (!ctx.cacheable || !ctx.lastUserMsg?.content) return false;
  try {
    const stale = await cache.lookupStale({ ...ctx.cacheKey, embedFn });
    if (!stale.hit) return false;
    for (const c of chunkifyForReplay(stale.content)) sink.emit({ type: 'chunk', content: c });
    sink.emit({
      type: 'usage', model: stale.model || ctx.model,
      provider: 'cache_stale', cache_hit: stale.hit,
      stale_age_s: Math.round((stale.age_ms || 0) / 1000),
      upstream_error: reason,
      prompt_tokens: 0, completion_tokens: 0,
    });
    if (ctx.persist && ctx.convId) {
      await saveAssistantMessage({
        convId: ctx.convId, content: stale.content, reasoning: stale.reasoning || null,
        model: stale.model || ctx.model, tokensIn: 0, tokensOut: 0,
        provider: 'cache_stale', logId: null, fallbackReason: reason,
        agentTemplateId: ctx.agent?.id || null,
      });
    }
    sink.end();
    return true;
  } catch (err) {
    console.warn('[aicore] stale lookup failed:', err.message);
    return false;
  }
}

// Save a freshly generated answer (fire-and-forget). Skips short + harmful.
export async function save(ctx, { content, reasoning }) {
  if (!ctx.cacheable || !content || content.length <= 20) return;
  try {
    const emb = ctx.userEmbedding || (await generateEmbedding(ctx.lastUserMsg.content).catch(() => null));
    cache.save({ ...ctx.cacheKey, content, reasoning, embedding: emb });
  } catch (err) {
    console.warn('[aicore] cache save failed:', err.message);
  }
}
