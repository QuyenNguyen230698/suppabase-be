// ocrCore — OCR ingestion core (structured invoice extraction).
//
// Unlike the other cores (which produce RAG vector chunks), this one produces
// RELATIONAL data: an invoices row + invoice_line_items rows, arithmetically
// validated. Flow (matches the OCR-core sitemap):
//
//   PaddleOCR sidecar (accurate text)        ── required, fail → retry/DLQ
//        + vision model (layout description) ── best-effort, enriches structure
//   → LLM structurer (text → JSON)
//   → validator (qty×price=total, Σ=subtotal, +tax=total)
//   → pass: review_status='auto_ok'   | fail: 'needs_review'
//   → persist invoices + invoice_line_items (one transaction)
//
// PaddleOCR is mandatory: number accuracy on financial data must not silently
// degrade to vision-only (see paddleClient policy note).

import pool, { query } from '../../../db/index.js';
import { fetchFromR2 } from '../../r2Service.js';
import { ocr as paddleOcr, isConfigured as paddleConfigured } from '../paddleClient.js';
import { extractTextFromImage } from '../../ocrService.js';
import { structureInvoice } from '../invoiceStructurer.js';
import { validateInvoice } from '../invoiceValidator.js';
import { incCounter } from '../metrics.js';
import { extractText } from '../../extractors/index.js';
import { chunkText, EMBED_MODEL_TAG } from '../../embeddingService.js';
import { embedValidated } from '../embedGuard.js';

// Fallback when the PaddleOCR sidecar isn't configured: a text PDF can still be
// made searchable via its embedded text layer (pdf-parse) — chunk + embed it as
// RAG content, exactly like the text core. Scanned/image-only PDFs yield no text
// here and are flagged for review (they genuinely need OCR). This keeps normal
// text PDFs working without a sidecar instead of dead-lettering every PDF.
async function runPdfTextFallback(doc, buffer) {
  let text = ''
  try {
    text = await extractText(buffer, doc.type || 'application/pdf', 'document')
  } catch (err) {
    await query(
      `UPDATE documents SET status='error', error_msg=$2 WHERE id=$1`,
      [doc.id, `PDF text extraction failed (no OCR sidecar): ${err.message}`.slice(0, 500)],
    )
    return
  }
  if (!text || text.trim().length < 5) {
    await query(
      `UPDATE documents SET status='error',
              error_msg='Scanned PDF needs OCR (PaddleOCR sidecar not configured)' WHERE id=$1`,
      [doc.id],
    )
    return
  }

  const chunks = chunkText(text)
  // Pass 1: store chunks immediately so the doc is usable even if embed is down.
  for (let i = 0; i < chunks.length; i++) {
    await query(
      `INSERT INTO document_chunks (document_id, chunk_index, content)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [doc.id, i, chunks[i]],
    )
  }
  await query(`UPDATE documents SET status='ready' WHERE id=$1`, [doc.id])

  // Pass 2: best-effort embeddings (non-fatal except poison vectors).
  for (let i = 0; i < chunks.length; i++) {
    try {
      const vec = await embedValidated(chunks[i])
      await query(
        `UPDATE document_chunks
            SET embedding=$1::vector, embedding_model=$5, embedding_dim=$6, embed_ok=TRUE, embedded_at=NOW()
          WHERE document_id=$2 AND chunk_index=$3 AND content=$4`,
        [JSON.stringify(vec), doc.id, i, chunks[i], EMBED_MODEL_TAG, vec.length],
      )
    } catch (err) {
      if (err.code === 'ERR_EMBED_INVALID') throw err
      incCounter('ingest_embed_total', { outcome: 'fail' })
    }
  }
  console.log(`[ingest] pdf-text fallback doc=${doc.id} chunks=${chunks.length} (no PaddleOCR)`)
}

// Best-effort vision layout description. A failure here is non-fatal — Paddle
// text alone is enough to structure; vision just improves column/row mapping.
async function visionLayout(buffer) {
  try {
    return await extractTextFromImage(buffer, { rich: true });
  } catch (err) {
    console.warn('[ingest] ocr vision layout failed (non-fatal):', err.message);
    return '';
  }
}

async function persistInvoice(doc, structured, validation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inv = await client.query(
      `INSERT INTO invoices
         (document_id, user_id, vendor, invoice_no, issued_at, currency,
          subtotal, tax, total, review_status, validation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       RETURNING id`,
      [
        doc.id, doc.user_id,
        structured.vendor ?? null, structured.invoice_no ?? null,
        structured.issued_at || null, structured.currency ?? null,
        validation.derived.subtotal, validation.derived.tax, validation.derived.total,
        validation.review_status,
        JSON.stringify({ issues: validation.issues, checks: validation.checks }),
      ],
    );
    const invoiceId = inv.rows[0].id;

    for (let i = 0; i < validation.line_items.length; i++) {
      const li = validation.line_items[i];
      await client.query(
        `INSERT INTO invoice_line_items
           (invoice_id, line_no, description, qty, unit_price, line_total, calc_ok)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [invoiceId, i + 1, li.description ?? null, li.qty, li.unit_price, li.line_total, li.calc_ok],
      );
    }
    await client.query('COMMIT');
    return invoiceId;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function runOcr(doc) {
  if (!doc.r2_key) throw new Error('document has no r2_key');
  const buffer = await fetchFromR2(doc.r2_key);

  // 0. No PaddleOCR sidecar? Don't dead-letter every PDF — fall back to the
  //    embedded text layer so normal text PDFs still become searchable. (The
  //    invoice/structured path below requires Paddle and is skipped here.)
  if (!paddleConfigured()) {
    await runPdfTextFallback(doc, buffer);
    return;
  }

  // 1. PaddleOCR — required. Throws (→ retry/DLQ) if unconfigured/unreachable.
  const paddle = await paddleOcr(buffer, { filename: doc.name, contentType: doc.type });
  if (!paddle.text || paddle.text.trim().length < 5) {
    // Paddle ran but found nothing readable — not a transient error; flag for review.
    await query(
      `UPDATE documents SET status='error', error_msg='OCR found no readable text' WHERE id=$1`,
      [doc.id],
    );
    return;
  }

  // 2. Vision layout (best-effort) + 3. structure via LLM.
  const visionText = await visionLayout(buffer);
  const { invoice } = await structureInvoice({
    ocrText: paddle.text,
    visionText,
    meta: { userId: doc.user_id, documentId: doc.id },
  });

  // 4. Validate arithmetic → review status.
  const validation = validateInvoice(invoice);

  // 5. Persist relational rows.
  const invoiceId = await persistInvoice(doc, invoice, validation);
  incCounter('ingest_ocr_total', { review_status: validation.review_status });

  await query(`UPDATE documents SET status='ready' WHERE id=$1`, [doc.id]);
  console.log(
    `[ingest] ocr doc=${doc.id} invoice=${invoiceId} status=${validation.review_status}` +
    (validation.issues.length ? ` issues=[${validation.issues.join('; ')}]` : ''),
  );
}
