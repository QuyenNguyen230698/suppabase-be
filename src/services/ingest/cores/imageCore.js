// imageCore — Image ingestion core.
//
// Per the sitemap: vision model (Llama-4-Scout, via ocrService) produces a
// caption + verbatim OCR text for the image; that text is chunked, embedded
// (validated), and stored as document_chunks so the image becomes searchable by
// content (not just openable). The image bytes still live in R2 and are read
// directly by vision at chat time, as before — this core ADDS retrievability.
//
// If vision yields nothing usable we still mark the doc ready (the image is
// viewable and vision can describe it live at chat time); a hard vision error
// throws so the worker retries / DLQs.

import { query } from '../../../db/index.js';
import { fetchFromR2 } from '../../r2Service.js';
import { extractTextFromImage } from '../../ocrService.js';
import { chunkText, EMBED_MODEL_TAG } from '../../embeddingService.js';
import { embedValidated } from '../embedGuard.js';
import { incCounter } from '../metrics.js';

export async function runImage(doc) {
  if (!doc.r2_key) throw new Error('document has no r2_key');
  const buffer = await fetchFromR2(doc.r2_key);

  // rich=true → describe + OCR (caption usable for retrieval and for a
  // text-only chat model to reason over the image).
  const caption = await extractTextFromImage(buffer, { rich: true });

  // No usable caption (blank/decorative image, or vision quota out): the image
  // is still viewable + describable live at chat time. Mark ready, no chunks.
  if (!caption || caption.trim().length < 5) {
    await query(`UPDATE documents SET status='ready' WHERE id=$1`, [doc.id]);
    return;
  }

  const chunks = chunkText(caption);
  // Pass 1: write rows so the image is immediately searchable by caption text.
  for (let i = 0; i < chunks.length; i++) {
    await query(
      `INSERT INTO document_chunks (document_id, chunk_index, content)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [doc.id, i, chunks[i]],
    );
  }
  await query(`UPDATE documents SET status='ready' WHERE id=$1`, [doc.id]);

  // Pass 2: validated embeddings.
  let pending = 0;
  for (let i = 0; i < chunks.length; i++) {
    try {
      const vec = await embedValidated(chunks[i]);
      await query(
        `UPDATE document_chunks
            SET embedding=$1::vector, embedding_model=$5, embedding_dim=$6, embed_ok=TRUE, embedded_at=NOW()
          WHERE document_id=$2 AND chunk_index=$3 AND content=$4`,
        [JSON.stringify(vec), doc.id, i, chunks[i], EMBED_MODEL_TAG, vec.length],
      );
    } catch (err) {
      pending++;
      if (err.code === 'ERR_EMBED_INVALID') throw err; // poison → DLQ
      incCounter('ingest_embed_total', { outcome: 'fail' });
      if (pending === 1) console.warn(`[ingest] image embed pending doc=${doc.id}: ${err.message}`);
    }
  }
}
