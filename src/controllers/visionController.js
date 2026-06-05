import crypto from 'crypto';
import { query } from '../db/index.js';
import { chat as aiChat, openChatStream } from '../services/aiProvider.js';
import { extractTextFromImage } from '../services/ocrService.js';
import { scheduleReconcile } from '../services/usageReconciler.js';
import { MODELS } from '../services/modelRegistry.js';

const VISION_MODEL = MODELS.vision;
const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Suppabase';

const SYSTEM_PROMPT_BASE =
`Bạn là ${ASSISTANT_NAME}, kỹ sư AI nhiệt tình với chuyên môn sâu về lập trình và phân tích kỹ thuật.

Kết thúc mỗi câu trả lời: gợi ý 2–3 bước tiếp theo liên quan (tối ưu, test, tính năng mở rộng).
Trả lời bằng ngôn ngữ người dùng đang dùng.`;

const SYSTEM_PROMPT_WITH_IMAGE =
`Bạn là ${ASSISTANT_NAME}, kỹ sư AI nhiệt tình với chuyên môn sâu về lập trình và phân tích kỹ thuật.

Hệ thống đã OCR hình ảnh và cung cấp nội dung text trích xuất cho bạn trong dấu ---.
TUYỆT ĐỐI KHÔNG được nói "tôi không thể xem hình ảnh", "tôi không thể đọc file", hoặc bất kỳ câu tương tự.
Nội dung hình ảnh đã được trích xuất sẵn — hãy đọc và phân tích trực tiếp.

Khi có nội dung OCR:
- Phân tích toàn bộ: sơ đồ kiến trúc, code, lỗi, flowchart, UI mockup, bảng dữ liệu...
- Suy luận cấu trúc và ý nghĩa từ text OCR, trả lời theo đúng yêu cầu người dùng.
- Nếu được yêu cầu lên kế hoạch code: chuyển hóa thành kiến trúc, components, API, DB schema cụ thể — không chỉ tóm tắt lại.

Kết thúc mỗi câu trả lời: gợi ý 2–3 bước tiếp theo liên quan (tối ưu, test, tính năng mở rộng).
Trả lời bằng ngôn ngữ người dùng đang dùng.`;

const BAD_ASSISTANT_PATTERNS = [
  'không thể xem hình ảnh',
  'không thể đọc hình ảnh',
  'không thể xem tệp',
  'cannot view image',
  'cannot read image',
  'unable to view image',
];

