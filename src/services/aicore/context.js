// RequestContext — the state object threaded through the AICore pipeline.
//
// Replaces the ~20 local variables the old chatCore.streamChat carried. Cores
// read input fields and fill derived ones as the request flows through
// Guard → Context → Routing → Cache → Inference → Output.

export function createRequestContext(opts) {
  const {
    source, userId = null, model, messages,
    conversationId = null, locale = 'en',
    docIds = null, hasImage = false, ragContext = '',
    persist = true, agentTemplateId = null,
    usageMeta = {}, openUpstream,
    // Set by the controller when it already ran GuardCore pre-enqueue (chat
    // flow) so the orchestrator doesn't double-check. Public/pro run guard
    // inside the pipeline.
    guardAlreadyChecked = false,
  } = opts;

  return {
    // input
    source, userId, model, messages, conversationId, locale,
    docIds, hasImage, ragContext, persist, agentTemplateId,
    usageMeta, openUpstream, guardAlreadyChecked,

    // derived (filled by cores)
    userMessages: null,
    lastUserMsg: null,
    agent: null,
    systemPrompt: '',
    finalMessages: null,
    inputWarnings: [],
    convId: conversationId,
    userMsgId: null,
    cacheKey: null,
    cacheable: false,
    userEmbedding: null,
    branch: 'stream',
    tools: [],
  };
}
