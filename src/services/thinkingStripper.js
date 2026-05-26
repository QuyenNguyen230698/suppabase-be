// Some thinking-capable models (qwq-32b, certain DeepSeek-R1 distill variants
// on Cloudflare's native endpoint) emit chain-of-thought as PLAIN PROSE — no
// <think>...</think> wrapper, no native `thinking` field. The reasoning just
// appears as the opening paragraphs of `content`, in English, before the
// model finally writes the real answer (often in the user's language).
//
// The streaming parser can't tell prose-thinking from real content while
// tokens fly past, so we do a post-stream pass: detect the leading thinking
// block by heuristics and split it off as `reasoning` before persisting and
// before showing the final content to the user.

// Phrases that overwhelmingly appear at the start of a thinking trace and
// NEVER at the start of a real assistant answer.
const THINKING_OPENERS = [
  /^okay[,.\s]/i,
  /^ok[,.\s]/i,
  /^alright[,.\s]/i,
  /^well[,.\s]/i,
  /^so[,.\s]/i,
  /^now[,.\s]/i,
  /^right[,.\s]/i,
  /^hmm[,.\s]/i,
  /^let me (think|see|figure|check|consider|analy[sz]e|look|try|start|break)/i,
  /^let's (see|think|figure|break|start|consider|analy[sz]e)/i,
  /^first[,.\s]/i,
  /^firstly[,.\s]/i,
  /^to (start|begin|answer|address|tackle|approach|understand|figure)/i,
  /^the user (is|wants|asks|says|seems|appears|might|probably|likely|just|has|provided|sent|wrote)/i,
  /^the question (is|asks|seems|appears)/i,
  /^looking at /i,
  /^reading (the|this|through)/i,
  /^analy[sz]ing /i,
  /^based on (the|what|this)/i,
  /^given (the|that|this)/i,
  /^i (need|should|have to|'ll|will|must|want|think|see|notice|see|understand|realize|remember|know|am)/i,
  /^my (job|task|goal|approach|plan|reasoning|first|initial)/i,
  /^this (is|seems|appears|looks|feels|sounds) (a|like|to be)/i,
  /^thinking (about|through|step)/i,
  /^step (1|one|by step)/i,
];

// Markers inside the thinking trace — used to extend confidence even if the
// opening line was bland.
const THINKING_BODY_MARKERS = [
  /\bi (need|should|have to|'ll|will) (think|figure|consider|look|check|analy[sz]e|understand|determine|respond|answer|provide|make sure)\b/i,
  /\blet me (think|see|figure|check|consider|analy[sz]e)\b/i,
  /\bthe user (is|wants|asks|might|seems|probably|likely)\b/i,
];

// A "real answer" section typically starts with one of these patterns. If we
// see one, EVERYTHING BEFORE IT is reasoning.
//   • a Vietnamese word with diacritics in the first 30 chars of a line
//   • a markdown heading or bold lead-in
//   • a numbered list item starting at column 0
const VIETNAMESE_DIACRITIC = /[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/i;

// Decide whether the leading paragraphs of `content` are a thinking trace.
// Returns { reasoning, content } — both possibly equal to the input if no
// trace was detected. Safe to call on every assistant turn; a no-op when the
// model didn't think.
export function stripLeadingThinking(raw) {
  const text = (raw || '').trimStart();
  if (!text) return { reasoning: '', content: raw || '' };

  // Already extracted via <think> tag elsewhere — leave alone.
  if (text.startsWith('<think>')) return { reasoning: '', content: raw };

  // First non-empty line decides whether we even consider stripping.
  const firstLine = text.split('\n', 1)[0].trim();
  let looksLikeThinking = THINKING_OPENERS.some((re) => re.test(firstLine));

  // English-dominant fallback: even if no opener matched, if the leading
  // 400 chars are ASCII-heavy English AND contain a thinking body marker
  // (e.g. "I need to", "let me", "the user wants") AND somewhere later in
  // the text there IS a Vietnamese paragraph, treat the head as thinking.
  if (!looksLikeThinking) {
    const head = text.slice(0, 400);
    const asciiRatio = (head.match(/[\x20-\x7E]/g) || []).length / Math.max(1, head.length);
    const hasBodyMarker = THINKING_BODY_MARKERS.some((re) => re.test(head));
    const hasViLater = VIETNAMESE_DIACRITIC.test(text.slice(200));
    if (asciiRatio > 0.95 && hasBodyMarker && hasViLater) {
      looksLikeThinking = true;
    }
  }
  if (!looksLikeThinking) return { reasoning: '', content: raw };

  // Walk paragraph by paragraph; the answer starts at the FIRST paragraph
  // that either contains a Vietnamese diacritic OR a clear markdown answer
  // structure (heading, bold colon, numbered/bulleted list at start of line).
  const paragraphs = text.split(/\n{2,}/);
  let splitIdx = -1;
  for (let i = 1; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    const head = p.slice(0, 80);
    const startsAnswer =
      VIETNAMESE_DIACRITIC.test(head) ||
      /^#{1,6}\s/.test(p) ||
      /^\*\*[^*\n]{1,40}\*\*[:：]/.test(p) ||
      /^\d+\.\s/.test(p) ||
      /^[-*]\s/.test(p);
    if (startsAnswer) {
      splitIdx = i;
      break;
    }
  }

  // No clear answer boundary found → the model probably answered entirely in
  // English. Don't strip — better to show too much than to eat the answer.
  if (splitIdx === -1) {
    // ...unless the body is dominated by thinking markers AND there's a clear
    // last-paragraph shift in tone (final paragraph short + declarative).
    const bodyHasThinkingMarkers = THINKING_BODY_MARKERS.some((re) => re.test(text));
    if (!bodyHasThinkingMarkers) return { reasoning: '', content: raw };
    return { reasoning: '', content: raw };
  }

  const reasoning = paragraphs.slice(0, splitIdx).join('\n\n').trim();
  const content = paragraphs.slice(splitIdx).join('\n\n').trim();
  if (!content) return { reasoning: '', content: raw };
  return { reasoning, content };
}
