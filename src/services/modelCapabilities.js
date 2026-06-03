// Per-model capability registry. Used to decide:
//   - whether to allow image attachments for a chat request
//   - whether OCR is needed (vision-native models can see images directly)
//
// The canonical vision-model list lives in modelRegistry.VISION_MODELS so this
// module and the vision pipeline never drift. Cloudflare's Llama 4 Scout (the
// current default) and Llama 3.2 vision (legacy) are multimodal; the others in
// our default catalog are text-only.

import { VISION_MODELS } from './modelRegistry.js';

export function supportsVision(model) {
  if (!model) return false;
  if (VISION_MODELS.has(model)) return true;
  // Heuristic for future additions — name contains "vision" or "scout".
  const m = model.toLowerCase();
  return m.includes('vision') || m.includes('scout') || m.includes('gpt-4o') || m.includes('claude') || m.includes('gemini');
}
