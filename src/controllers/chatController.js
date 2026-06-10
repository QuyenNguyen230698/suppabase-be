import crypto from 'crypto';
import { query } from '../db/index.js';
import { chat as aiChat, openChatStream } from '../services/aiProvider.js';
import { shouldFallback as quotaExceeded } from '../services/neuronsTracker.js';
import { enqueue, subscribe, stats as queueStats } from '../services/queue/chatQueue.js';
import { similaritySearch, similaritySearchInConversation, buildContext, buildAttachmentManifest } from '../services/ragService.js';
import { resolveLocale, buildSystemPrompt } from '../services/promptService.js';
import { extractTextFromImage, describeImagesByUrl } from '../services/ocrService.js';
import { fetchFromR2, r2PublicUrl } from '../services/r2Service.js';
import { supportsVision } from '../services/modelCapabilities.js';
import { MODELS, isAllowedChatModel, allowedChatModels } from '../services/modelRegistry.js';
import {
  listConversationsBySource,
  getConversationWithMessages,
  deleteConversationBySource,
  upsertConversation,
  saveUserMessage,
  saveAssistantMessage,
  loadConversationMessages,
  loadConversationImageDocIds,
} from '../services/aicore/persistence.js';
import * as AICore from '../services/aicore/index.js';
import { createRequestContext } from '../services/aicore/context.js';
import { QueueSink, CollectSink, ExpressSink } from '../services/aicore/sink.js';
import { resolveAgent, runGuard } from '../services/aicore/cores/guardCore.js';

// For image attachments we pull the bytes back from R2 and run the vision
// model to OCR/describe, then splice the result into the prompt context just
// like document RAG does. Result is concatenated with regular RAG context.
// Exported so pebController can reuse the exact same pipeline — otherwise
// images uploaded while on Pro/PEB never reach the model.
export async function buildImageContext(docIds, userId, opts = {}) {
  if (!docIds?.length) return '';
  const { rows } = await query(
    `SELECT id, name, r2_key, r2_public_url FROM documents
     WHERE user_id = $1 AND id = ANY($2::uuid[]) AND kind = 'image' AND r2_key IS NOT NULL`,
    [userId, docIds],
  );
  if (!rows.length) return '';

  const rich = opts.rich !== false;

  // Path A: batch vision-by-URL via Cloudflare OpenAI-compat endpoint.
  // Model fetches each image directly from R2 — no base64, no embed pipeline,
  // multiple images in one call.
  const urlable = rows
    .map((r) => ({ row: r, url: r.r2_public_url || r2PublicUrl(r.r2_key) }))
    .filter((x) => !!x.url);

  if (urlable.length) {
    const urls = urlable.map((x) => x.url);
    console.log(`[chat] vision-by-url: describing ${urls.length} image(s):`);
    for (const x of urlable) console.log(`  - "${x.row.name}" → ${x.url}`);
    const result = await describeImagesByUrl(urls, { rich });
    if (result.ok && result.content) {
      console.log(`[chat] vision-by-url: ok, ${result.content.length} chars`);
      const namesList = urlable
        .map((x, i) => `IMAGE ${i + 1}: "${x.row.name}" (${x.url})`)
        .join('\n');
      return `[Mô tả các ảnh người dùng đã đính kèm — model vision đã đọc trực tiếp từ R2. Có ${urlable.length} ảnh trong cuộc trò chuyện này, hãy mô tả TẤT CẢ khi được hỏi về ảnh.]\n${namesList}\n\n${result.content}\n\n(Khi trả lời, dựa vào mô tả trên để nói về nội dung TỪNG ảnh trong số ${urlable.length} ảnh, nêu rõ ảnh số mấy nếu có nhiều ảnh. KHÔNG nói rằng bạn chỉ thấy 1 ảnh khi danh sách trên có nhiều ảnh.)`;
    }
    console.warn('[chat] vision-by-url empty, falling back to buffer OCR:', result.reason);
  }

  // Path B fallback: download each image and OCR via native vision endpoint.
  const parts = [];
  for (const row of rows) {
    try {
      const buf = await fetchFromR2(row.r2_key);
      const text = await extractTextFromImage(buf, { rich });
      if (text && text.length > 5) {
        parts.push(`[Hình ảnh "${row.name}" — đã trích xuất bằng vision]\n${text}`);
      } else {
        parts.push(`[Hình ảnh "${row.name}" đã được đính kèm. Hệ thống không trích xuất được nội dung văn bản từ ảnh này. Hãy thừa nhận có ảnh và đề nghị người dùng mô tả lại, KHÔNG bịa nội dung.]`);
      }
    } catch (err) {
      console.warn(`[chat] image fetch/vision failed for ${row.id}:`, err.message);
      parts.push(`[Hình ảnh "${row.name}" đã được đính kèm nhưng xử lý thất bại. Báo người dùng rằng có lỗi tạm thời khi đọc ảnh và đề nghị thử lại. KHÔNG bịa nội dung ảnh.]`);
    }
  }
  return parts.length ? parts.join('\n\n---\n\n') : '';
}

