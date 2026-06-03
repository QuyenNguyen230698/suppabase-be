// GuardCore — block malicious input BEFORE spending tokens.
//
// Ported from chatCore.streamChat (the 0b safety pre-check). Returns a verdict:
//   { ok: true, warnings }                     → proceed
//   { ok: false, status, body }                → short-circuit (HTTP status)
//
// Runs both at the controller (pre-enqueue, so the chat flow returns a real
// 422/429 before opening SSE) and is idempotent if the orchestrator re-checks.

import { resolveForRequest } from '../../agentTemplateService.js';
import { checkUserMessage, scanHistoryForPriming } from '../../guardService.js';
import { buildRefusal } from '../../refusalMessage.js';

// Resolve the agent template — needed before guard (L2 uses block_patterns) and
// before context build. Safe to call once and stash on ctx.
export async function resolveAgent({ agentTemplateId, conversationId }) {
  return resolveForRequest({ agentTemplateId, conversationId }).catch(() => null);
}

// userMessages: history minus system. agent: resolved template (may be null).
export async function runGuard({ userMessages, agent, userId, locale }) {
  const lastUserMsg = [...userMessages].reverse().find((m) => m.role === 'user');
  if (!lastUserMsg?.content) return { ok: true, warnings: [] };

  // Many-shot defense: scan earlier turns for priming attacks.
  const hist = await scanHistoryForPriming(userMessages, { userId });
  if (!hist.safe) {
    return {
      ok: false,
      status: 422,
      body: {
        error: buildRefusal({ locale, category: hist.category, layer: hist.layer, agentFallback: agent?.fallback_response }),
        code: 'ERR_GUARDRAIL_BLOCKED',
        layer: hist.layer, category: hist.category, severity: hist.severity,
      },
    };
  }

  const v = await checkUserMessage(lastUserMsg.content, agent, { userId });
  if (!v.safe) {
    const status = v.status || 422;
    const code = v.layer === 'L7_rate_limit' ? 'ERR_RATE_LIMITED' : 'ERR_GUARDRAIL_BLOCKED';
    return {
      ok: false,
      status,
      body: {
        error: buildRefusal({ locale, category: v.category, layer: v.layer, agentFallback: agent?.fallback_response }),
        code, layer: v.layer, category: v.category, severity: v.severity,
        score: v.score, block_until: v.block_until, escalation: v.escalation,
      },
    };
  }

  return { ok: true, warnings: v.warnings || [] };
}
