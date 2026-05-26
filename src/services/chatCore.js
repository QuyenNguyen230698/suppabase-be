// chatCore — unified chat pipeline shared by chat / pro (PEB) / public widget.
//
// Responsibilities:
//   • Persist conversation + user/assistant messages (DB).
//   • Stream upstream NDJSON (Ollama native) OR OpenAI-style SSE → unified SSE to client.
//   • Strip <think>...</think> from inline content; also support native chunk.thinking field.
//   • Optional RAG context injection via promptService.buildSystemPrompt.
//
// API:
//   await streamChat(req, res, {
//     userId, source: 'chat' | 'pro' | 'public',
//     model, messages, conversationId?,
//     locale, docIds?, hasImage?,
//     openUpstream: async (signal) => Response   // upstream stream Response
//     persist: boolean                            // false for public (no DB)
//   })

import { query } from '../db/index.js';
import { buildSystemPrompt } from './promptService.js';
import { buildMemoryBlock } from './memoryService.js';
import { scheduleReconcile } from './usageReconciler.js';
import { deleteManyFromR2 } from './r2Service.js';
import {
  resolveForRequest as resolveAgent,
  buildAgentSection,
  incrementUsage as incrementAgentUsage,
} from './agentTemplateService.js';
import { checkUserMessage, scanHistoryForPriming, scanOutput, scanOutputHarmful, logHarmfulOutput, autoFlagMessage } from './guardService.js';
import { buildRefusal } from './refusalMessage.js';
import * as cache from './semanticCache.js';
import { generateEmbedding } from './embeddingService.js';
import { toolsForAgent } from './tools/index.js';
import { runWithTools } from './toolExecutor.js';
import { detectLanguage, languageDirective } from './languageDetector.js';
import { stripLeadingThinking } from './thinkingStripper.js';