const DEFAULT_PUBLIC_MODEL = MODELS.chatDefault;

/** Public chat — stateless, no auth, no DB. Used by embedded widget. */
export async function publicChat(req, res) {
  const { messages, model } = req.body;
  const chatModel = model || DEFAULT_PUBLIC_MODEL;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages[] is required', code: 'ERR_MESSAGES_REQUIRED' });
  }

  const userMessages = messages.filter((m) => m.role !== 'system').slice(-20);
  if (!userMessages.length) {
    return res.status(400).json({ error: 'No valid user messages', code: 'ERR_MESSAGES_REQUIRED' });
  }

  // Same caps as authenticated chat — public widget must not bypass them.
  const PER_MSG_MAX = 32 * 1024;
  const TOTAL_MAX = 256 * 1024;
  let totalLen = 0;
  for (const m of userMessages) {
    const len = typeof m?.content === 'string' ? m.content.length : 0;
    if (len > PER_MSG_MAX) {
      return res.status(413).json({ error: `Message exceeds ${PER_MSG_MAX} chars`, code: 'ERR_MESSAGE_TOO_LARGE' });
    }
    totalLen += len;
  }
  if (totalLen > TOTAL_MAX) {
    return res.status(413).json({ error: `Total prompt exceeds ${TOTAL_MAX} chars`, code: 'ERR_PROMPT_TOO_LARGE' });
  }

  const locale = resolveLocale(req);

  if (process.env.AI_PROVIDER?.toLowerCase() !== 'peb' && await quotaExceeded()) {
    return res.status(429).json({
      error: 'Daily Cloudflare neurons quota exceeded (resets at UTC 00:00)',
      code: 'ERR_QUOTA_EXCEEDED',
    });
  }

  const publicUsageMeta = {};
  const ctx = createRequestContext({
    source: 'public',
    model: chatModel,
    messages: userMessages,
    persist: false,
    locale,
    usageMeta: publicUsageMeta,
    openUpstream: async (finalMessages, signal) => {
      const { response, provider, log_id } = await openChatStream({
        model: chatModel, messages: finalMessages, signal,
        meta: { model: chatModel },
      });
      publicUsageMeta.provider = provider;
      publicUsageMeta.log_id = log_id;
      return response;
    },
  });
  await AICore.run(ctx, new ExpressSink(res));
}

