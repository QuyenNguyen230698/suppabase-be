import crypto from 'crypto';
import { query } from '../db/index.js';
import { chat as aiChat, openChatStream } from '../services/aiProvider.js';
import { shouldFallback as quotaExceeded } from '../services/neuronsTracker.js';
import { similaritySearch, buildContext, buildAttachmentManifest } from '../services/ragService.js';
import { resolveLocale, buildSystemPrompt } from '../services/promptService.js';
import { extractTextFromImage } from '../services/ocrService.js';
import { fetchFromR2 } from '../services/r2Service.js';
import {
  streamChat,
  listConversationsBySource,
  getConversationWithMessages,
  deleteConversationBySource,
  upsertConversation,
  saveUserMessage,
  saveAssistantMessage,
} from '../services/chatCore.js';

// For image attachments we pull the bytes back from R2 and run the vision
// model to OCR/describe, then splice the result into the prompt context just
// like document RAG does. Result is concatenated with regular RAG context.
// Exported so pebController can reuse the exact same pipeline — otherwise
// images uploaded while on Pro/PEB never reach the model.
export async function buildImageContext(docIds, userId) {
  if (!docIds?.length) return '';
  const { rows } = await query(
    `SELECT id, name, r2_key FROM documents
     WHERE user_id = $1 AND id = ANY($2::uuid[]) AND kind = 'image' AND r2_key IS NOT NULL`,
    [userId, docIds],
  );
  if (!rows.length) return '';

  const parts = [];
  for (const row of rows) {
    try {
      const buf = await fetchFromR2(row.r2_key);
      const text = await extractTextFromImage(buf);
      if (text && text.length > 5) {
        parts.push(`[Hình ảnh "${row.name}" — đã trích xuất bằng vision]\n${text}`);
      } else {
        // Vision returned empty (often: quota exhausted, unsupported format,
        // or genuinely no extractable text). Tell the model the image WAS
        // attached so it doesn't gaslight the user with "no image uploaded".
        parts.push(`[Hình ảnh "${row.name}" đã được người dùng đính kèm nhưng hệ thống vision tạm thời không trích xuất được nội dung. Hãy thông báo lại với người dùng rằng dịch vụ vision đang gặp sự cố, không nói rằng họ chưa upload ảnh.]`);
      }
    } catch (err) {
      console.warn(`[chat] image fetch/vision failed for ${row.id}:`, err.message);
      parts.push(`[Hình ảnh "${row.name}" đã được người dùng đính kèm nhưng không xử lý được do lỗi hệ thống. Đừng nói rằng họ chưa upload ảnh.]`);
    }
  }
  return parts.length ? parts.join('\n\n---\n\n') : '';
}

const DEFAULT_PUBLIC_MODEL = process.env.DEFAULT_MODEL || '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b';

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
  await streamChat(req, res, {
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
}

/** Authenticated chat with persistence + optional RAG. */
export async function sendMessage(req, res) {
  const { model, messages, conversation_id, document_ids, agent_template_id } = req.body;
  const stream = req.body.stream === false || req.body.stream === 'false' ? false : true;

  if (!model || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'model and messages[] are required', code: 'ERR_MESSAGES_REQUIRED' });
  }

  const userId = req.user.id;
  const locale = resolveLocale(req);

  const docIds = Array.isArray(document_ids) && document_ids.length ? document_ids : null;
  let ragContext = '';
  if (docIds) {
    try {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      if (lastUser) {
        const chunks = await similaritySearch(lastUser.content, userId, docIds);
        ragContext = buildContext(chunks) || '';
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
      const imgCtx = await buildImageContext(docIds, userId);
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

  // Pre-flight quota check before opening the SSE response. Once SSE headers
  // go out we're locked into 200, so we can't return a clean 429 from inside
  // the stream. Catching it here lets the client see a real HTTP status.
  if (process.env.AI_PROVIDER?.toLowerCase() !== 'peb' && await quotaExceeded()) {
    return res.status(429).json({
      error: 'Daily Cloudflare neurons quota exceeded (resets at UTC 00:00)',
      code: 'ERR_QUOTA_EXCEEDED',
    });
  }

  const usageMeta = {};
  await streamChat(req, res, {
    userId,
    source: 'chat',
    model,
    messages,
    conversationId: conversation_id,
    agentTemplateId: agent_template_id || null,
    docIds,
    ragContext,
    locale,
    persist: true,
    usageMeta,
    openUpstream: async (finalMessages, signal) => {
      const { response, provider, fallback_reason, log_id } = await openChatStream({
        model, messages: finalMessages, signal,
        meta: { userId, conversationId: conversation_id, model },
      });
      usageMeta.provider = provider;
      usageMeta.log_id = log_id;
      if (fallback_reason) {
        usageMeta.fallback_reason = fallback_reason;
        res.setHeader('X-AI-Provider', provider);
        res.setHeader('X-AI-Fallback-Reason', fallback_reason);
      }
      return response;
    },
  });
}

async function sendMessageNonStreaming(req, res, { model, messages, userId, locale, ragContext, convId, agentTemplateId = null }) {
  try {
    const userMessages = messages.filter(m => m.role !== 'system');

    // Resolve agent + guardrail (mirrors streamChat pipeline)
    const { resolveForRequest: resolveAgent, buildAgentSection } = await import('../services/agentTemplateService.js');
    const { checkUserMessage, scanHistoryForPriming } = await import('../services/guardService.js');
    const { buildRefusal } = await import('../services/refusalMessage.js');
    const agent = await resolveAgent({ agentTemplateId, conversationId: convId }).catch(() => null);

    const lastUserMsg = [...userMessages].reverse().find(m => m.role === 'user');
    if (lastUserMsg?.content) {
      const histVerdict = await scanHistoryForPriming(userMessages, { userId });
      if (!histVerdict.safe) {
        return res.status(422).json({
          error: buildRefusal({ locale, category: histVerdict.category, layer: histVerdict.layer, agentFallback: agent?.fallback_response }),
          code: 'ERR_GUARDRAIL_BLOCKED',
          layer: histVerdict.layer,
          category: histVerdict.category,
          severity: histVerdict.severity,
        });
      }
      const verdict = await checkUserMessage(lastUserMsg.content, agent, { userId });
      if (!verdict.safe) {
        const status = verdict.status || 422;
        const code = verdict.layer === 'L7_rate_limit' ? 'ERR_RATE_LIMITED' : 'ERR_GUARDRAIL_BLOCKED';
        return res.status(status).json({
          error: buildRefusal({ locale, category: verdict.category, layer: verdict.layer, agentFallback: agent?.fallback_response }),
          code,
          layer: verdict.layer,
          category: verdict.category,
          severity: verdict.severity,
          score: verdict.score,
          block_until: verdict.block_until,
          escalation: verdict.escalation,
        });
      }
    }

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
    const reasoning = result.reasoning || '';

    // L6 output scan — replace harmful output with refusal before persist/return.
    const { scanOutputHarmful, logHarmfulOutput } = await import('../services/guardService.js');
    const harm = scanOutputHarmful(rawContent);
    const content = harm.harmful ? harm.safeText : rawContent;

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