export async function analyzeImage(req, res) {
  let payload = {};
  if (req.body.payload) {
    try { payload = JSON.parse(req.body.payload); } catch { /* ignore */ }
  } else if (req.body.messages || req.body.model) {
    payload = req.body;
  }

  const model = payload.model || req.body.model || VISION_MODEL;
  const conversation_id = payload.conversation_id || req.body.conversation_id || null;
  const streamRaw = payload.stream ?? req.body.stream;
  const stream = streamRaw === false || streamRaw === 'false' ? false : true;

  const hasImage = !!req.file;
  const historyMessages = Array.isArray(payload.messages)
    ? payload.messages.filter((m) => m.role !== 'system')
    : [];

  const lastUserMsg = [...historyMessages].reverse().find((m) => m.role === 'user');
  const prompt = lastUserMsg?.content || req.body.prompt || 'Hãy phân tích nội dung này';

  const userId = req.user.id;

  let systemPrompt = SYSTEM_PROMPT_BASE;
  let imageContext = '';
  let convTitle = prompt.slice(0, 60) || 'Chat';

  if (hasImage) {
    systemPrompt = SYSTEM_PROMPT_WITH_IMAGE;
    const ocrText = await extractTextFromImage(req.file.buffer);

    imageContext = ocrText && ocrText.length > 10
      ? `\n\n---\n[Nội dung trích xuất từ hình ảnh "${req.file.originalname || 'image'}" qua OCR]\n${ocrText}\n---`
      : `\n\n---\n[Hình ảnh "${req.file.originalname || 'image'}" — OCR không trích xuất được text. Hãy trả lời dựa trên yêu cầu người dùng.]\n---`;

    convTitle = `Image: ${req.file.originalname || 'analysis'}`;
  }

  const finalSystem = systemPrompt + imageContext;

  const historyWithoutLastUser = (lastUserMsg
    ? historyMessages.slice(0, historyMessages.lastIndexOf(lastUserMsg))
    : historyMessages
  ).filter((m) => {
    if (m.role !== 'assistant') return true;
    const lower = (m.content || '').toLowerCase();
    return !BAD_ASSISTANT_PATTERNS.some((p) => lower.includes(p));
  });

  const finalMessages = [
    { role: 'system', content: finalSystem },
    ...historyWithoutLastUser,
    { role: 'user', content: prompt },
  ];

  let convId = conversation_id;
  if (!convId) {
    const r = await query(
      `INSERT INTO conversations (user_id, title, model) VALUES ($1, $2, $3) RETURNING id`,
      [userId, convTitle, model],
    );
    convId = r.rows[0].id;
  } else {
    await query(`UPDATE conversations SET updated_at=NOW(), model=$1 WHERE id=$2 AND user_id=$3`, [
      model, convId, userId,
    ]);
  }

  const userMsgContent = hasImage
    ? `[Image: ${req.file.originalname || 'image'}] ${prompt}`
    : prompt;

  await query(
    `INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)`,
    [convId, 'user', userMsgContent],
  );

  // --- Non-streaming ---
  if (!stream) {
    try {
      const result = await aiChat({
        model, messages: finalMessages,
        meta: { userId, conversationId: convId, model },
      });
      const content = result.content || '';
      const reasoning = result.reasoning || '';

      await query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)`, [
        convId, 'assistant', content,
      ]);

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
        conversation_id: convId,
      });
    } catch (err) {
      console.error('[vision] Non-stream error:', err.message);
      return res.status(err.status || 500).json({ error: err.message, code: err.code || 'ERR_UPSTREAM' });
    }
  }

  // --- Streaming SSE ---
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Conversation-Id', convId);
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: 'conversation_id', conversation_id: convId })}\n\n`);

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  let upstreamRes;
  let usageMeta = { provider: null, log_id: null, fallback_reason: null };
  try {
    const opened = await openChatStream({
      model, messages: finalMessages, signal: controller.signal,
      meta: { userId, conversationId: convId, model },
    });
    upstreamRes = opened.response;
    usageMeta.provider = opened.provider;
    usageMeta.log_id = opened.log_id;
    if (opened.fallback_reason) {
      usageMeta.fallback_reason = opened.fallback_reason;
      res.write(`data: ${JSON.stringify({ type: 'provider_fallback', provider: opened.provider, reason: opened.fallback_reason })}\n\n`);
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('[vision] upstream open error:', err.message);
    // Cloudflare quota/outage → no PEB fallback; return a hard, user-facing
    // message as a normal assistant reply (matches the text-chat behaviour).
    if (err.code === 'ERR_QUOTA_EXCEEDED' || err.code === 'ERR_CF_UNAVAILABLE') {
      const hard = err.code === 'ERR_QUOTA_EXCEEDED'
        ? 'Hệ thống đã dùng hết hạn mức AI miễn phí trong hôm nay (Cloudflare Workers AI). Hạn mức sẽ tự đặt lại vào 00:00 UTC. Vui lòng thử lại sau.'
        : 'Dịch vụ AI (Cloudflare Workers AI) hiện tạm thời không khả dụng. Vui lòng thử lại sau ít phút.';
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: hard })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'usage', provider: 'system', upstream_error: err.code, prompt_tokens: 0, completion_tokens: 0 })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
      return;
    }
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message, code: err.code || 'ERR_UPSTREAM' })}\n\n`);
    res.end();
    return;
  }

  try {
    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let thinkingBuffer = '';
    let inThinking = false;
    let thinkingEmitted = false;
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const lineRaw of lines) {
        const line = lineRaw.trim();
        if (!line) continue;
        let payloadStr = line;
        if (payloadStr.startsWith('data: ')) payloadStr = payloadStr.slice(6);
        if (payloadStr === '[DONE]') break;

        let chunk;
        try { chunk = JSON.parse(payloadStr); } catch { continue; }

        const token = chunk.message?.content
                   ?? chunk.choices?.[0]?.delta?.content
                   ?? chunk.response
                   ?? '';
        const isDone = chunk.done === true || chunk.choices?.[0]?.finish_reason === 'stop';

        if (!token && isDone) {
          if (thinkingBuffer) {
            if (inThinking) {
              res.write(`data: ${JSON.stringify({ type: 'thinking', content: thinkingBuffer.trim() })}\n\n`);
            } else {
              fullContent += thinkingBuffer;
              res.write(`data: ${JSON.stringify({ type: 'chunk', content: thinkingBuffer })}\n\n`);
            }
          }
          await query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)`, [
            convId, 'assistant', fullContent,
          ]).catch(() => {});
          if (usageMeta.log_id && usageMeta.provider === 'cloudflare') {
            scheduleReconcile(usageMeta.log_id, 'cloudflare');
          }
          res.write(`data: ${JSON.stringify({
            type: 'usage', model, provider: usageMeta.provider, log_id: usageMeta.log_id,
            ...(usageMeta.fallback_reason && { fallback_reason: usageMeta.fallback_reason }),
          })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
          res.end();
          return;
        }

        if (!token) continue;

        if (!inThinking && !thinkingEmitted) {
          thinkingBuffer += token;
          const openIdx = thinkingBuffer.indexOf('<think>');
          if (openIdx !== -1) {
            const before = thinkingBuffer.slice(0, openIdx);
            if (before) { fullContent += before; res.write(`data: ${JSON.stringify({ type: 'chunk', content: before })}\n\n`); }
            inThinking = true;
            thinkingBuffer = thinkingBuffer.slice(openIdx + 7);
            continue;
          }
          if (thinkingBuffer.length > 6) {
            const safe = thinkingBuffer.slice(0, -6);
            fullContent += safe;
            res.write(`data: ${JSON.stringify({ type: 'chunk', content: safe })}\n\n`);
            thinkingBuffer = thinkingBuffer.slice(-6);
          }
          continue;
        }

        if (inThinking) {
          thinkingBuffer += token;
          const closeIdx = thinkingBuffer.indexOf('</think>');
          if (closeIdx !== -1) {
            const thinking = thinkingBuffer.slice(0, closeIdx).trim();
            const remainder = thinkingBuffer.slice(closeIdx + 8);
            res.write(`data: ${JSON.stringify({ type: 'thinking', content: thinking })}\n\n`);
            inThinking = false;
            thinkingEmitted = true;
            thinkingBuffer = '';
            if (remainder) { fullContent += remainder; res.write(`data: ${JSON.stringify({ type: 'chunk', content: remainder })}\n\n`); }
          }
          continue;
        }

        fullContent += token;
        res.write(`data: ${JSON.stringify({ type: 'chunk', content: token })}\n\n`);
      }
    }

    if (fullContent) {
      await query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)`, [
        convId, 'assistant', fullContent,
      ]).catch(() => {});
    }
    if (usageMeta.log_id && usageMeta.provider === 'cloudflare') {
      scheduleReconcile(usageMeta.log_id, 'cloudflare');
    }
    res.write(`data: ${JSON.stringify({
      type: 'usage', model, provider: usageMeta.provider, log_id: usageMeta.log_id,
      ...(usageMeta.fallback_reason && { fallback_reason: usageMeta.fallback_reason }),
    })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('[vision] Stream error:', err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    res.end();
  }
}