/** Authenticated chat with persistence + optional RAG. */
export async function sendMessage(req, res) {
  const { model, messages: clientMessages, conversation_id, document_ids, agent_template_id } = req.body;
  const stream = req.body.stream === false || req.body.stream === 'false' ? false : true;

  if (!model) {
    return res.status(400).json({ error: 'model is required', code: 'ERR_MESSAGES_REQUIRED' });
  }
  // Allow-list guard — reject models the FE shouldn't offer (trimmed list), so a
  // hand-crafted request or stale client can't run a removed/unsupported model.
  if (!isAllowedChatModel(model)) {
    return res.status(400).json({
      error: `Model not allowed: ${model}`,
      code: 'ERR_MODEL_NOT_ALLOWED',
      allowed: allowedChatModels(),
    });
  }

  const userId = req.user.id;
  const locale = resolveLocale(req);

  // History merge — server is the source of truth.
  // When a conversation_id is provided, hydrate prior turns from DB so a
  // model/provider switch mid-thread still sees the full context (and any
  // previously uploaded images, see image union below). Client may still
  // send `messages[]` for backwards compat (or to send a new turn); we
  // append only the last user message from the client to the DB history
  // to avoid duplicating turns already persisted.
  let messages = Array.isArray(clientMessages) ? clientMessages.filter((m) => m && m.role && m.content) : [];

  if (conversation_id) {
    try {
      const history = await loadConversationMessages({ userId, conversationId: conversation_id });
      const lastClientUser = [...messages].reverse().find((m) => m.role === 'user');
      const lastDbContent = history.length ? history[history.length - 1].content : null;
      const newUserTurn = lastClientUser && lastClientUser.content !== lastDbContent
        ? [{ role: 'user', content: lastClientUser.content }]
        : [];
      messages = [...history, ...newUserTurn];
    } catch (err) {
      console.warn('[chat] history hydrate failed:', err.message);
    }
  }

  if (!messages.length) {
    return res.status(400).json({ error: 'messages[] or conversation_id with a new user message is required', code: 'ERR_MESSAGES_REQUIRED' });
  }

  // Image docs — union of: docs sent on this request + every image previously
  // attached in this conversation. Lets the model "remember" earlier uploads
  // even after switching to a different provider.
  let docIds = Array.isArray(document_ids) && document_ids.length ? [...document_ids] : [];
  if (conversation_id) {
    try {
      const prior = await loadConversationImageDocIds({ userId, conversationId: conversation_id });
      for (const id of prior) if (!docIds.includes(id)) docIds.push(id);
    } catch (err) {
      console.warn('[chat] prior image docs lookup failed:', err.message);
    }
  }
  if (!docIds.length) docIds = null;

  // No vision-capability gate here — when the chat model is text-only, the
  // image is described via the vision-by-url path (buildImageContext below)
  // and the description is injected as text into the system prompt. The
  // model never has to "see" pixels itself.

  let ragContext = '';
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');

  // Conversation-wide RAG — answers "what was in that file I uploaded earlier?"
  // even when the client doesn't re-send doc_ids on the new turn.
  if (lastUser && conversation_id) {
    try {
      const convChunks = await similaritySearchInConversation(lastUser.content, userId, conversation_id);
      if (convChunks.length) {
        ragContext = buildContext(convChunks) || '';
      }
    } catch (err) {
      console.warn('[chat] conv-wide RAG failed:', err.message);
    }
  }

  if (docIds) {
    try {
      if (lastUser) {
        const chunks = await similaritySearch(lastUser.content, userId, docIds);
        const requestCtx = buildContext(chunks) || '';
        if (requestCtx) {
          ragContext = ragContext ? `${requestCtx}\n\n${ragContext}` : requestCtx;
        }
      }
    } catch (err) {
      console.warn('[chat] RAG lookup failed:', err.message);
    }

    // File manifest — list every attached file so the model can address each
    // by name, even ones whose chunks didn't make the top-K cut.
    try {
      const manifest = await buildAttachmentManifest(docIds, userId);
      if (manifest) ragContext = ragContext ? `${manifest}\n\n${ragContext}` : manifest;
    } catch (err) {
      console.warn('[chat] manifest failed:', err.message);
    }

    // Image attachments: OCR them and append their text to the RAG context so
    // the language model can reason over the visual content too.
    try {
      const imgCtx = await buildImageContext(docIds, userId, { rich: supportsVision(model) });
      if (imgCtx) {
        ragContext = ragContext ? `${ragContext}\n\n---\n\n${imgCtx}` : imgCtx;
      }
    } catch (err) {
      console.warn('[chat] image context failed:', err.message);
    }
  }

  if (!stream) {
    return await sendMessageNonStreaming(req, res, { model, messages, userId, locale, ragContext, convId: conversation_id, agentTemplateId: agent_template_id || null });
  }

  // Pre-flight quota check — must happen before we commit to SSE (once headers
  // go out we're locked into HTTP 200, so errors must be SSE events).
  if (process.env.AI_PROVIDER?.toLowerCase() !== 'peb' && await quotaExceeded()) {
    return res.status(429).json({
      error: 'Daily Cloudflare neurons quota exceeded (resets at UTC 00:00)',
      code: 'ERR_QUOTA_EXCEEDED',
    });
  }

  // Pre-flight guard — the chat flow runs through the queue worker, which can't
  // return an HTTP status once enqueued. So we run GuardCore HERE and return a
  // real 422/429 before enqueuing. The orchestrator skips re-checking via
  // guardAlreadyChecked.
  const userMessagesForGuard = messages.filter((m) => m.role !== 'system');
  const guardAgent = await resolveAgent({ agentTemplateId: agent_template_id || null, conversationId: conversation_id });
  const guard = await runGuard({ userMessages: userMessagesForGuard, agent: guardAgent, userId, locale });
  if (!guard.ok) return res.status(guard.status).json(guard.body);

  // Locked-model agents win: if the resolved agent pins a model, it overrides
  // whatever the client sent (the FE locks the selector, this enforces it).
  const effectiveModel = (guardAgent?.model && isAllowedChatModel(guardAgent.model))
    ? guardAgent.model
    : model;

  // Enqueue the job and return job_id immediately so the client can open the
  // SSE stream at GET /api/chat/stream/:jobId. AICore writes through QueueSink,
  // which routes events to the queue's write() (buffered until the subscriber
  // attaches, then forwarded live).
  const { jobId } = enqueue({
    userId,
    run: async (write, signal) => {
      const usageMeta = {};
      const sink = new QueueSink(write);
      // The original POST request is already closed by the time the worker runs;
      // the queue's AbortSignal fires on client SSE disconnect → tell the sink.
      signal.addEventListener('abort', () => sink.triggerClose(), { once: true });

      const ctx = createRequestContext({
        userId,
        source: 'chat',
        model: effectiveModel,
        messages,
        conversationId: conversation_id,
        agentTemplateId: agent_template_id || null,
        docIds,
        ragContext,
        locale,
        persist: true,
        usageMeta,
        guardAlreadyChecked: true,
        openUpstream: async (finalMessages, sig) => {
          const { response, provider, fallback_reason, log_id } = await openChatStream({
            model: effectiveModel, messages: finalMessages, signal: sig || signal,
            meta: { userId, conversationId: conversation_id, model: effectiveModel },
          });
          usageMeta.provider = provider;
          usageMeta.log_id = log_id;
          if (fallback_reason) usageMeta.fallback_reason = fallback_reason;
          return response;
        },
      });
      await AICore.run(ctx, sink);
    },
  });

  return res.json({ job_id: jobId, queued: true });
}

