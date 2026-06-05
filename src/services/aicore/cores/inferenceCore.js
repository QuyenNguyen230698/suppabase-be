// InferenceCore — generate the answer. Two branches:
//   runTools  — agentic tool loop (non-stream upstream → fake-streamed answer)
//   runStream — open upstream stream → parse → OutputCore.finalizeStream
//
// Ported from chatCore.streamChat (tool branch + stream branch). The abort
// signal is owned by the orchestrator and passed in.

import { runWithTools } from '../../toolExecutor.js';
import { stripLeadingThinking } from '../../thinkingStripper.js';
import {
  scanOutputHarmful, scanOutput, logHarmfulOutput, autoFlagMessage,
} from '../../guardService.js';
import { saveAssistantMessage } from '../persistence.js';
import { createStreamParser, chunkifyForReplay } from '../streamParser.js';
import { finalizeStream } from './outputCore.js';
import * as cacheCore from './cacheCore.js';

// Hard, canned replies shown to the user when Cloudflare can't serve the
// request and we are NOT falling back to PEB (auto-fallback removed by design).
// These are emitted as a normal assistant turn (chunk + done) so the user sees
// a clear message in the thread instead of a red error banner.
const HARD_REPLIES = {
  ERR_QUOTA_EXCEEDED:
    'Hệ thống đã dùng hết hạn mức AI miễn phí trong hôm nay (Cloudflare Workers AI). ' +
    'Hạn mức sẽ tự đặt lại vào 00:00 UTC. Vui lòng thử lại sau, hoặc dùng Pro Plan nếu bạn được cấp quyền.',
  ERR_CF_UNAVAILABLE:
    'Dịch vụ AI (Cloudflare Workers AI) hiện tạm thời không khả dụng. ' +
    'Vui lòng thử lại sau ít phút. Nếu bạn được cấp quyền Pro Plan, có thể chuyển sang Pro Plan để tiếp tục.',
};

// Emit a fixed assistant reply over the sink and persist it like a normal turn.
async function emitHardReply(ctx, sink, code) {
  const content = HARD_REPLIES[code] || HARD_REPLIES.ERR_CF_UNAVAILABLE;
  for (const c of chunkifyForReplay(content)) sink.emit({ type: 'chunk', content: c });
  sink.emit({
    type: 'usage', model: ctx.model,
    provider: 'system', upstream_error: code,
    prompt_tokens: 0, completion_tokens: 0,
  });
  if (ctx.persist && ctx.convId) {
    await saveAssistantMessage({
      convId: ctx.convId, content, reasoning: null,
      model: ctx.model, tokensIn: 0, tokensOut: 0,
      provider: 'system', logId: null, fallbackReason: code,
      agentTemplateId: ctx.agent?.id || null,
    }).catch((e) => console.warn('[aicore] hard-reply persist failed:', e.message));
  }
  sink.end();
}

