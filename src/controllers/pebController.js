import { query } from '../db/index.js';
import { resolveLocale, buildSystemPrompt } from '../services/promptService.js';
import { similaritySearch, similaritySearchInConversation, buildContext, buildAttachmentManifest } from '../services/ragService.js';
import { fetchFromR2 } from '../services/r2Service.js';
import {
  listConversationsBySource,
  getConversationWithMessages,
  deleteConversationBySource,
  loadConversationMessages,
  loadConversationImageDocIds,
} from '../services/aicore/persistence.js';
import * as AICore from '../services/aicore/index.js';
import { createRequestContext } from '../services/aicore/context.js';
import { ExpressSink } from '../services/aicore/sink.js';
import { buildImageContext } from './chatController.js';

const PEB_API_URL = 'https://supabase.pebsteel.com/functions/v1/ollama-proxy';
const PEB_API_KEY = process.env.PEB_API_KEY || '';
const PEB_MODEL = process.env.PEB_MODEL || 'qwen3.6:35b';

// Cap to avoid blowing the prompt with huge inline images. 4 MB binary ≈
// 5.3 MB base64; a multimodal Qwen request stays manageable up to ~8 MB.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES_PER_TURN = 4;

/**
 * Pull the most recent image attachment (kind='image') referenced by
 * document_ids out of R2. Returns a Multer-shaped pseudo-file object so the
 * rest of pebController can reuse buildUpstreamFetchOpts() which already
 * speaks the upstream's multipart contract.
 *
 * The upstream (ollama-proxy edge function) ignores JSON `messages[].images`
 * and ONLY reads images from the multipart `image` form field, so we cannot
 * just inline base64 into the chat payload — we have to ship multipart.
 *
 * Cap: 1 image per turn (upstream accepts a single field).
 *
 * Returns null when no image is attached or R2 fetch fails.
 */