async function sendMessageNonStreaming(req, res, { model, messages, userId, locale, ragContext, convId, agentTemplateId = null }) {
  try {
    const userMessages = messages.filter(m => m.role !== 'system');

    // Resolve agent + run the shared GuardCore (same verdict shape as the
    // streaming pipeline) so non-stream and stream block identically.
    const { buildAgentSection } = await import('../services/agentTemplateService.js');
    const { logHarmfulOutput, scanOutputHarmful } = await import('../services/guardService.js');
    const agent = await resolveAgent({ agentTemplateId, conversationId: convId });

    const lastUserMsg = [...userMessages].reverse().find(m => m.role === 'user');
    const guard = await runGuard({ userMessages, agent, userId, locale });
    if (!guard.ok) return res.status(guard.status).json(guard.body);

    // Build system prompt with agent section
    const agentSection = agent ? buildAgentSection(agent) : '';
    const basePrompt = await buildSystemPrompt({ scope: 'chat', locale, context: ragContext });
    const systemPromptText = agentSection ? `${agentSection}\n\n${basePrompt}` : basePrompt;
    const finalMessages = [{ role: 'system', content: systemPromptText }, ...userMessages];

    const result = await aiChat({
      model, messages: finalMessages,
      meta: { userId, conversationId: convId, model },
    });
    const rawContent = result.content || '';
    let reasoning = result.reasoning || '';

    // Strip leading plain-prose thinking (qwq, r1-native) so it ends up in
    // `reasoning` instead of leaking into the visible answer.
    const { stripLeadingThinking } = await import('../services/thinkingStripper.js');
    const stripped = stripLeadingThinking(rawContent);
    const postStripContent = stripped.reasoning ? stripped.content : rawContent;
    if (stripped.reasoning) {
      reasoning = reasoning ? `${reasoning}\n\n${stripped.reasoning}` : stripped.reasoning;
    }

    // L6 output scan — replace harmful output with refusal before persist/return.
    const harm = scanOutputHarmful(postStripContent);
    const content = harm.harmful ? harm.safeText : postStripContent;

    const firstUser = userMessages.find(m => m.role === 'user');
    const title = firstUser?.content?.slice(0, 80) || 'New conversation';
    const finalConvId = await upsertConversation({
      userId, model, source: 'chat',
      conversationId: convId, title, agentTemplateId,
    });
    if (lastUserMsg) {
      await saveUserMessage({ convId: finalConvId, content: lastUserMsg.content, agentTemplateId: agent?.id || null });
    }
    const assistantMsgId = await saveAssistantMessage({
      convId: finalConvId,
      content,
      model,
      reasoning,
      tokensIn: null,
      tokensOut: null,
      provider: result.provider || null,
      logId: result.log_id || null,
      fallbackReason: harm.harmful ? `output_blocked:${harm.category}` : (result.fallback_reason || null),
      agentTemplateId: agent?.id || null,
    });
    if (harm.harmful) {
      await logHarmfulOutput({
        userId, agent, conversationId: finalConvId, messageId: assistantMsgId,
        category: harm.category, reason: harm.reason, preview: rawContent,
      });
      res.setHeader('X-Output-Replaced', harm.category);
    }

    if (result.provider) res.setHeader('X-AI-Provider', result.provider);
    if (result.fallback_reason) res.setHeader('X-AI-Fallback-Reason', result.fallback_reason);
    if (result.log_id) res.setHeader('X-AI-Log-Id', result.log_id);

    return res.json({
      id: `chatcmpl-${crypto.randomBytes(6).toString('hex')}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content, ...(reasoning && { reasoning }) },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      conversation_id: finalConvId,
      log_id: result.log_id || null,
      provider: result.provider || null,
    });
  } catch (err) {
    console.error('[chat] Non-stream error:', err.message);
    return res.status(err.status || 500).json({ error: err.message, code: err.code || 'ERR_UPSTREAM' });
  }
}

export async function listConversations(req, res) {
  try {
    const rows = await listConversationsBySource({ userId: req.user.id, source: 'chat' });
    res.json(rows);
  } catch (err) {
    console.error('[chat] listConversations error:', err.message);
    res.status(500).json({ error: 'Failed to load conversations', code: 'ERR_DB' });
  }
}

export async function getConversation(req, res) {
  try {
    const data = await getConversationWithMessages({
      userId: req.user.id, source: 'chat', conversationId: req.params.id,
    });
    if (!data) return res.status(404).json({ error: 'Conversation not found', code: 'ERR_NOT_FOUND' });
    res.json(data);
  } catch (err) {
    console.error('[chat] getConversation error:', err.message);
    res.status(500).json({ error: 'Failed to load conversation', code: 'ERR_DB' });
  }
}

export async function deleteConversation(req, res) {
  try {
    const ok = await deleteConversationBySource({
      userId: req.user.id, source: 'chat', conversationId: req.params.id,
    });
    if (!ok) return res.status(404).json({ error: 'Conversation not found', code: 'ERR_NOT_FOUND' });
    res.json({ success: true });
  } catch (err) {
    console.error('[chat] deleteConversation error:', err.message);
    res.status(500).json({ error: 'Failed to delete conversation', code: 'ERR_DB' });
  }
}

// SSE stream endpoint — client opens this after receiving job_id from POST /api/chat
export function streamJob(req, res) {
  const { jobId } = req.params;
  if (!jobId || !/^[0-9a-f]{32}$/.test(jobId)) {
    return res.status(400).json({ error: 'Invalid job_id', code: 'ERR_INVALID_JOB' });
  }
  subscribe(jobId, res);
}

// Admin/client stats — how full is the queue right now
export function getQueueStats(req, res) {
  res.json(queueStats());
}
