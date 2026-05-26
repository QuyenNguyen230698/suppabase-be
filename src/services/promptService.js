import { query } from '../db/index.js';

const TTL_MS = 60 * 1000;
const cache = new Map();   // key = `${scope}:${locale}` → { content, at }

function getCached(scope, locale) {
  const hit = cache.get(`${scope}:${locale}`);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.content;
  return null;
}

function setCached(scope, locale, content) {
  cache.set(`${scope}:${locale}`, { content, at: Date.now() });
}

export function invalidatePromptCache() {
  cache.clear();
}

/**
 * Get a system prompt by (scope, locale). Falls back to 'en' if locale missing.
 * Returns the active row content; latest version wins if multiple active.
 */
export async function getPrompt(scope, locale = 'en') {
  const want = (locale || 'en').toLowerCase().split('-')[0];

  const cached = getCached(scope, want);
  if (cached !== null) return cached;

  // Try requested locale first
  const primary = await query(
    `SELECT content FROM prompt_templates
     WHERE scope = $1 AND locale = $2 AND is_active = TRUE
     ORDER BY version DESC LIMIT 1`,
    [scope, want]
  );
  if (primary.rows[0]) {
    setCached(scope, want, primary.rows[0].content);
    return primary.rows[0].content;
  }

  // Fallback EN
  if (want !== 'en') {
    const fallback = await query(
      `SELECT content FROM prompt_templates
       WHERE scope = $1 AND locale = 'en' AND is_active = TRUE
       ORDER BY version DESC LIMIT 1`,
      [scope]
    );
    if (fallback.rows[0]) {
      setCached(scope, want, fallback.rows[0].content);
      return fallback.rows[0].content;
    }
  }

  setCached(scope, want, '');
  return '';
}

/** Resolve user locale from req.user, accept-language header, then default 'en'. */
export function resolveLocale(req) {
  const userLang = req.user?.language;
  if (userLang && /^(en|vi)/i.test(userLang)) return userLang.toLowerCase().slice(0, 2);
  const accept = req.headers['accept-language'] || '';
  if (/vi/i.test(accept)) return 'vi';
  return 'en';
}

/**
 * Build a complete system prompt: base + optional addons.
 *   await buildSystemPrompt({ scope: 'chat', locale: 'vi', context: ragText, hasImage: false })
 */
export async function buildSystemPrompt({ scope, locale, context = '', hasImage = false }) {
  const base = await getPrompt(scope, locale);
  let result = base;

  if (context) {
    const tpl = await getPrompt('rag_addon', locale);
    result += tpl.replace('{{CONTEXT}}', context);
  }
  if (hasImage) {
    const tpl = await getPrompt('vision_addon', locale);
    result += tpl;
  }
  return result;
}