async function loadImageFromR2(docIds, userId) {
  if (!docIds?.length) return null;
  const { rows } = await query(
    `SELECT id, name, r2_key, type
       FROM documents
      WHERE user_id = $1
        AND id = ANY($2::uuid[])
        AND kind = 'image'
        AND r2_key IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId, docIds]
  );
  if (!rows.length) return null;
  const row = rows[0];
  try {
    const buf = await fetchFromR2(row.r2_key);
    if (!buf || buf.length === 0) return null;
    if (buf.length > MAX_IMAGE_BYTES) {
      console.warn(`[peb] image ${row.id} (${row.name}) too large (${buf.length}B), skipping`);
      return null;
    }
    return {
      buffer: Buffer.isBuffer(buf) ? buf : Buffer.from(buf),
      mimetype: row.type || 'image/png',
      originalname: row.name || 'image',
    };
  } catch (err) {
    console.warn(`[peb] R2 fetch failed for ${row.id}:`, err.message);
    return null;
  }
}
// Build fetch options for upstream — multipart when image is present
function buildUpstreamFetchOpts(payload, imageFile, signal) {
  if (imageFile) {
    const form = new FormData();
    form.append('payload', JSON.stringify(payload));
    form.append('image', new Blob([imageFile.buffer], { type: imageFile.mimetype }), imageFile.originalname);
    return {
      method: 'POST',
      body: form,
      headers: { Authorization: `Bearer ${PEB_API_KEY}` },
      signal,
    };
  }
  return {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { Authorization: `Bearer ${PEB_API_KEY}`, 'Content-Type': 'application/json' },
    signal,
  };
}

export async function pebChat(req, res) {
  // multipart: req.body.payload is JSON string; otherwise req.body is already parsed
  let body = req.body;
  if (req.file && typeof req.body.payload === 'string') {
    try { body = JSON.parse(req.body.payload); } catch { body = req.body; }
  }

  const { model, messages: clientMessages, conversation_id, document_ids, agent_template_id } = body;
  const streamRaw = body.stream;
  const stream = streamRaw === false || streamRaw === 'false' ? false : true;
  const imageFile = req.file || null;

  if (!PEB_API_KEY) {
    return res.status(503).json({ error: 'PEB API key not configured', code: 'ERR_PEB_NOT_CONFIGURED' });
  }

  const userId = req.user.id;
  const pebModel = model || PEB_MODEL;
  const locale = resolveLocale(req);

  // Hydrate history from DB so a model switch into PEB mid-conversation still
  // sees prior turns (and the new turn from the client). Client may still
  // send full messages[] for BC.
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
      console.warn('[peb] history hydrate failed:', err.message);
    }
  }
  if (!messages.length) {
    return res.status(400).json({ error: 'messages[] or conversation_id with a new user message is required', code: 'ERR_MESSAGES_REQUIRED' });
  }

  // Union request doc_ids with every image ever attached to this conversation
  // — otherwise asking "what was in that image?" on a later turn produces a
  // "I can't see images" reply because docIds is empty.
  let docIds = Array.isArray(document_ids) && document_ids.length ? [...document_ids] : [];
  if (conversation_id) {
    try {
      const prior = await loadConversationImageDocIds({ userId, conversationId: conversation_id });
      for (const id of prior) if (!docIds.includes(id)) docIds.push(id);
    } catch (err) {
      console.warn('[peb] prior image docs lookup failed:', err.message);
    }
  }
  if (!docIds.length) docIds = null;

  let ragContext = '';
  let attachedImage = null;   // multer-shaped { buffer, mimetype, originalname }
  if (docIds) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    try {
      if (lastUser?.content && conversation_id) {
        const convChunks = await similaritySearchInConversation(lastUser.content, userId, conversation_id);
        if (convChunks.length) ragContext = buildContext(convChunks) || '';
      }
      if (lastUser?.content) {
        const chunks = await similaritySearch(lastUser.content, userId, docIds);
        const reqCtx = buildContext(chunks) || '';
        if (reqCtx) ragContext = ragContext ? `${reqCtx}\n\n${ragContext}` : reqCtx;
      }
    } catch (err) {
      console.warn('[peb] RAG lookup failed:', err.message);
    }
    try {
      const manifest = await buildAttachmentManifest(docIds, userId);
      if (manifest) ragContext = ragContext ? `${manifest}\n\n${ragContext}` : manifest;
    } catch (err) {
      console.warn('[peb] manifest failed:', err.message);
    }
    // Image context — ALWAYS OCR/describe via Cloudflare vision and inject as
    // text. The PEB upstream may not be multimodal (qwen-32b text variant),
    // so without this the model sees nothing and replies "I can't see images".
    // We still ship the first image as multipart below for vision-capable
    // PEB upstreams, but the OCR text is the safety net.
    try {
      const imgCtx = await buildImageContext(docIds, userId, { rich: true });
      if (imgCtx) ragContext = ragContext ? `${ragContext}\n\n---\n\n${imgCtx}` : imgCtx;
    } catch (err) {
      console.warn('[peb] image context failed:', err.message);
    }
    try {
      attachedImage = await loadImageFromR2(docIds, userId);
      if (attachedImage) {
        console.log(`[peb] vision: attaching ${attachedImage.originalname} (${attachedImage.buffer.length}B) to PEB request`);
      }
    } catch (err) {
      console.warn('[peb] R2 image load failed:', err.message);
    }
  }

  // imageFile (multer-decoded direct upload from /api/chat/vision composer)
  // takes precedence over attached docs; both end up going through the same
  // multipart upstream path.
  const finalImageFile = imageFile || attachedImage;

  // Non-streaming branch (legacy clients) — kept simple
  if (!stream) {
    return await pebNonStreaming(req, res, { messages, pebModel, userId, locale, imageFile: finalImageFile, conversationId: conversation_id, ragContext });
  }

  // Streaming via unified AICore — pass ragContext through so the system prompt
  // is built with image/RAG context (ContextCore appends it). Guard runs inside
  // the pipeline for the pro flow (synchronous res, no queue).
  const ctx = createRequestContext({
    userId,
    source: 'pro',
    model: pebModel,
    messages,
    conversationId: conversation_id,
    agentTemplateId: agent_template_id || null,
    docIds,
    ragContext,
    locale,
    hasImage: !!finalImageFile,
    persist: true,
    usageMeta: { provider: 'peb', log_id: null },
    openUpstream: (finalMessages, signal) => {
      const payload = { model: pebModel, temperature: 0, top_p: 0.9, messages: finalMessages, stream: true };
      return fetch(PEB_API_URL, buildUpstreamFetchOpts(payload, finalImageFile, signal));
    },
  });
  await AICore.run(ctx, new ExpressSink(res));
}

async function pebNonStreaming(req, res, { messages, pebModel, userId, locale, imageFile, conversationId, ragContext = '' }) {
  try {
    const userMessages = messages.filter(m => m.role !== 'system');
    const systemPrompt = await buildSystemPrompt({ scope: 'pro', locale, hasImage: !!imageFile, context: ragContext });
    const finalMessages = [{ role: 'system', content: systemPrompt }, ...userMessages];

    // Persist
    let convId = conversationId;
    if (!convId) {
      const firstUser = userMessages.find(m => m.role === 'user');
      const title = firstUser?.content?.slice(0, 80) || 'New conversation';
      const r = await query(
        `INSERT INTO conversations (user_id, title, model, source) VALUES ($1, $2, $3, 'pro') RETURNING id`,
        [userId, title, pebModel]
      );
      convId = r.rows[0].id;
    }
    const lastUser = userMessages[userMessages.length - 1];
    if (lastUser?.role === 'user') {
      await query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', $2)`,
        [convId, lastUser.content]);
    }

    const payload = { model: pebModel, temperature: 0, top_p: 0.9, messages: finalMessages, stream: false };
    const pebRes = await fetch(PEB_API_URL, buildUpstreamFetchOpts(payload, imageFile, null));
    if (!pebRes.ok) {
      const errText = await pebRes.text();
      return res.status(502).json({ error: 'PEB upstream error', detail: errText, code: 'ERR_UPSTREAM' });
    }
    const data = await pebRes.json();

    const msg = data.message?.content != null ? data.message : data.choices?.[0]?.message;
    const rawContent = msg?.content || '';
    const reasoning = (msg?.thinking || msg?.reasoning || '').trim();
    const thinkMatch = !reasoning && rawContent.match(/^<think>([\s\S]*?)<\/think>\s*/);
    const content = thinkMatch ? rawContent.slice(thinkMatch[0].length) : rawContent;
    const finalReasoning = reasoning || (thinkMatch ? thinkMatch[1].trim() : '');

    await query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'assistant', $2)`,
      [convId, content]);

    return res.json({
      id: 'chatcmpl-peb',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: pebModel,
      choices: [{
        index: 0,
        message: { role: 'assistant', content, ...(finalReasoning && { reasoning: finalReasoning }) },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      conversation_id: convId,
    });
  } catch (err) {
    console.error('[peb] non-stream error:', err.message);
    return res.status(500).json({ error: err.message, code: 'ERR_UPSTREAM' });
  }
}

export async function listPebConversations(req, res) {
  try {
    const rows = await listConversationsBySource({ userId: req.user.id, source: 'pro' });
    res.json(rows);
  } catch (err) {
    console.error('[peb] listConversations error:', err.message);
    res.status(500).json({ error: 'Failed to load conversations', code: 'ERR_DB' });
  }
}

export async function getPebConversation(req, res) {
  try {
    const data = await getConversationWithMessages({
      userId: req.user.id, source: 'pro', conversationId: req.params.id,
    });
    if (!data) return res.status(404).json({ error: 'Conversation not found', code: 'ERR_NOT_FOUND' });
    res.json(data);
  } catch (err) {
    console.error('[peb] getConversation error:', err.message);
    res.status(500).json({ error: 'Failed to load conversation', code: 'ERR_DB' });
  }
}

export async function deletePebConversation(req, res) {
  try {
    const ok = await deleteConversationBySource({
      userId: req.user.id, source: 'pro', conversationId: req.params.id,
    });
    if (!ok) return res.status(404).json({ error: 'Conversation not found', code: 'ERR_NOT_FOUND' });
    res.json({ success: true });
  } catch (err) {
    console.error('[peb] deleteConversation error:', err.message);
    res.status(500).json({ error: 'Failed to delete conversation', code: 'ERR_DB' });
  }
}
