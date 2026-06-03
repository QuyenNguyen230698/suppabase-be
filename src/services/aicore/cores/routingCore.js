// RoutingCore — build the cache key + decide which inference branch to run.
//
// Ported from chatCore.streamChat (cacheKey assembly + tool-branch condition).
// Provider/quota selection itself lives in ctx.openUpstream (controller-supplied
// via aiProvider.openChatStream), so RoutingCore only chooses cache vs tools vs
// plain stream — it does not pick CF/PEB.

import { isCacheable } from '../../semanticCache.js';
import { toolsForAgent } from '../../tools/index.js';

export function decideBranch(ctx) {
  const { userId, agent, model, systemPrompt, lastUserMsg, docIds, hasImage, source } = ctx;

  ctx.cacheKey = {
    userId: userId || 'public',
    agentTemplateId: agent?.id || null,
    model,
    systemPrompt,
    userContent: lastUserMsg?.content || '',
  };
  ctx.cacheable = isCacheable({ docIds, hasImage, skipCache: false }) && !!lastUserMsg?.content;

  ctx.tools = toolsForAgent(agent);

  // Tools only on the authenticated chat path: public has no agent, and PEB
  // ('pro') doesn't support OpenAI-style tool calls (see chatCore note).
  ctx.branch = (ctx.tools.length && source !== 'public' && source !== 'pro')
    ? 'tools'
    : 'stream';
}
