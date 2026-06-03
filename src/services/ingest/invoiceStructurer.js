// invoiceStructurer — turn raw OCR text into a structured invoice via an LLM.
//
// PaddleOCR gives accurate characters but no structure (it's a flat text dump +
// boxes). The vision model gives layout understanding. We feed BOTH to a chat
// LLM with a strict JSON schema instruction and parse the result. Numbers are
// NOT trusted here — invoiceValidator re-derives and checks them afterwards.
//
// Uses aiProvider.chat (CF→PEB fallback) at low temperature for determinism.

import { chat } from '../aiProvider.js';
import { MODELS } from '../modelRegistry.js';

const SYSTEM = `You convert OCR'd invoice text into structured JSON. Output ONLY valid JSON, no prose, no markdown fences.
Schema:
{
  "vendor": string|null,
  "invoice_no": string|null,
  "issued_at": "YYYY-MM-DD"|null,
  "currency": string|null,
  "subtotal": number|null,
  "tax": number|null,
  "total": number|null,
  "line_items": [
    { "description": string, "qty": number|null, "unit_price": number|null, "line_total": number|null }
  ]
}
Rules:
- Copy numbers EXACTLY as printed; do not compute or "fix" them — a validator checks the math separately.
- Use null for any field not present. Never invent values.
- Strip currency symbols and thousands separators from numeric fields (1.234,50 → 1234.50 if comma is decimal).`;

// Strip ```json fences / leading prose and parse the first JSON object found.
export function parseInvoiceJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  // Remove code fences if present.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // Grab the outermost {...} if there's surrounding text.
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  const slice = s.slice(start, end + 1);
  try {
    const obj = JSON.parse(slice);
    if (!obj || typeof obj !== 'object') return null;
    if (!Array.isArray(obj.line_items)) obj.line_items = [];
    return obj;
  } catch {
    return null;
  }
}

// ocrText: PaddleOCR flat text (authoritative for characters).
// visionText: optional layout description from the vision model.
// Returns a parsed invoice object, or throws if the LLM output can't be parsed.
export async function structureInvoice({ ocrText, visionText = '', meta = {} }) {
  const userParts = [
    '=== OCR TEXT (authoritative for exact characters/numbers) ===',
    ocrText || '(none)',
  ];
  if (visionText) {
    userParts.push('', '=== VISION LAYOUT DESCRIPTION (for structure/columns) ===', visionText);
  }
  userParts.push('', 'Return the invoice as JSON per the schema.');

  const { content, provider } = await chat({
    model: MODELS.chatDefault,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userParts.join('\n') },
    ],
    options: { temperature: 0.1, max_tokens: 2048 },
    meta: { ...meta, purpose: 'invoice_structure' },
  });

  const parsed = parseInvoiceJson(content);
  if (!parsed) {
    const err = new Error('invoice structurer: LLM returned unparseable JSON');
    err.code = 'ERR_INVOICE_PARSE';
    throw err;
  }
  return { invoice: parsed, provider };
}
