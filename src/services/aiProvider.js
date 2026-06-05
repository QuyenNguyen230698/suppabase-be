import crypto from 'crypto';
import * as cf from './cloudflareAIService.js';
import * as peb from './pebService.js';
import {
  recordUsage,
  shouldFallback,
  reservePending,
  releasePending,
  rekeyPending,
} from './neuronsTracker.js';
import { recordPending, scheduleReconcile } from './usageReconciler.js';
import { withBreaker, isOpen as breakerOpen } from './circuitBreaker.js';
import { resolveProvider } from './providerRouter.js';

// NOTE: Auto-fallback to PEB on the normal /api/chat flow has been removed by
// design. When Cloudflare is unavailable (quota exhausted, transient error, or
// circuit breaker open) we DO NOT silently switch to PEB — instead we surface a
// hard message to the user (see inferenceCore). PEB is only used when an admin
// explicitly routes there (rule 'peb_first' / manual override) or via Pro Plan
// (/api/chat/peb). The AI_AUTO_FALLBACK env flag is therefore no longer honored.

function quotaExceededError() {
  const err = new Error('Daily Cloudflare neurons quota exceeded (resets at UTC 00:00)');
  err.code = 'ERR_QUOTA_EXCEEDED';
  err.status = 429;
  return err;
}

// Cloudflare is down/unreachable (transient upstream error or breaker open) and
// we are NOT falling back to PEB. inferenceCore turns this into a hard reply.
function cloudflareUnavailableError(cause) {
  const err = new Error('Cloudflare AI is temporarily unavailable');
  err.code = 'ERR_CF_UNAVAILABLE';
  err.status = 503;
  if (cause) err.cause = cause;
  return err;
}

function isTransient(err) {
  if (!err) return false;
  if (err.code === 'ERR_CF_UPSTREAM') return true;
  if (err.code === 'ERR_CF_NOT_CONFIGURED') return true;
  if (err.code === 'ERR_BREAKER_OPEN') return true;   // breaker tripped → fallback to PEB
  if (err.name === 'AbortError') return false;
  if (err.status && err.status >= 500) return true;
  if (err.cause?.code === 'ECONNREFUSED' || err.cause?.code === 'ETIMEDOUT') return true;
  if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') return true;
  return false;
}

function schedulePending(logId, meta, provider, endpointKind) {
  if (!logId) return;
  recordPending({
    logId,
    userId: meta?.userId,
    conversationId: meta?.conversationId,
    model: meta?.model,
    provider,
    endpoint: endpointKind,
  }).catch((e) => console.warn('[aiProvider] recordPending failed:', e.message));
}

// Non-stream chat. Provider selection is now runtime (providerRouter):
//   - manual override "peb"   → PEB
//   - manual override "cf"    → CF (still subject to quota)
//   - rule "peb_first"        → PEB
//   - rule "cf_first"         → CF (still subject to quota)
//   - rule "auto" (default)   → CF if quota OK, else PEB
// Returns { content, reasoning, provider, fallback_reason, log_id }.
export async function chat({ messages, model, signal, options, meta }) {
  const active = await resolveProvider({ kind: 'chat' });

  if (active === 'peb') {
    const r = await peb.chat({ messages, signal, options });
    return { ...r, provider: 'peb', fallback_reason: 'router_decision' };
  }

  // CF path — hard-block on quota. No PEB fallback on the normal chat flow.
  if (await shouldFallback()) {
    throw quotaExceededError();
  }

  // Breaker open = CF outage. Previously we fell back to PEB here; now we surface
  // a hard "unavailable" instead.
  if (breakerOpen('cloudflare')) {
    throw cloudflareUnavailableError();
  }

  const tempId = `tmp_${crypto.randomBytes(8).toString('hex')}`;
  reservePending(tempId);
  let realLogId = null;
  try {
    const r = await withBreaker('cloudflare', () => cf.chat({ model, messages, stream: false, signal, options }));
    realLogId = r.logId || null;
    if (realLogId) rekeyPending(tempId, realLogId);
    else releasePending(tempId);
    schedulePending(realLogId, { ...meta, model }, 'cloudflare', 'chat');
    if (realLogId) scheduleReconcile(realLogId, 'cloudflare');
    recordUsage({ fallback: false }).catch(() => {});
    return {
      content: r.content,
      reasoning: '',
      raw: r.raw,
      provider: 'cloudflare',
      log_id: realLogId,
    };
  } catch (err) {
    // Release whichever id is currently holding the reservation.
    releasePending(realLogId || tempId);
    if (err.name === 'AbortError') throw err;
    // CF transient failure → no PEB fallback; report unavailable.
    if (isTransient(err)) throw cloudflareUnavailableError(err);
    throw err;
  }
}

