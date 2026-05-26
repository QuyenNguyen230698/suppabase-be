import { vision, visionByUrl } from './aiProvider.js';

const OCR_PROMPT =
  'Extract ALL visible text from this image verbatim. Preserve line breaks and reading order. ' +
  'If the image contains code, tables, or diagrams, render them as plain text. ' +
  'Output text only, no commentary, no markdown wrapping.';

// Richer prompt used when the downstream chat model is itself vision-capable.
// We still go through the vision API (because workers-ai native endpoint
// doesn't accept inline multimodal messages), but ask for a structured
// description that lets the chat model reason about visual content beyond
// raw text — diagrams, UI screenshots, charts, photos, etc.
const DESCRIBE_PROMPT =
  'Describe this image in detail so a downstream assistant can answer questions about it. Cover, in this order:\n' +
  '1) WHAT is shown (type: photo / screenshot / diagram / chart / code / document / UI mockup / handwriting / mixed).\n' +
  '2) ALL visible text VERBATIM (preserve line breaks, code formatting, table structure).\n' +
  '3) Visual elements: layout, colors, prominent shapes, people/objects, charts/data, UI components.\n' +
  '4) Anything noteworthy (errors, highlights, annotations, watermarks).\n' +
  'Be thorough. Output plain text only, no markdown wrapper.';

/**
 * Extract text from image buffer via Cloudflare Workers AI vision model.
 * @param {Buffer} imageBuffer
 * @param {{rich?: boolean}} opts  rich=true → describe + OCR (for vision-capable chat models)
 * Returns extracted text, or empty string on failure.
 */
export async function extractTextFromImage(imageBuffer, opts = {}) {
  try {
    const { content } = await vision({
      imageBuffer,
      prompt: opts.rich ? DESCRIBE_PROMPT : OCR_PROMPT,
    });
    return (content || '').trim();
  } catch (err) {
    if (err.code === 'ERR_VISION_QUOTA' || err.code === 'ERR_VISION_UNAVAILABLE') {
      console.warn('[OCR] vision unavailable:', err.message);
      return '';
    }
    console.warn('[OCR] failed:', err.message);
    return '';
  }
}

// Describe one or more images via their PUBLIC URL (R2 public domain). One
// vision call returns descriptions for all images in order. Far cheaper than
// downloading + base64-encoding each image, and lets the vision model fetch
// directly from R2 — no embedding pipeline involved.
//
// Returns { content: string, ok: true } on success, or { content: '', ok: false, reason }
// so the caller can decide whether to fall back to per-image buffer OCR.
export async function describeImagesByUrl(urls, opts = {}) {
  const list = Array.isArray(urls) ? urls.filter(Boolean) : [urls].filter(Boolean);
  if (!list.length) return { content: '', ok: false, reason: 'no_urls' };

  const prompt = opts.rich !== false
    ? 'Carefully look at each attached image and produce a detailed description that lets a downstream assistant answer questions about them. For EACH image, in order, output:\n' +
      '=== IMAGE {i} ===\n' +
      '1) WHAT it is (photo / screenshot / diagram / chart / code / document / UI / signature / handwriting / mixed)\n' +
      '2) ALL visible text VERBATIM — preserve line breaks, code formatting, table structure, names, numbers, dates\n' +
      '3) Visual elements: layout, colors, prominent shapes, objects, charts, UI components, people\n' +
      '4) Anything noteworthy (errors, highlights, annotations, watermarks, signatures)\n' +
      'Be thorough. Output plain text only. Do not refuse — describe what you see.'
    : 'Extract all visible text from each image verbatim, preserving line breaks. Label each as "=== IMAGE {i} ===" then the text.';

  try {
    const { content } = await visionByUrl({ imageUrls: list, prompt });
    const text = (content || '').trim();
    if (text.length < 5) return { content: '', ok: false, reason: 'empty_response' };
    return { content: text, ok: true };
  } catch (err) {
    console.warn('[vision-url] failed:', err.code || err.message);
    return { content: '', ok: false, reason: err.code || err.message };
  }
}

// Kept as no-ops so existing callers (server.js) don't break during the transition.
export function warmupOcrWorker() {}
export async function terminateOcrWorker() {}
