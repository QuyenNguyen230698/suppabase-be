// Per-model capability registry. Used to decide:
//   - whether to allow image attachments for a chat request
//   - whether OCR is needed (vision-native models can see images directly)
//
// Vision-capable models: keep this list aligned with what the upstream
// provider actually supports. Cloudflare's Llama 3.2 vision + Llama 4 Scout
// are multimodal; the others in our default catalog are text-only.

const VISION_MODELS = new Set([
  '@cf/meta/llama-3.2-11b-vision-instruct',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
]);

export function supportsVision(model) {
  if (!model) return false;
  if (VISION_MODELS.has(model)) return true;
  // Heuristic for future additions — name contains "vision" or "scout".
  const m = model.toLowerCase();
  return m.includes('vision') || m.includes('scout') || m.includes('gpt-4o') || m.includes('claude') || m.includes('gemini');
}
