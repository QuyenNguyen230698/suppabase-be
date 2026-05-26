import { vision } from './aiProvider.js';

const OCR_PROMPT =
  'Extract ALL visible text from this image verbatim. Preserve line breaks and reading order. ' +
  'If the image contains code, tables, or diagrams, render them as plain text. ' +
  'Output text only, no commentary, no markdown wrapping.';

/**
 * Extract text from image buffer via Cloudflare Workers AI vision model.
 * Returns extracted text, or empty string on failure.
 */
export async function extractTextFromImage(imageBuffer) {
  try {
    const { content } = await vision({
      imageBuffer,
      prompt: OCR_PROMPT,
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

// Kept as no-ops so existing callers (server.js) don't break during the transition.
export function warmupOcrWorker() {}
export async function terminateOcrWorker() {}