// Split a cached response into ~20-char chunks so the SSE replay still feels
// streamed instead of arriving as a single dump.
function chunkifyForReplay(text, size = 24) {
  if (!text) return [];
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

// ── SSE helpers ──────────────────────────────────────────────────
function writeSse(res, event) {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function endSse(res) {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
  res.end();
}

function openSseHeaders(res, convId) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (convId) res.setHeader('X-Conversation-Id', convId);
  res.flushHeaders();
}

// Send a comment-line heartbeat every 15s so reverse proxies (nginx,
// Cloudflare) don't drop a long "thinking" stream as idle. Returns a
// cleanup fn that clears the interval and is safe to call multiple times.
function startSseHeartbeat(res, intervalMs = 15000) {
  const timer = setInterval(() => {
    if (res.writableEnded) return;
    try { res.write(': ping\n\n'); } catch { /* socket gone */ }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// Race a promise against a timeout — used to bail when upstream stalls
// mid-stream (CF hung, network partition). Rejects with code ERR_STREAM_TIMEOUT.
function withTimeout(promise, ms, label = 'op') {
  let to;
  const timeout = new Promise((_, reject) => {
    to = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      err.code = 'ERR_STREAM_TIMEOUT';
      reject(err);
    }, ms);
    to.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(to));
}

const STREAM_READ_TIMEOUT_MS = 30000;
const STREAM_BUFFER_MAX_BYTES = 1024 * 1024; // 1MB — upstream line shouldn't exceed this

// ── DB persistence ───────────────────────────────────────────────
export async function upsertConversation({ userId, model, source, conversationId, title, agentTemplateId }) {
  if (conversationId) {
    // Track the most recently-used agent on the conversation row for FE
    // sidebar badges. Per-turn agent is recorded on each message row, so
    // switching agents mid-thread is fully supported and auditable.
    await query(
      `UPDATE conversations
         SET model = $1,
             agent_template_id = COALESCE($4, agent_template_id)
       WHERE id = $2 AND user_id = $3`,
      [model, conversationId, userId, agentTemplateId || null]
    );
    return conversationId;
  }
  const { rows } = await query(
    `INSERT INTO conversations (user_id, title, model, source, agent_template_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [userId, title, model, source, agentTemplateId || null]
  );
  return rows[0].id;
}

export async function saveUserMessage({ convId, content, agentTemplateId = null }) {
  const { rows } = await query(
    `INSERT INTO messages (conversation_id, role, content, agent_template_id)
     VALUES ($1, 'user', $2, $3) RETURNING id`,
    [convId, content, agentTemplateId]
  );
  return rows[0].id;
}

export async function saveAssistantMessage({ convId, content, model, reasoning, tokensIn, tokensOut, provider, logId, fallbackReason, agentTemplateId = null }) {
  if (!content) return null;
  try {
    const { rows } = await query(
      `INSERT INTO messages
         (conversation_id, role, content, model, reasoning, tokens_in, tokens_out, provider, log_id, fallback_reason, agent_template_id)
       VALUES ($1, 'assistant', $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        convId, content,
        model ?? null,
        reasoning ?? null,
        tokensIn ?? null, tokensOut ?? null,
        provider ?? null, logId ?? null, fallbackReason ?? null,
        agentTemplateId,
      ],
    );
    return rows[0]?.id || null;
  } catch (e) {
    console.warn('[chatCore] saveAssistantMessage:', e.message);
    return null;
  }
}

// Load prior turns of a conversation as a chat-message array (no system),
// so the model sees the full thread even when the client only sent the new
// turn. Capped at `limit` most-recent rows to stay within context window.
// Returns [] when the conversation doesn't belong to userId.
export async function loadConversationMessages({ userId, conversationId, limit = 40 }) {
  if (!conversationId || !userId) return [];
  const { rows } = await query(
    `SELECT role, content
       FROM messages
      WHERE conversation_id = $1
        AND is_deleted = FALSE
        AND role IN ('user','assistant')
        AND content IS NOT NULL AND content <> ''
        AND conversation_id IN (SELECT id FROM conversations WHERE id = $1 AND user_id = $2)
      ORDER BY created_at DESC
      LIMIT $3`,
    [conversationId, userId, limit],
  );
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

// Collect every image document_id ever attached in this conversation,
// so a model switch mid-thread still sees the previously uploaded images.
export async function loadConversationImageDocIds({ userId, conversationId }) {
  if (!conversationId || !userId) return [];
  const { rows } = await query(
    `SELECT DISTINCT d.id
       FROM documents d
  LEFT JOIN message_documents md ON md.document_id = d.id
  LEFT JOIN messages m            ON m.id = md.message_id
      WHERE d.user_id = $1
        AND d.kind = 'image'
        AND d.r2_key IS NOT NULL
        AND (d.conversation_id = $2 OR m.conversation_id = $2)`,
    [userId, conversationId],
  );
  return rows.map((r) => r.id);
}

async function linkDocumentsToMessage({ messageId, convId, docIds }) {
  if (!messageId || !docIds?.length) return;
  for (const docId of docIds) {
    await query(
      `INSERT INTO message_documents (message_id, document_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [messageId, docId]
    ).catch(() => {});
    await query(
      `UPDATE documents SET conversation_id=$1 WHERE id=$2 AND conversation_id IS NULL`,
      [convId, docId]
    ).catch(() => {});
  }
}

// ── Stream parser ────────────────────────────────────────────────
// Handles three on-the-wire shapes coming from upstream:
//   (a) Ollama NDJSON:   { message: { content, thinking? }, done? }
//   (b) OpenAI SSE:      data: { choices: [{ delta: { content, thinking? }, finish_reason? }] }
//   (c) Inline <think>:  content begins with "<think>...</think>" (older r1 models)
//
// Emits to client (consumer):
//   { type: 'conversation_id', conversation_id }   (once, before content)
//   { type: 'thinking_delta', content }            (streaming reasoning tokens)
//   { type: 'thinking', content }                  (final reasoning block, esp. from <think>)
//   { type: 'chunk', content }                     (visible content delta)
//   { type: 'done' }                               (end)
//   { type: 'error', error }                       (on failure)
function createStreamParser(res) {
  let fullContent  = '';
  let fullThinking = '';     // accumulated reasoning across thinking_delta + <think> blocks
  let tokensIn  = null;
  let tokensOut = null;

  let thinkBuf   = '';
  let inThink    = false;
  let thinkEmitted = false;

  function summary() {
    return {
      content: fullContent,
      reasoning: fullThinking || null,
      tokensIn,
      tokensOut,
    };
  }

  // Feed raw text chunks; returns when [DONE] or upstream signals done.
  async function feed(reader, onDone) {
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await withTimeout(reader.read(), STREAM_READ_TIMEOUT_MS, 'upstream_read');
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > STREAM_BUFFER_MAX_BYTES) {
        const err = new Error('Upstream line exceeded buffer cap');
        err.code = 'ERR_STREAM_BUFFER_OVERFLOW';
        throw err;
      }
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const lineRaw of lines) {
        const line = lineRaw.trim();
        if (!line) continue;

        // OpenAI SSE wraps as "data: {...}" or "data: [DONE]"
        let payload = line;
        if (payload.startsWith('data: ')) payload = payload.slice(6);
        if (payload === '[DONE]') { await onDone(summary()); return; }

        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }

        // Token usage (Ollama: prompt_eval_count / eval_count, OpenAI: usage.prompt_tokens / completion_tokens)
        if (typeof chunk.prompt_eval_count === 'number') tokensIn  = chunk.prompt_eval_count;
        if (typeof chunk.eval_count        === 'number') tokensOut = chunk.eval_count;
        if (chunk.usage?.prompt_tokens)     tokensIn  = chunk.usage.prompt_tokens;
        if (chunk.usage?.completion_tokens) tokensOut = chunk.usage.completion_tokens;

        // Native thinking token (Ollama / OpenAI delta / Cloudflare DeepSeek-R1)
        const thinkTok = chunk.message?.thinking
                     ?? chunk.choices?.[0]?.delta?.thinking
                     ?? chunk.choices?.[0]?.delta?.reasoning_content
                     ?? chunk.reasoning_content
                     ?? '';
        if (thinkTok) {
          fullThinking += thinkTok;
          writeSse(res, { type: 'thinking_delta', content: thinkTok });
          thinkEmitted = true;
        }

        // Content token — supports:
        //   Ollama NDJSON:        chunk.message.content
        //   OpenAI SSE delta:     chunk.choices[0].delta.content
        //   Cloudflare Workers AI raw:     chunk.response  (or chunk.result.response)
        //   Cloudflare AI Gateway wrapper: chunk.delta / chunk.text
        const token = chunk.message?.content
                  ?? chunk.choices?.[0]?.delta?.content
                  ?? chunk.choices?.[0]?.message?.content
                  ?? chunk.response
                  ?? chunk.result?.response
                  ?? chunk.delta
                  ?? chunk.text
                  ?? chunk.content
                  ?? '';
        if (token) {
          handleContentToken(token);
        }

        // Done signal
        const isDone = chunk.done === true
                    || chunk.choices?.[0]?.finish_reason === 'stop';
        if (isDone) { await onDone(summary()); return; }
      }
    }

    // Reader exhausted without explicit done — flush what we have
    if (thinkBuf && !inThink) {
      fullContent += thinkBuf;
      writeSse(res, { type: 'chunk', content: thinkBuf });
    }
    await onDone(summary());
  }

  // Inline <think>...</think> parser (older r1)
  function handleContentToken(token) {
    if (!inThink && !thinkEmitted) {
      thinkBuf += token;
      const openIdx = thinkBuf.indexOf('<think>');
      if (openIdx !== -1) {
        const before = thinkBuf.slice(0, openIdx);
        if (before) {
          fullContent += before;
          writeSse(res, { type: 'chunk', content: before });
        }
        inThink = true;
        thinkBuf = thinkBuf.slice(openIdx + 7);
        return;
      }
      // Keep last 6 chars in buffer (max partial '<think')
      if (thinkBuf.length > 6) {
        const safe = thinkBuf.slice(0, -6);
        fullContent += safe;
        writeSse(res, { type: 'chunk', content: safe });
        thinkBuf = thinkBuf.slice(-6);
      }
      return;
    }

    if (inThink) {
      thinkBuf += token;
      const closeIdx = thinkBuf.indexOf('</think>');
      if (closeIdx !== -1) {
        const reasoning = thinkBuf.slice(0, closeIdx).trim();
        const remainder = thinkBuf.slice(closeIdx + 8);
        fullThinking += reasoning;
        writeSse(res, { type: 'thinking', content: reasoning });
        inThink = false;
        thinkEmitted = true;
        thinkBuf = '';
        if (remainder) {
          fullContent += remainder;
          writeSse(res, { type: 'chunk', content: remainder });
        }
      }
      return;
    }

    fullContent += token;
    writeSse(res, { type: 'chunk', content: token });
  }

  return { feed };
}

// ── Public entry ─────────────────────────────────────────────────
/**
 * streamChat — pipe upstream stream → SSE to client, persist messages.
 *
 * @param {Request}  req
 * @param {Response} res
 * @param {Object} opts
 * @param {string}  opts.userId       — null for public/anonymous
 * @param {'chat'|'pro'|'public'} opts.source
 * @param {string}  opts.model
 * @param {Array}   opts.messages     — user-visible chat history (no system)
 * @param {string?} opts.conversationId
 * @param {string}  opts.locale       — 'en' | 'vi'
 * @param {string?} opts.ragContext   — pre-built RAG context to inject (optional)
 * @param {string[]?} opts.docIds     — documents to attach to the user message
 * @param {boolean} opts.hasImage     — for vision_addon
 * @param {boolean} opts.persist      — false = no DB (public widget)
 * @param {(systemPrompt:string, controllerSignal:AbortSignal) => Promise<Response>} opts.openUpstream
 */
export async function streamChat(req, res, opts) {
  const {
    userId, source, model, messages, conversationId,
    locale, ragContext = '', docIds, hasImage = false,
    persist = true, openUpstream, usageMeta = {},
    agentTemplateId = null,
  } = opts;

  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages[] required', code: 'ERR_MESSAGES_REQUIRED' });
  }

  // Strip any client-supplied system messages — server owns the prompt
  const userMessages = messages.filter(m => m.role !== 'system');

  // 0. Resolve agent template (explicit id > conversation's existing > system default)
  const agent = await resolveAgent({ agentTemplateId, conversationId }).catch(() => null);

  // 0b. Safety pre-check on the LATEST user message (the one being sent now).
  // Public widget still runs the full pipeline — global L1 patterns are the
  // whole point of being "global" (no agent ≠ no guardrail).
  let inputWarnings = [];
  const lastUserMsg = [...userMessages].reverse().find(m => m.role === 'user');
  if (lastUserMsg?.content) {
    // Many-shot defense: scan earlier turns for priming attacks.
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
    inputWarnings = verdict.warnings || [];
  }

  // 1a. Look up project custom instructions + conversation summary in one query
  let projectInstructions = '';
  let conversationSummary = '';
  if (conversationId && userId) {
    try {
      const { rows } = await query(
        `SELECT c.summary, p.custom_instructions
           FROM conversations c
      LEFT JOIN projects p ON p.id = c.project_id AND p.user_id = c.user_id
          WHERE c.id = $1 AND c.user_id = $2`,
        [conversationId, userId]
      );
      projectInstructions = (rows[0]?.custom_instructions || '').trim();
      conversationSummary = (rows[0]?.summary || '').trim();
    } catch (err) {
      console.warn('[chatCore] project/summary lookup failed:', err.message);
    }
  }

  // 1b. Build system prompt (DB-backed) + agent persona + project instructions + memories
  let systemPrompt = await buildSystemPrompt({
    scope: source,
    locale,
    context: ragContext,
    hasImage,
  });
  const agentSection = buildAgentSection(agent);
  if (agentSection) {
    systemPrompt = `${systemPrompt}\n\n---\n[Agent: ${agent.name}]\n${agentSection}`;
  }
  if (projectInstructions) {
    systemPrompt = `${systemPrompt}\n\n---\n[Project context]\n${projectInstructions}`;
  }
  // Earlier-turns summary — populated by the conversation_summary background
  // job. Lets the model recall the gist of older turns even when history was
  // truncated by the per-request window.
  if (conversationSummary) {
    systemPrompt = `${systemPrompt}\n\n---\n[Earlier conversation summary]\n${conversationSummary}`;
  }
  if (userId) {
    const memoryBlock = await buildMemoryBlock(userId, lastUserMsg?.content);
    if (memoryBlock) systemPrompt = `${systemPrompt}${memoryBlock}`;
  }

  // Per-turn language directive — reply in the language of the LATEST user
  // message even if earlier turns / system prompt are in another language.
  if (lastUserMsg?.content) {
    systemPrompt = `${systemPrompt}${languageDirective(detectLanguage(lastUserMsg.content))}`;
  }

  const finalMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...userMessages]
    : userMessages;

  // 2. Persist user message + conversation
  let convId = conversationId || null;
  let userMsgId = null;
  if (persist && userId) {
    try {
      const firstUser = userMessages.find(m => m.role === 'user');
      const title = firstUser?.content?.slice(0, 80) || 'New conversation';
      convId = await upsertConversation({
        userId, model, source, conversationId, title,
        agentTemplateId: agent?.id || null,
      });
      if (agent?.id && !conversationId) {
        // Only count when starting a new conversation with this agent
        incrementAgentUsage(agent.id);
      }

      const lastUser = userMessages[userMessages.length - 1];
      if (lastUser?.role === 'user') {
        userMsgId = await saveUserMessage({ convId, content: lastUser.content, agentTemplateId: agent?.id || null });
        await linkDocumentsToMessage({ messageId: userMsgId, convId, docIds });
      }
    } catch (err) {
      console.error('[chatCore] DB persist error:', err.message);
      return res.status(500).json({ error: 'Database error', code: 'ERR_DB' });
    }
  }

  // 3. Open SSE
  openSseHeaders(res, convId);
  const stopHeartbeat = startSseHeartbeat(res);
  res.on('close', stopHeartbeat);
  res.on('finish', stopHeartbeat);
  if (convId) writeSse(res, { type: 'conversation_id', conversation_id: convId });
  if (inputWarnings.length) writeSse(res, { type: 'guard_warnings', warnings: inputWarnings });

  // 3b. L2 cache lookup (app-level). Skip when RAG/vision context is present.
  // userId scoping is mandatory — see semanticCache.scopeOf for the rationale.
  const cacheKey = {
    userId: userId || 'public',
    agentTemplateId: agent?.id || null,
    model,
    systemPrompt,
    userContent: lastUserMsg?.content || '',
  };
  const cacheable = cache.isCacheable({ docIds, hasImage, skipCache: false }) && !!lastUserMsg?.content;

  let cachedHit = null;
  let userEmbedding = null;
  if (cacheable) {
    try {
      const result = await cache.lookup({
        ...cacheKey,
        embedFn: async (t) => (await generateEmbedding(t)),
      });
      if (result.hit) {
        cachedHit = result;
      } else {
        // We've already paid for the embed during semantic lookup — reuse it on save
        userEmbedding = result.embedding || null;
      }
    } catch (err) {
      console.warn('[chatCore] cache lookup failed:', err.message);
    }
  }

  if (cachedHit) {
    // Replay cached content as a synthetic SSE stream so client UX is identical
    const chunks = chunkifyForReplay(cachedHit.content);
    for (const c of chunks) writeSse(res, { type: 'chunk', content: c });
    if (cachedHit.reasoning) writeSse(res, { type: 'thinking', content: cachedHit.reasoning });

    let cachedMsgId = null;
    if (persist && convId) {
      cachedMsgId = await saveAssistantMessage({
        convId, content: cachedHit.content, reasoning: cachedHit.reasoning,
        model: cachedHit.model || model,
        tokensIn: 0, tokensOut: 0,
        provider: 'cache', logId: null, fallbackReason: null,
        agentTemplateId: agent?.id || null,
      });
      const pii = scanOutput(cachedHit.content);
      if (cachedMsgId && pii.count > 0) {
        autoFlagMessage(cachedMsgId, 'pii_leak', `Auto-flagged: ${pii.categories.join(', ')} detected in cached output`);
      }
    }
    writeSse(res, {
      type: 'usage', model: cachedHit.model || model,
      provider: 'cache', cache_hit: cachedHit.hit,
      message_id: cachedMsgId,
      similarity: cachedHit.similarity ?? null,
      prompt_tokens: 0, completion_tokens: 0,
    });
    endSse(res);
    return;
  }

  // 3c. Tool-calling branch — if agent has allowed_tools, run agentic loop
  // non-stream and fake-stream the final answer back. Skip on public/no-agent
  // AND skip on the PEB source ('pro') because runWithTools calls Cloudflare
  // directly — when CF is over quota or the user is on Pro, that path 429s
  // and the whole reply comes back empty (ERR_TOOL_LOOP). PEB doesn't support
  // OpenAI-style tool calls, so we just bypass tools for the Pro path and let
  // the normal streaming branch below handle it.
  const tools = toolsForAgent(agent);
  if (tools.length && source !== 'public' && source !== 'pro') {
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    try {
      const toolRun = await runWithTools({
        model,
        messages: finalMessages,
        tools,
        signal: controller.signal,
        options: {
          temperature: Number(agent?.temperature ?? 0.6),
          max_tokens: Number(agent?.max_tokens || 4096),
        },
        ctx: { userId, conversationId: convId, docIds, locale, agent },
      });

      // Emit tool trace as SSE event so FE can show "Used tool: search_documents"
      if (toolRun.trace.length) {
        writeSse(res, { type: 'tool_trace', steps: toolRun.trace });
      }
      // Strip leading plain-prose thinking (qwq / r1-native) — same as the
      // streaming branch below.
      const toolStripped = stripLeadingThinking(toolRun.content);
      const toolReasoning = toolStripped.reasoning || '';
      const toolContentClean = toolStripped.content;
      if (toolReasoning) writeSse(res, { type: 'thinking', content: toolReasoning });

      // L6 — scan the tool-loop final content before streaming it out.
      const toolHarm = scanOutputHarmful(toolContentClean);
      const toolFinalContent = toolHarm.harmful ? toolHarm.safeText : toolContentClean;

      // Fake-stream the final content in chunks for UX parity
      for (const c of chunkifyForReplay(toolFinalContent)) {
        writeSse(res, { type: 'chunk', content: c });
      }
      if (toolHarm.harmful) {
        writeSse(res, {
          type: 'harmful_output_replaced',
          category: toolHarm.category,
          reason: toolHarm.reason,
          replacement: toolHarm.safeText,
        });
      }

      let assistantMsgId = null;
      if (persist && convId) {
        assistantMsgId = await saveAssistantMessage({
          convId,
          content: toolFinalContent,
          reasoning: toolReasoning || null,
          model,
          tokensIn: toolRun.tokensIn,
          tokensOut: toolRun.tokensOut,
          provider: 'cloudflare',
          logId: null,
          fallbackReason: toolHarm.harmful ? `output_blocked:${toolHarm.category}` : null,
          agentTemplateId: agent?.id || null,
        });
        if (toolHarm.harmful) {
          await logHarmfulOutput({
            userId, agent, conversationId: convId, messageId: assistantMsgId,
            category: toolHarm.category, reason: toolHarm.reason, preview: toolRun.content,
          });
        }
        const pii = scanOutput(toolRun.content);
        if (assistantMsgId && pii.count > 0) {
          autoFlagMessage(assistantMsgId, 'pii_leak', `Auto-flagged: ${pii.categories.join(', ')} in tool-loop output`);
        }
      }

      // Save to L2 cache (skip for tool runs because the answer depends on
      // live data — calculator results are fine to cache but time/search aren't)
      writeSse(res, {
        type: 'usage', model, provider: 'cloudflare',
        message_id: assistantMsgId || null,
        prompt_tokens: toolRun.tokensIn, completion_tokens: toolRun.tokensOut,
        tool_steps: toolRun.steps, truncated: toolRun.truncated || false,
      });
      endSse(res);
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('[chatCore] tool loop error:', err.message);
      writeSse(res, { type: 'error', error: 'Tool execution failed', code: 'ERR_TOOL_LOOP' });
      res.end();
      return;
    }
  }

  // 4. Open upstream (cache miss, no tools)
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  // Helper: try to serve a stale cache entry when upstream is unavailable.
  // Returns true if served (and the SSE response is closed); false otherwise.
  async function tryServeStale(reason) {
    if (!cacheable || !lastUserMsg?.content) return false;
    try {
      const stale = await cache.lookupStale({
        ...cacheKey,
        embedFn: async (t) => (await generateEmbedding(t)),
      });
      if (!stale.hit) return false;
      const chunks = chunkifyForReplay(stale.content);
      for (const c of chunks) writeSse(res, { type: 'chunk', content: c });
      writeSse(res, {
        type: 'usage', model: stale.model || model,
        provider: 'cache_stale', cache_hit: stale.hit,
        stale_age_s: Math.round((stale.age_ms || 0) / 1000),
        upstream_error: reason,
        prompt_tokens: 0, completion_tokens: 0,
      });
      if (persist && convId) {
        await saveAssistantMessage({
          convId, content: stale.content, reasoning: stale.reasoning || null,
          model: stale.model || model, tokensIn: 0, tokensOut: 0,
          provider: 'cache_stale', logId: null, fallbackReason: reason,
          agentTemplateId: agent?.id || null,
        });
      }
      endSse(res);
      return true;
    } catch (err) {
      console.warn('[chatCore] stale lookup failed:', err.message);
      return false;
    }
  }

  let upstreamRes;
  try {
    upstreamRes = await openUpstream(finalMessages, controller.signal);
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('[chatCore] upstream open error:', err.message);
    // Hard quota → surface 429 + real code so the FE can show a clear message,
    // and never serve stale cache (the quota cap is the whole point).
    if (err.code === 'ERR_QUOTA_EXCEEDED') {
      writeSse(res, { type: 'error', error: err.message, code: 'ERR_QUOTA_EXCEEDED', status: 429 });
      res.end();
      return;
    }
    if (await tryServeStale(`open_error:${err.code || err.message}`)) return;
    writeSse(res, { type: 'error', error: 'Upstream unavailable', code: 'ERR_UPSTREAM' });
    res.end();
    return;
  }

  if (!upstreamRes.ok) {
    const txt = await upstreamRes.text().catch(() => '');
    console.error('[chatCore] upstream non-OK:', upstreamRes.status, txt.slice(0, 200));
    if (await tryServeStale(`http_${upstreamRes.status}`)) return;
    writeSse(res, { type: 'error', error: `Upstream ${upstreamRes.status}`, code: 'ERR_UPSTREAM' });
    res.end();
    return;
  }

  // 5. Stream
  const parser = createStreamParser(res);
  const reader = upstreamRes.body.getReader();

  try {
    await parser.feed(reader, async (summary) => {
      // Strip plain-prose chain-of-thought emitted by thinking models that
      // don't wrap reasoning in <think>...</think> (qwq-32b, some r1 variants
      // on the native endpoint). The stream parser couldn't tell prose-CoT
      // from real content on the fly, so we split now — moving the leading
      // English thinking block into `reasoning` and emitting a `content_replaced`
      // SSE so the FE can overwrite what it already streamed.
      let preHarmContent = summary.content;
      let preHarmReasoning = summary.reasoning || '';
      const stripped = stripLeadingThinking(summary.content);
      if (stripped.reasoning && stripped.content !== summary.content) {
        preHarmContent = stripped.content;
        preHarmReasoning = preHarmReasoning
          ? `${preHarmReasoning}\n\n${stripped.reasoning}`
          : stripped.reasoning;
        writeSse(res, { type: 'thinking', content: stripped.reasoning });
        writeSse(res, { type: 'content_replaced', content: stripped.content, reason: 'thinking_stripped' });
      }

      // L6 — Harmful output scan. Runs against the FULL drained content.
      // If trips, we replace the persisted content with a refusal AND emit a
      // `harmful_output_replaced` SSE event so the FE can overwrite what it
      // already streamed. Cache write is skipped for harmful responses.
      let finalContent = preHarmContent;
      const harm = scanOutputHarmful(preHarmContent);
      if (harm.harmful) {
        finalContent = harm.safeText;
        writeSse(res, {
          type: 'harmful_output_replaced',
          category: harm.category,
          reason: harm.reason,
          replacement: harm.safeText,
        });
      }

      let assistantMsgId = null;
      if (persist && convId) {
        assistantMsgId = await saveAssistantMessage({
          convId,
          content:   finalContent,
          reasoning: preHarmReasoning,
          model,
          tokensIn:  summary.tokensIn,
          tokensOut: summary.tokensOut,
          provider:       usageMeta.provider,
          logId:          usageMeta.log_id,
          fallbackReason: harm.harmful ? `output_blocked:${harm.category}` : usageMeta.fallback_reason,
          agentTemplateId: agent?.id || null,
        });

        if (harm.harmful) {
          await logHarmfulOutput({
            userId, agent, conversationId: convId, messageId: assistantMsgId,
            category: harm.category, reason: harm.reason, preview: summary.content,
          });
        }

        // Output PII scan — auto-flag for admin review
        const pii = scanOutput(finalContent);
        if (assistantMsgId && pii.count > 0) {
          autoFlagMessage(
            assistantMsgId,
            'pii_leak',
            `Auto-flagged: ${pii.categories.join(', ')} detected in assistant output`
          );
        }
      }
      // Stream is fully drained — now is the right moment to ask AI Gateway
      // Logs API for the precise usage figure for this request.
      if (usageMeta.log_id && usageMeta.provider === 'cloudflare') {
        scheduleReconcile(usageMeta.log_id, 'cloudflare');
      }

      // Save to L2 cache (fire-and-forget). Skip very short responses (likely
      // errors) AND harmful outputs (we don't want to serve them from cache).
      if (cacheable && !harm.harmful && finalContent && finalContent.length > 20) {
        try {
          const emb = userEmbedding || (await generateEmbedding(lastUserMsg.content).catch(() => null));
          cache.save({
            ...cacheKey,
            content: finalContent,
            reasoning: preHarmReasoning,
            embedding: emb,
          });
        } catch (err) {
          console.warn('[chatCore] cache save failed:', err.message);
        }
      }

      // Tell client final usage. log_id (when present) is the cf-aig-log-id —
      // the client should poll GET /api/admin/ai-usage/log/:log_id after ~5s
      // to get the precise neurons/cost/tokens reconciled from AI Gateway.
      const usageEvent = {
        type: 'usage',
        model,
        provider: usageMeta.provider || null,
        log_id: usageMeta.log_id || null,
        message_id: assistantMsgId || null,
        prompt_tokens: summary.tokensIn ?? null,
        completion_tokens: summary.tokensOut ?? null,
      };
      if (usageMeta.fallback_reason) usageEvent.fallback_reason = usageMeta.fallback_reason;
      writeSse(res, usageEvent);
      endSse(res);
    });
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('[chatCore] stream error:', err.message);
    const code = err.code === 'ERR_STREAM_TIMEOUT' || err.code === 'ERR_STREAM_BUFFER_OVERFLOW'
      ? err.code
      : 'ERR_STREAM';
    writeSse(res, { type: 'error', error: err.message, code });
    try { controller.abort(); } catch {}
    res.end();
  } finally {
    stopHeartbeat();
  }
}

// ── Read APIs (shared) ───────────────────────────────────────────
export async function listConversationsBySource({ userId, source }) {
  const { rows } = await query(
    `SELECT id, title, model, created_at, updated_at, last_message_at,
            pinned, starred, archived, summary, project_id, tokens_used
     FROM conversations
     WHERE user_id=$1 AND source=$2 AND archived = FALSE
     ORDER BY pinned DESC, last_message_at DESC NULLS LAST, updated_at DESC`,
    [userId, source]
  );
  return rows;
}

export async function getConversationWithMessages({ userId, source, conversationId }) {
  const conv = await query(
    `SELECT id, title, model, created_at, last_message_at,
            pinned, starred, archived, summary, project_id,
            tokens_used, share_token, share_expires_at
     FROM conversations
     WHERE id=$1 AND user_id=$2 AND source=$3`,
    [conversationId, userId, source]
  );
  if (!conv.rows.length) return null;

  const msgs = await query(
    `SELECT m.id, m.role, m.content, m.reasoning, m.model, m.tokens_in, m.tokens_out,
            m.provider, m.log_id, m.fallback_reason,
            m.parent_message_id, m.edited_at, m.created_at,
            m.agent_template_id,
            a.slug AS agent_slug, a.name AS agent_name,
            r.rating AS user_rating, r.reason AS rating_reason
     FROM messages m
     LEFT JOIN agent_templates a ON a.id = m.agent_template_id
     LEFT JOIN qa_rating r ON r.message_id = m.id AND r.user_id = $2
     WHERE m.conversation_id = $1 AND m.is_deleted = FALSE
     ORDER BY m.created_at ASC`,
    [conversationId, userId]
  );

  const userMsgIds = msgs.rows.filter(m => m.role === 'user').map(m => m.id);
  const docsByMessage = {};
  if (userMsgIds.length) {
    const docs = await query(
      `SELECT md.message_id, d.id AS document_id, d.name, d.type, d.status, d.expires_at
       FROM message_documents md
       JOIN documents d ON d.id = md.document_id
       WHERE md.message_id = ANY($1::uuid[])`,
      [userMsgIds]
    );
    for (const r of docs.rows) {
      (docsByMessage[r.message_id] ||= []).push({
        document_id: r.document_id, name: r.name, type: r.type,
        status: r.status, expires_at: r.expires_at,
      });
    }
  }

  const messages = msgs.rows.map(m => ({
    ...m,
    ...(m.role === 'user' && docsByMessage[m.id] ? { attachedDocs: docsByMessage[m.id] } : {}),
  }));

  return { ...conv.rows[0], messages };
}

export async function deleteConversationBySource({ userId, source, conversationId }) {
  // Collect R2 keys belonging to docs of this conversation BEFORE the cascade.
  // documents.conversation_id may be NULL for older rows; also pick up rows
  // linked via message_documents to be thorough.
  let keys = [];
  try {
    const { rows } = await query(
      `SELECT DISTINCT d.r2_key
         FROM documents d
    LEFT JOIN message_documents md ON md.document_id = d.id
    LEFT JOIN messages m            ON m.id = md.message_id
        WHERE d.r2_key IS NOT NULL
          AND (d.conversation_id = $1 OR m.conversation_id = $1)`,
      [conversationId],
    );
    keys = rows.map((r) => r.r2_key).filter(Boolean);
  } catch (err) {
    console.warn('[chatCore] collect R2 keys before delete failed:', err.message);
  }

  const { rowCount } = await query(
    `DELETE FROM conversations WHERE id=$1 AND user_id=$2 AND source=$3`,
    [conversationId, userId, source]
  );
  if (rowCount) {
    await query(`DELETE FROM documents WHERE conversation_id=$1`, [conversationId]).catch(() => {});
    if (keys.length) {
      // Fire-and-forget — don't block the response on R2 deletes.
      deleteManyFromR2(keys).catch((e) => console.warn('[chatCore] R2 cleanup:', e.message));
    }
  }
  return rowCount > 0;
}
