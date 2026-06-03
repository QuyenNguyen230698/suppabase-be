// paddleClient — HTTP client for the PaddleOCR sidecar.
//
// PaddleOCR (a Python service, not a Cloudflare model) runs BEFORE the vision
// model in the OCR core because its character/number accuracy on printed
// invoices is higher than a vision LLM's reading. The sidecar exposes:
//
//   POST {PADDLE_OCR_URL}/ocr   (multipart: file=<image|pdf bytes>)
//   → { text: string, lines: [{ text, confidence, box }], mean_confidence }
//
// Policy (chosen for PR5): PaddleOCR is REQUIRED for the invoice path. If the
// sidecar is unconfigured or unreachable, we throw so the worker retries and
// eventually dead-letters — we do NOT silently fall back to vision-only, which
// would degrade number accuracy on financial data without anyone noticing.

const PADDLE_OCR_URL = (process.env.PADDLE_OCR_URL || '').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.PADDLE_OCR_TIMEOUT_MS || 30000);

export function isConfigured() {
  return !!PADDLE_OCR_URL;
}

// Run OCR on a document buffer. Throws (with a code) on any failure so the
// caller's job is retried/dead-lettered.
export async function ocr(buffer, { filename = 'doc', contentType = 'application/octet-stream' } = {}) {
  if (!PADDLE_OCR_URL) {
    const err = new Error('PaddleOCR sidecar not configured (PADDLE_OCR_URL)');
    err.code = 'ERR_PADDLE_NOT_CONFIGURED';
    throw err;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: contentType }), filename);

    const res = await fetch(`${PADDLE_OCR_URL}/ocr`, {
      method: 'POST',
      body: form,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`PaddleOCR ${res.status}: ${text.slice(0, 200)}`);
      err.code = res.status >= 500 ? 'ERR_PADDLE_UPSTREAM' : 'ERR_PADDLE_REQUEST';
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    return {
      text: data.text || '',
      lines: Array.isArray(data.lines) ? data.lines : [],
      meanConfidence: typeof data.mean_confidence === 'number' ? data.mean_confidence : null,
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error(`PaddleOCR timed out after ${TIMEOUT_MS}ms`);
      e.code = 'ERR_PADDLE_TIMEOUT';
      throw e;
    }
    if (!err.code) err.code = 'ERR_PADDLE_UPSTREAM';
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
