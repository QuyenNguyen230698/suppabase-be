import crypto from 'crypto';
import { query } from '../db/index.js';
import { MODELS } from '../services/modelRegistry.js';

const EXPIRY_OPTIONS = {
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  never: null,
};

export async function listTokens(_req, res) {
  const result = await query(
    `SELECT id, name, token_hash AS token, expires_at, last_used_at, is_active, created_by, created_at FROM api_tokens ORDER BY created_at DESC`,
  );
  res.json(result.rows);
}

export async function createToken(req, res) {
  const { name, expires_in = 'never' } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Token name is required' });
  if (!EXPIRY_OPTIONS.hasOwnProperty(expires_in)) {
    return res.status(400).json({ error: 'expires_in must be one of: 1h, 1d, 7d, 30d, never' });
  }

  const plainToken = crypto.randomBytes(32).toString('hex');

  let expiresAt = null;
  if (EXPIRY_OPTIONS[expires_in] !== null) {
    expiresAt = new Date(Date.now() + EXPIRY_OPTIONS[expires_in]);
  }

  const result = await query(
    `INSERT INTO api_tokens (name, token_hash, expires_at, created_by) VALUES ($1, $2, $3, $4) RETURNING id, name, expires_at, created_at`,
    [name.trim(), plainToken, expiresAt, req.user.id],
  );

  res.status(201).json({
    ...result.rows[0],
    token: plainToken,
  });
}

export async function revokeToken(req, res) {
  const result = await query(
    `UPDATE api_tokens SET is_active=false WHERE id=$1 RETURNING id`,
    [req.params.id],
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Token not found' });
  res.json({ success: true });
}

export async function deleteToken(req, res) {
  const result = await query(
    `DELETE FROM api_tokens WHERE id=$1 AND is_active=false RETURNING id`,
    [req.params.id],
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Token not found or still active — revoke it first' });
  res.json({ success: true });
}

export async function getTokenCurl(req, res) {
  const result = await query(
    `SELECT id, name FROM api_tokens WHERE id=$1`,
    [req.params.id],
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Token not found' });

  const host = `${req.protocol}://${req.get('host')}`;
  const defaultModel = process.env.DEFAULT_MODEL || MODELS.chatDefault;
  const assistantName = process.env.ASSISTANT_NAME || 'Suppabase';
  const systemPrompt = `Bạn là ${assistantName}, kỹ sư AI nhiệt tình với chuyên môn sâu về lập trình và phân tích kỹ thuật.

Hệ thống đã OCR hình ảnh và cung cấp nội dung text trích xuất cho bạn trong dấu ---.
TUYỆT ĐỐI KHÔNG được nói "tôi không thể xem hình ảnh", "tôi không thể đọc file", hoặc bất kỳ câu tương tự.
Nội dung hình ảnh đã được trích xuất sẵn — hãy đọc và phân tích trực tiếp.

Khi có nội dung OCR:
- Phân tích toàn bộ: sơ đồ kiến trúc, code, lỗi, flowchart, UI mockup, bảng dữ liệu...
- Suy luận cấu trúc và ý nghĩa từ text OCR, trả lời theo đúng yêu cầu người dùng.
- Nếu được yêu cầu lên kế hoạch code: chuyển hóa thành kiến trúc, components, API, DB schema cụ thể — không chỉ tóm tắt lại.

Kết thúc mỗi câu trả lời: gợi ý 2–3 bước tiếp theo liên quan (tối ưu, test, tính năng mở rộng).
Trả lời bằng ngôn ngữ người dùng đang dùng.`;
  const curl = `curl -X POST ${host}/api/chat/vision \\
  -H "Authorization: Bearer <YOUR_TOKEN>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${defaultModel}",
    "temperature": 0,
    "top_p": 0.9,
    "thinking": {
      "type": "enabled",
      "budget_tokens": 800000
    },
    "messages": [
      {
        "role": "system",
        "content": "${systemPrompt.replace(/\n/g, '\\n').replace(/"/g, '\\"')}"
      },
      {
        "role": "user",
        "content": "Xin chào! Bạn có thể giúp tôi điều gì?"
      }
    ],
    "stream": false
  }'

# Kèm hình ảnh (tuỳ chọn):
# curl -X POST ${host}/api/chat/vision \\
#   -H "Authorization: Bearer <YOUR_TOKEN>" \\
#   -F 'payload={"model":"${defaultModel}","messages":[{"role":"user","content":"Phân tích ảnh này"}],"stream":false}' \\
#   -F "image=@/path/to/image.jpg"`;

  res.json({ curl });
}
