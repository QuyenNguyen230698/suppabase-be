// OutputCore — finalize a drained stream: strip thinking, scan output, persist,
// cache, schedule usage reconcile, emit final usage event.
//
// Ported from chatCore.streamChat's parser onDone callback. Emit order is
// preserved exactly (thinking → content_replaced → harmful_output_replaced →
// usage) so the FE behaves identically.

import { stripLeadingThinking } from '../../thinkingStripper.js';
import { scanOutputHarmful, scanOutput, logHarmfulOutput, autoFlagMessage } from '../../guardService.js';
import { scheduleReconcile } from '../../usageReconciler.js';
import { saveAssistantMessage } from '../persistence.js';
import * as cacheCore from './cacheCore.js';

export async function finalizeStream(ctx, sink, summary) {
  const { usageMeta = {}, model, persist, convId, agent, userId } = ctx;

  // 1. Strip leading plain-prose chain-of-thought (qwq / r1-native).
  let content = summary.content;
  let reasoning = summary.reasoning || '';
  const stripped = stripLeadingThinking(summary.content);
  if (stripped.reasoning && stripped.content !== summary.content) {
    content = stripped.content;
    reasoning = reasoning ? `${reasoning}\n\n${stripped.reasoning}` : stripped.reasoning;
    sink.emit({ type: 'thinking', content: stripped.reasoning });
    sink.emit({ type: 'content_replaced', content: stripped.content, reason: 'thinking_stripped' });
  }

  // 2. L6 harmful-output scan.
  let finalContent = content;
  const harm = scanOutputHarmful(content);
  if (harm.harmful) {
    finalContent = harm.safeText;
    sink.emit({ type: 'harmful_output_replaced', category: harm.category, reason: harm.reason, replacement: harm.safeText });
  }

  // 3. Persist.
  let assistantMsgId = null;
  if (persist && convId) {
    assistantMsgId = await saveAssistantMessage({
      convId, content: finalContent, reasoning,
      model, tokensIn: summary.tokensIn, tokensOut: summary.tokensOut,
      provider: usageMeta.provider, logId: usageMeta.log_id,
      fallbackReason: harm.harmful ? `output_blocked:${harm.category}` : usageMeta.fallback_reason,
      agentTemplateId: agent?.id || null,
    });
    if (harm.harmful) {
      await logHarmfulOutput({
        userId, agent, conversationId: convId, messageId: assistantMsgId,
        category: harm.category, reason: harm.reason, preview: summary.content,
      });
    }
    const pii = scanOutput(finalContent);
    if (assistantMsgId && pii.count > 0) {
      autoFlagMessage(assistantMsgId, 'pii_leak', `Auto-flagged: ${pii.categories.join(', ')} detected in assistant output`);
    }
  }

  // 4. Reconcile precise CF usage once the stream is drained.
  if (usageMeta.log_id && usageMeta.provider === 'cloudflare') {
    scheduleReconcile(usageMeta.log_id, 'cloudflare');
  }

  // 5. Cache (skip harmful).
  if (!harm.harmful) await cacheCore.save(ctx, { content: finalContent, reasoning });

  // 6. Final usage event.
  const usageEvent = {
    type: 'usage', model,
    provider: usageMeta.provider || null,
    log_id: usageMeta.log_id || null,
    message_id: assistantMsgId || null,
    prompt_tokens: summary.tokensIn ?? null,
    completion_tokens: summary.tokensOut ?? null,
  };
  if (usageMeta.fallback_reason) usageEvent.fallback_reason = usageMeta.fallback_reason;
  sink.emit(usageEvent);
  sink.end();
}
