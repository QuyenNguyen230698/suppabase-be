// Generate a polite, helpful refusal message instead of a flat "Yêu cầu không
// được phép". A good refusal:
//   • acknowledges what the user wanted
//   • briefly says WHY we can't help in this exact form
//   • offers a concrete reformulation path
//   • is locale-aware
//
// `category` and `layer` come from the guard verdict. We map them to a
// short reason + suggestion. Unknown categories fall back to a generic
// (still polite) text.

const TEMPLATES = {
  vi: {
    pii: {
      reason: 'Yêu cầu có vẻ liên quan đến thông tin cá nhân nhạy cảm (PII).',
      suggest: 'Bạn có thể diễn đạt lại theo hướng tổng quát, không chứa thông tin định danh cụ thể (số điện thoại, CCCD, email) được không?',
    },
    jailbreak: {
      reason: 'Yêu cầu trông giống một nỗ lực bỏ qua các quy tắc an toàn của trợ lý.',
      suggest: 'Mình rất sẵn lòng giúp nếu bạn diễn đạt lại theo cách thẳng thắn về vấn đề bạn muốn giải quyết — không cần đóng vai hay yêu cầu mình "quên hướng dẫn".',
    },
    harmful: {
      reason: 'Nội dung này có khả năng gây hại nghiêm trọng (sức khỏe, an toàn, pháp lý).',
      suggest: 'Mình có thể giúp ở khía cạnh giáo dục, phòng ngừa hoặc nguồn hỗ trợ chính thống. Bạn muốn đi theo hướng nào?',
    },
    illegal: {
      reason: 'Yêu cầu có dấu hiệu liên quan đến hoạt động trái pháp luật.',
      suggest: 'Nếu bạn đang nghiên cứu/học hỏi về khung pháp lý hoặc cách phòng ngừa, mình hỗ trợ được. Bạn có thể nói rõ mục đích không?',
    },
    sexual_minors: {
      reason: 'Yêu cầu liên quan đến chủ đề mà mình tuyệt đối không thể hỗ trợ.',
      suggest: null,
    },
    rate_limit: {
      reason: 'Bạn đã gửi quá nhiều yêu cầu trong thời gian ngắn.',
      suggest: 'Vui lòng đợi ít phút rồi thử lại. Nếu cần dùng thường xuyên hơn, hãy liên hệ admin để nâng quota.',
    },
    default: {
      reason: 'Yêu cầu này không nằm trong phạm vi mình có thể hỗ trợ.',
      suggest: 'Bạn có thể mô tả rõ hơn mục đích sử dụng để mình tìm hướng phù hợp giúp bạn không?',
    },
  },
  en: {
    pii: {
      reason: 'This request appears to involve sensitive personal information.',
      suggest: 'Could you rephrase it without specific identifiers (phone, ID number, email)?',
    },
    jailbreak: {
      reason: 'This looks like an attempt to bypass the assistant\'s safety rules.',
      suggest: 'I\'m glad to help if you state the underlying problem directly — no role-play or "ignore previous instructions" needed.',
    },
    harmful: {
      reason: 'The content could cause serious harm (health, safety, legal).',
      suggest: 'I can help from an educational, preventive, or official-resources angle. Which direction would help you?',
    },
    illegal: {
      reason: 'This request looks tied to illegal activity.',
      suggest: 'If you\'re researching the legal framework or prevention, I can help — could you clarify your intent?',
    },
    sexual_minors: {
      reason: 'This is a topic I cannot help with under any framing.',
      suggest: null,
    },
    rate_limit: {
      reason: 'You\'ve sent too many requests in a short period.',
      suggest: 'Please wait a minute and try again. Contact an admin if you need a higher quota.',
    },
    default: {
      reason: 'This request is outside what I can help with.',
      suggest: 'Could you describe your intent in more detail so I can find a useful angle?',
    },
  },
};

function normaliseCategory(category, layer) {
  if (layer === 'L7_rate_limit') return 'rate_limit';
  if (!category) return 'default';
  const c = String(category).toLowerCase();
  if (c.includes('pii')) return 'pii';
  if (c.includes('jail') || c.includes('prompt_injection')) return 'jailbreak';
  if (c.includes('minor') || c.includes('csam')) return 'sexual_minors';
  if (c.includes('illegal') || c.includes('crime')) return 'illegal';
  if (c.includes('harm') || c.includes('violence') || c.includes('weapon') || c.includes('self_harm')) return 'harmful';
  return 'default';
}

export function buildRefusal({ locale, category, layer, agentFallback }) {
  const lang = (locale || 'en').toLowerCase().startsWith('vi') ? 'vi' : 'en';
  const key = normaliseCategory(category, layer);
  const t = TEMPLATES[lang][key] || TEMPLATES[lang].default;
  // If the agent template supplies its own fallback line, prepend it (admin
  // configured copy wins) but still attach our suggestion when present.
  const lines = [];
  if (agentFallback) lines.push(agentFallback);
  lines.push(t.reason);
  if (t.suggest) lines.push(t.suggest);
  return lines.join(' ');
}
