// Lightweight language detector run per chat turn. The result is injected
// into the system prompt so the model replies in the user's language
// regardless of conversation history or system-prompt locale.
//
// Strategy: cheap heuristics on Unicode ranges + a few high-signal Vietnamese
// markers. No external lib, no LLM call. Misclassifications fall back to 'en'
// which the prompt treats as "let the model decide".

const SCRIPT_RANGES = [
  { code: 'ja',  re: /[぀-ゟ゠-ヿ]/ },      // hiragana/katakana
  { code: 'ko',  re: /[가-힯]/ },                   // hangul
  { code: 'zh',  re: /[一-鿿]/ },                   // CJK
  { code: 'ar',  re: /[؀-ۿ]/ },                   // arabic
  { code: 'th',  re: /[฀-๿]/ },                   // thai
  { code: 'ru',  re: /[Ѐ-ӿ]/ },                   // cyrillic
  { code: 'hi',  re: /[ऀ-ॿ]/ },                   // devanagari
];

// Vietnamese-specific diacritics + tone marks. Latin alphabet alone isn't
// enough — many EU langs share it. Combining-mark check is the giveaway.
const VI_MARKERS = /[à-ỿàáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđÀÁẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸỴĐ]/;

const VI_WORDS = /\b(của|và|không|được|những|trong|này|là|có|với|cho|tôi|bạn|làm|gì|sao|như|thế|nào)\b/i;

export function detectLanguage(text) {
  const s = (text || '').trim();
  if (!s) return 'en';

  for (const { code, re } of SCRIPT_RANGES) {
    if (re.test(s)) return code;
  }
  if (VI_MARKERS.test(s) || VI_WORDS.test(s)) return 'vi';
  return 'en';
}

// Human-readable name used inside the system-prompt instruction.
const NAME = {
  en: 'English', vi: 'Vietnamese (Tiếng Việt)', ja: 'Japanese', ko: 'Korean',
  zh: 'Chinese', ar: 'Arabic', th: 'Thai', ru: 'Russian', hi: 'Hindi',
};

export function languageDirective(code) {
  const name = NAME[code] || 'the same language as the user';
  return `\n\n---\n[USER_LANGUAGE]\nThe user's latest message is in ${name} (detected: ${code}). Reply in ${name}, regardless of any other language used earlier in the conversation or in this prompt. If the user mixes languages, reply in the dominant one of their latest message.`;
}
