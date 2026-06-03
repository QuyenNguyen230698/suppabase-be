// AICore — the chat pipeline orchestrator.
//
//   resolveAgent → Guard → Context → persistInput → (open SSE)
//   → conversation_id + guard_warnings → decideBranch
//   → CacheCore.lookup (hit → done) → InferenceCore (tools | stream)
//
// Shared by all three flows via a StreamSink (Express / Queue / Collect).
// Guard runs here for public/pro; the chat flow runs it pre-enqueue and sets
// ctx.guardAlreadyChecked so it isn't re-run (but it's idempotent if it is).

import { resolveAgent, runGuard } from './cores/guardCore.js';
import { buildContext } from './cores/contextCore.js';
import { decideBranch } from './cores/routingCore.js';
import * as cacheCore from './cores/cacheCore.js';
import { runTools, runStream } from './cores/inferenceCore.js';
import {
  upsertConversation, saveUserMessage, linkDocumentsToMessage,
} from './persistence.js';
import { incrementUsage as incrementAgentUsage } from '../agentTemplateService.js';

function prepMessages(ctx) {
  ctx.userMessages = (ctx.messages || []).filter((m) => m.role !== 'system');
  ctx.lastUserMsg = [...ctx.userMessages].reverse().find((m) => m.role === 'user');
}

// Persist conversation + user message. Returns null on success, or a verdict
// { ok:false, status, body } on DB failure.
async function persistInput(ctx) {
  if (!(ctx.persist && ctx.userId)) { ctx.convId = ctx.conversationId; return null; }
  try {
    const firstUser = ctx.userMessages.find((m) => m.role === 'user');
    const title = firstUser?.content?.slice(0, 80) || 'New conversation';
    ctx.convId = await upsertConversation({
      userId: ctx.userId, model: ctx.model, source: ctx.source,
      conversationId: ctx.conversationId, title, agentTemplateId: ctx.agent?.id || null,
    });
    if (ctx.agent?.id && !ctx.conversationId) incrementAgentUsage(ctx.agent.id);

    const lastUser = ctx.userMessages[ctx.userMessages.length - 1];
    if (lastUser?.role === 'user') {
      ctx.userMsgId = await saveUserMessage({ convId: ctx.convId, content: lastUser.content, agentTemplateId: ctx.agent?.id || null });
      await linkDocumentsToMessage({ messageId: ctx.userMsgId, convId: ctx.convId, docIds: ctx.docIds });
    }
    return null;
  } catch (err) {
    console.error('[aicore] DB persist error:', err.message);
    return { ok: false, status: 500, body: { error: 'Database error', code: 'ERR_DB' } };
  }
}

export async function run(ctx, sink) {
  prepMessages(ctx);
  if (!ctx.userMessages.length) {
    sink.fail(400, { error: 'messages[] required', code: 'ERR_MESSAGES_REQUIRED' });
    return;
  }

  // 0. Resolve agent (needed by guard L2 + context).
  ctx.agent = await resolveAgent({ agentTemplateId: ctx.agentTemplateId, conversationId: ctx.conversationId });

  // 1. Guard (skip if controller already did it pre-enqueue).
  if (!ctx.guardAlreadyChecked) {
    const g = await runGuard({ userMessages: ctx.userMessages, agent: ctx.agent, userId: ctx.userId, locale: ctx.locale });
    if (!g.ok) { sink.fail(g.status, g.body); return; }
    ctx.inputWarnings = g.warnings;
  }

  // 2. Context (system prompt + final messages).
  await buildContext(ctx);

  // 3. Persist conversation + user message.
  const p = await persistInput(ctx);
  if (p) { sink.fail(p.status, p.body); return; }

  // 4. Open SSE + lifecycle.
  sink.openHeaders(ctx.convId);
  const stopHeartbeat = sink.startHeartbeat();
  const controller = new AbortController();
  sink.onClose(() => { stopHeartbeat(); try { controller.abort(); } catch {} });

  if (ctx.convId) sink.emit({ type: 'conversation_id', conversation_id: ctx.convId });
  if (ctx.inputWarnings?.length) sink.emit({ type: 'guard_warnings', warnings: ctx.inputWarnings });

  // 5. Routing + cache.
  decideBranch(ctx);
  try {
    if (await cacheCore.lookup(ctx, sink)) return; // hit → replayed + ended

    if (ctx.branch === 'tools') await runTools(ctx, sink, controller.signal);
    else                        await runStream(ctx, sink, controller);
  } finally {
    stopHeartbeat();
  }
}
