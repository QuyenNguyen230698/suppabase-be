// modelRegistry — single source of truth mapping AI roles → Cloudflare models.
//
// Before this, model ids were hardcoded (and drifted) across cloudflareAIService,
// visionController, modelCapabilities, the chat controllers and the background
// jobs. This registry centralises them so a model swap is one edit, and so each
// ingestion/chat "core" can ask for the right model by role.
//
// Every role can be overridden via env (so ops can flip a model without a
// redeploy). The defaults below reflect the agreed per-core model table:
//
//   role           default                                          used by
//   ─────────────  ───────────────────────────────────────────────  ─────────────
//   embed          @cf/baai/bge-m3                                   all cores (RAG, cache, guard L3)
//   vision         @cf/meta/llama-4-scout-17b-16e-instruct           OCR + Image cores, vision endpoint
//   code           @cf/qwen/qwen2.5-coder-32b-instruct               Text/Code core
//   chatDefault    @cf/deepseek-ai/deepseek-r1-distill-qwen-32b      Chat (default reasoning)
//   chatWorkhorse  @cf/meta/llama-3.3-70b-instruct-fp8-fast          Chat (fast workhorse)
//   chatDeep       @cf/qwen/qwq-32b                                  Chat (deep reasoning)
//
// PEB (self-hosted RTX 5090) is NOT in this table — it is the runtime fallback
// resolved by providerRouter, not a role here.

function env(key, fallback) {
  const v = (process.env[key] || '').trim();
  return v || fallback;
}

export const MODELS = {
  embed:         env('EMBED_MODEL',     '@cf/baai/bge-m3'),
  vision:        env('VISION_MODEL',    '@cf/meta/llama-4-scout-17b-16e-instruct'),
  code:          env('CODE_MODEL',      '@cf/qwen/qwen2.5-coder-32b-instruct'),
  chatDefault:   env('DEFAULT_MODEL',   '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b'),
  // chatWorkhorse / chatDeep are catalogued here but NOT in the default
  // ALLOWED_MODELS — the user-facing list was trimmed to deepseek-r1 (default)
  // + qwen2.5-coder. To re-enable either, just add it to ALLOWED_MODELS; no code
  // change needed (isAllowedChatModel reads ALLOWED_MODELS at runtime).
  chatWorkhorse: env('CHAT_WORKHORSE',  '@cf/meta/llama-3.3-70b-instruct-fp8-fast'),
  chatDeep:      env('CHAT_DEEP_MODEL', '@cf/qwen/qwq-32b'),
};

// The chat models the user is allowed to pick. Reads ALLOWED_MODELS (comma-sep);
// falls back to [chatDefault, code] when unset so a misconfigured env can't open
// up every model. Vision/embed are internal — never user-selectable.
export function allowedChatModels() {
  const fromEnv = (process.env.ALLOWED_MODELS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return fromEnv.length ? fromEnv : [MODELS.chatDefault, MODELS.code];
}

export function isAllowedChatModel(name) {
  if (!name) return false;
  return allowedChatModels().includes(name);
}

// Map an ingestion/chat core to the model it should drive its specialised step
// with. Embedding is always bge-m3 (the backbone) regardless of core, so it is
// not returned here — callers use MODELS.embed directly.
//
//   'ocr'   → vision model (PaddleOCR sidecar runs BEFORE this, outside CF)
//   'image' → vision model (caption + OCR)
//   'code'  → code model
//   'text'  → null (plain text needs no specialised model, just embed)
//   'chat'  → chat default
export function modelForCore(core) {
  switch (core) {
    case 'ocr':
    case 'image':
      return MODELS.vision;
    case 'code':
      return MODELS.code;
    case 'chat':
      return MODELS.chatDefault;
    case 'text':
    default:
      return null;
  }
}

// Models that can natively see images. Kept here so modelCapabilities and the
// vision pipeline agree on one list.
export const VISION_MODELS = new Set([
  MODELS.vision,
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/meta/llama-3.2-11b-vision-instruct',   // legacy — still accepted if a client asks for it
]);

// Context window (tokens) per model. Used by the /models route and any caller
// that needs to size the prompt. Update when adding models.
export const CONTEXT_WINDOW = {
  '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b': 80000,
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast':     24000,
  '@cf/meta/llama-4-scout-17b-16e-instruct':     131000,
  '@cf/qwen/qwq-32b':                             32000,
  '@cf/qwen/qwen2.5-coder-32b-instruct':          32000,
  '@cf/mistral/mistral-small-3.1-24b-instruct':  128000,
  '@cf/meta/llama-3.2-11b-vision-instruct':      128000,
};
