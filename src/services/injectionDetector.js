// injectionDetector — heuristic detector for prompt-injection / jailbreak attempts.
//
// Strategy: weighted signals, score above threshold → block or warn.
// We DON'T call an LLM here (that's L2 Llama-Guard's job); this is the cheap
// always-on L0 filter.
//
// Returns { safe: boolean, score, signals[], action: 'allow'|'warn'|'block' }

// ── Signal patterns ─────────────────────────────────────────────
//
// Each entry: [regex, weight, label]. Higher weight = more suspicious.

const SIGNALS_EN = [
  // System prompt extraction / leak
  [/\b(ignore|disregard|forget|override|bypass)\s+(all|previous|prior|above|earlier|system|the)\s+(instruction|prompt|rule|message|context)/i, 4, 'ignore_prior'],
  [/\b(reveal|show|print|display|leak|expose|output)\s+(your|the)\s+(system\s*prompt|instructions?|rules?|guidelines?)/i, 5, 'leak_system'],
  [/\b(what\s+(is|are|were)|tell\s+me)\s+(your|the)\s+(system\s*prompt|initial\s+instructions?|hidden\s+rules?)/i, 4, 'ask_system'],
  [/\b(repeat|echo|print)\s+(the|everything)\s+(above|before|prior|preceding)/i, 3, 'repeat_above'],

  // Role hijacking
  [/\b(you\s+are\s+now|pretend\s+(to\s+be|you('?re|\s+are))|act\s+as)\s+(?!a\s+(helpful|kind|polite|professional))/i, 3, 'role_hijack'],
  [/\b(jailbreak|jailbroken|DAN\b|developer\s+mode|god\s+mode|root\s+mode|sudo\s+mode)/i, 5, 'jailbreak_term'],
  [/\b(no\s+restrictions?|without\s+(any\s+)?(restrictions?|limits?|filters?|censorship)|uncensored)/i, 4, 'no_restrictions'],

  // Instruction override
  [/\b(from\s+now\s+on|starting\s+now|new\s+rule[s]?:?)\s+you\s+(must|will|should|have\s+to)/i, 3, 'override_now'],
  [/\b(your\s+real\s+(name|purpose|instructions?)|true\s+(self|identity|nature))/i, 3, 'unveil_self'],

  // Encoded / obfuscated
  [/(?:[a-zA-Z0-9+/]{50,}={0,2})/, 2, 'base64_blob'],
  [/(?:\\x[0-9a-f]{2}){10,}/i, 2, 'hex_blob'],

  // Delimiter injection
  [/(\[\[?\s*system\s*\]?\]|<\|im_start\|>|<\|im_end\|>|<\s*system\s*>|\bSYSTEM:|\bAssistant:)/i, 3, 'delim_injection'],
];

const SIGNALS_VI = [
  [/\b(bỏ qua|phớt lờ|quên|ghi đè|vô hiệu hoá)\s+(tất cả|toàn bộ|mọi|các|những)?\s*(chỉ thị|hướng dẫn|quy tắc|prompt|lệnh|chỉ dẫn)/i, 4, 'ignore_prior_vi'],
  [/\b(hiển thị|in ra|tiết lộ|cho xem|xuất ra)\s+(system\s*prompt|prompt\s+hệ\s+thống|chỉ thị|nguyên tắc)/i, 5, 'leak_system_vi'],
  [/\b(prompt\s+gốc|chỉ thị ban đầu|system\s*prompt|prompt\s+hệ\s+thống)\s+(của\s+)?(bạn|anh|mày)\s+là\s+gì/i, 4, 'ask_system_vi'],
  [/\b(bây giờ\s+bạn|từ\s+bây\s+giờ\s+(bạn|mày)|giả vờ|đóng vai)\s+(là|làm)/i, 3, 'role_hijack_vi'],
  [/\b(không\s+(còn\s+)?giới\s+hạn|không\s+kiểm duyệt|không\s+ràng buộc)/i, 4, 'no_restrictions_vi'],
];

const ALL_SIGNALS = [...SIGNALS_EN, ...SIGNALS_VI];

const WARN_THRESHOLD  = parseInt(process.env.INJECTION_WARN_SCORE  || '3', 10);
const BLOCK_THRESHOLD = parseInt(process.env.INJECTION_BLOCK_SCORE || '7', 10);

export function detectInjection(text) {
  if (!text || typeof text !== 'string' || text.length < 8) {
    return { safe: true, score: 0, signals: [], action: 'allow' };
  }
  const hits = [];
  let score = 0;
  for (const [re, weight, label] of ALL_SIGNALS) {
    if (re.test(text)) {
      hits.push({ label, weight });
      score += weight;
    }
  }
  let action = 'allow';
  if (score >= BLOCK_THRESHOLD) action = 'block';
  else if (score >= WARN_THRESHOLD) action = 'warn';

  return {
    safe: action !== 'block',
    score,
    signals: hits,
    action,
  };
}
