// dispatcher — routes a claimed ingest job to its core handler.
//
//   text / code → codeTextCore (symbol-aware code chunking, validated embeds)
//   image       → imageCore (vision caption + OCR → searchable chunks)
//   ocr         → ocrCore (PaddleOCR → vision → structure → validate → invoices)
//
// A handler throws on transient/poison failure → the worker retries with
// backoff, then dead-letters. A handler that finishes resolves → job 'done'.

import { query } from '../../db/index.js';
import { runCodeText } from './cores/codeTextCore.js';
import { runImage } from './cores/imageCore.js';
import { runOcr } from './cores/ocrCore.js';

async function loadDocument(documentId) {
  const { rows } = await query(
    `SELECT id, user_id, name, type, kind, r2_key FROM documents WHERE id = $1`,
    [documentId],
  );
  return rows[0] || null;
}

const HANDLERS = {
  text:  runCodeText,
  code:  runCodeText,
  ocr:   runOcr,
  image: runImage,
};

// Dispatch one job. Throws on failure (worker handles retry/DLQ).
export async function dispatch(job) {
  const handler = HANDLERS[job.core];
  if (!handler) throw new Error(`No handler for core '${job.core}'`);
  const doc = await loadDocument(job.document_id);
  if (!doc) throw new Error(`document ${job.document_id} not found`);
  await handler(doc);
}