// ── Tool branch ──────────────────────────────────────────────────
export async function runTools(ctx, sink, signal) {
  const { model, finalMessages, tools, agent, userId, convId, docIds, locale, persist } = ctx;
  try {
    const toolRun = await runWithTools({
      model, messages: finalMessages, tools, signal,
      options: {
        temperature: Number(agent?.temperature ?? 0.6),
        max_tokens: Number(agent?.max_tokens || 4096),
      },
      ctx: { userId, conversationId: convId, docIds, locale, agent },
    });

    if (toolRun.trace.length) sink.emit({ type: 'tool_trace', steps: toolRun.trace });

    const stripped = stripLeadingThinking(toolRun.content);
    const toolReasoning = stripped.reasoning || '';
    const toolContentClean = stripped.content;
    if (toolReasoning) sink.emit({ type: 'thinking', content: toolReasoning });

    const harm = scanOutputHarmful(toolContentClean);
    const finalContent = harm.harmful ? harm.safeText : toolContentClean;

    for (const c of chunkifyForReplay(finalContent)) sink.emit({ type: 'chunk', content: c });
    if (harm.harmful) {
      sink.emit({ type: 'harmful_output_replaced', category: harm.category, reason: harm.reason, replacement: harm.safeText });
    }

    let assistantMsgId = null;
    if (persist && convId) {
      assistantMsgId = await saveAssistantMessage({
        convId, content: finalContent, reasoning: toolReasoning || null,
        model, tokensIn: toolRun.tokensIn, tokensOut: toolRun.tokensOut,
        provider: 'cloudflare', logId: null,
        fallbackReason: harm.harmful ? `output_blocked:${harm.category}` : null,
        agentTemplateId: agent?.id || null,
      });
      if (harm.harmful) {
        await logHarmfulOutput({
          userId, agent, conversationId: convId, messageId: assistantMsgId,
          category: harm.category, reason: harm.reason, preview: toolRun.content,
        });
      }
      const pii = scanOutput(toolRun.content);
      if (assistantMsgId && pii.count > 0) {
        autoFlagMessage(assistantMsgId, 'pii_leak', `Auto-flagged: ${pii.categories.join(', ')} in tool-loop output`);
      }
    }

    sink.emit({
      type: 'usage', model, provider: 'cloudflare',
      message_id: assistantMsgId || null,
      prompt_tokens: toolRun.tokensIn, completion_tokens: toolRun.tokensOut,
      tool_steps: toolRun.steps, truncated: toolRun.truncated || false,
    });
    sink.end();
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('[aicore] tool loop error:', err.message);
    // Cloudflare quota/outage inside the tool loop → hard reply, no PEB fallback.
    if (err.code === 'ERR_QUOTA_EXCEEDED' || err.code === 'ERR_CF_UNAVAILABLE') {
      await emitHardReply(ctx, sink, err.code);
      return;
    }
    sink.emit({ type: 'error', error: 'Tool execution failed', code: 'ERR_TOOL_LOOP' });
    sink.end();
  }
}

// ── Stream branch ────────────────────────────────────────────────
export async function runStream(ctx, sink, controller) {
  const { openUpstream, finalMessages } = ctx;

  let upstreamRes;
  try {
    upstreamRes = await openUpstream(finalMessages, controller.signal);
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('[aicore] upstream open error:', err.message);
    // Quota exhausted or Cloudflare unavailable → no PEB auto-fallback. Prefer a
    // fresh-enough cached answer if we have one, otherwise return a hard,
    // user-facing message (shown as a normal assistant reply, not an error).
    if (err.code === 'ERR_QUOTA_EXCEEDED' || err.code === 'ERR_CF_UNAVAILABLE') {
      if (await cacheCore.serveStale(ctx, sink, `open_error:${err.code}`)) return;
      await emitHardReply(ctx, sink, err.code);
      return;
    }
    if (await cacheCore.serveStale(ctx, sink, `open_error:${err.code || err.message}`)) return;
    await emitHardReply(ctx, sink, 'ERR_CF_UNAVAILABLE');
    return;
  }

  if (!upstreamRes.ok) {
    const txt = await upstreamRes.text().catch(() => '');
    console.error('[aicore] upstream non-OK:', upstreamRes.status, txt.slice(0, 200));
    if (await cacheCore.serveStale(ctx, sink, `http_${upstreamRes.status}`)) return;
    sink.emit({ type: 'error', error: `Upstream ${upstreamRes.status}`, code: 'ERR_UPSTREAM' });
    sink.end();
    return;
  }

  const parser = createStreamParser(sink);
  const reader = upstreamRes.body.getReader();
  try {
    await parser.feed(reader, (summary) => finalizeStream(ctx, sink, summary));
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('[aicore] stream error:', err.message);
    const code = (err.code === 'ERR_STREAM_TIMEOUT' || err.code === 'ERR_STREAM_BUFFER_OVERFLOW')
      ? err.code : 'ERR_STREAM';
    sink.emit({ type: 'error', error: err.message, code });
    try { controller.abort(); } catch {}
    sink.end();
  }
}