// Open an upstream stream Response with fallback decided BEFORE the stream is opened.
// Returns { response, provider, fallback_reason, log_id }.
export async function openChatStream({ messages, model, signal, options, meta }) {
  const active = await resolveProvider({ kind: 'chat' });

  if (active === 'peb') {
    const response = await peb.chatStream({ messages, signal, options });
    return { response, provider: 'peb', fallback_reason: 'router_decision', log_id: null };
  }

  if (await shouldFallback()) {
    throw quotaExceededError();
  }

  // Breaker open = CF outage. No PEB fallback on the normal chat flow.
  if (breakerOpen('cloudflare')) {
    throw cloudflareUnavailableError();
  }

  const tempId = `tmp_${crypto.randomBytes(8).toString('hex')}`;
  reservePending(tempId);
  let realLogId = null;
  try {
    const r = await withBreaker('cloudflare', () => cf.chat({ model, messages, stream: true, signal, options }));
    realLogId = r.logId || null;
    if (realLogId) rekeyPending(tempId, realLogId);
    else releasePending(tempId);
    schedulePending(realLogId, { ...meta, model }, 'cloudflare', 'chat');
    recordUsage({ fallback: false }).catch(() => {});
    return { response: r.response, provider: 'cloudflare', log_id: realLogId };
  } catch (err) {
    releasePending(realLogId || tempId);
    if (err.name === 'AbortError') throw err;
    // CF transient failure → no PEB fallback; report unavailable.
    if (isTransient(err)) throw cloudflareUnavailableError(err);
    throw err;
  }
}

// Embed — Cloudflare only. No PEB fallback (PEB has no embeddings).
export async function embed(text, model) {
  // Embeddings are infra (RAG, semantic cache, guardrail L3) — they have no
  // PEB alternative, so we ALWAYS go to Cloudflare here regardless of
  // MANUAL_PROVIDER. Quota check below still applies.
  if (await shouldFallback()) {
    throw quotaExceededError();
  }
  return cf.embed(text, model);
}

// Vision — Cloudflare only. No PEB equivalent: vision always runs on CF,
// regardless of router decision. Quota guard still applies.
export async function vision(args) {
  if (await shouldFallback()) {
    throw quotaExceededError();
  }
  const r = await withBreaker('cloudflare', () => cf.vision(args));
  schedulePending(r.logId, { model: args.model }, 'cloudflare', 'vision');
  if (r.logId) scheduleReconcile(r.logId, 'cloudflare');
  return r;
}

// Vision-by-URL — preferred path when images are already on a public-fetchable
// origin (R2 with R2_PUBLIC_DOMAIN). Skips binary upload and uses the
// OpenAI-compat endpoint so multiple images can be passed in one call.
export async function visionByUrl(args) {
  if (await shouldFallback()) {
    throw quotaExceededError();
  }
  const r = await withBreaker('cloudflare', () => cf.visionFromUrl(args));
  schedulePending(r.logId, { model: args.model }, 'cloudflare', 'vision');
  if (r.logId) scheduleReconcile(r.logId, 'cloudflare');
  return r;
}

// Snapshot of routing config. Now reads runtime state via providerRouter, not env.
export async function currentMode() {
  const { getHealth } = await import('./providerRouter.js');
  const h = await getHealth();
  return {
    rule: h.active_rule,
    manual_override: h.manual_override,
    effective_provider_now: h.effective_provider_now,
    auto_fallback: false,   // auto-fallback to PEB removed from the normal chat flow
  };
}
