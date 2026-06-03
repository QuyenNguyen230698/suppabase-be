// codeTextCore — Text/Code ingestion core.
//
//   code  → chunk by symbol (codeChunker) + prepend parent signature
//   text  → chunk by sentence/paragraph (existing embeddingService.chunkText)
// Then embed each chunk (validated by embedGuard) and store with metadata.
//
// First pass writes all chunk rows WITHOUT embeddings (so the doc is at least
// readable via the unranked fallback in similaritySearch even if embed quota is
// out), then a second pass fills + validates embeddings — same resilience the
// old storeDocument had, but now embedding-validated and code-aware.

import { query } from '../../../db/index.js';
import { fetchFromR2 } from '../../r2Service.js';
import { extractText } from '../../extractors/index.js';
import { chunkText, EMBED_MODEL_TAG } from '../../embeddingService.js';
import { chunkCode } from '../codeChunker.js';
import { embedValidated } from '../embedGuard.js';
import { incCounter } from '../metrics.js';

// Produce chunk records (content + optional code metadata) for a document.
function buildChunks(doc, text) {
  if (doc.kind === 'code') {
    return chunkCode(text, { name: doc.name });
  }
  return chunkText(text).map((content) => ({ content }));
}

export async function runCodeText(doc) {
  if (!doc.r2_key) throw new Error('document has no r2_key');
  const buffer = await fetchFromR2(doc.r2_key);
  const text = await extractText(buffer, doc.type, doc.kind);
  if (!text || !text.trim()) {
    await query(
      `UPDATE documents SET status='error', error_msg='No text could be extracted' WHERE id=$1`,
      [doc.id],
    );
    return;
  }

  const chunks = buildChunks(doc, text);
  if (!chunks.length) {
    await query(`UPDATE documents SET status='ready', error_msg='No content chunks' WHERE id=$1`, [doc.id]);
    return;
  }

  // Pass 1: rows without embeddings → doc immediately usable.
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    await query(
      `INSERT INTO document_chunks
         (document_id, chunk_index, content, lang, symbol, start_line, end_line, parent_signature)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT DO NOTHING`,
      [doc.id, i, c.content, c.lang ?? null, c.symbol ?? null,
       c.startLine ?? null, c.endLine ?? null, c.parentSignature ?? null],
    );
  }
  await query(`UPDATE documents SET status='ready' WHERE id=$1`, [doc.id]);

  // Pass 2: validated embeddings. A bad embedding throws → worker retries the
  // whole job; rows already exist so re-run is idempotent (ON CONFLICT).
  let embedded = 0, pending = 0;
  for (let i = 0; i < chunks.length; i++) {
    try {
      const vec = await embedValidated(chunks[i].content);
      await query(
        `UPDATE document_chunks
            SET embedding=$1::vector, embedding_model=$5, embedding_dim=$6, embed_ok=TRUE, embedded_at=NOW()
          WHERE document_id=$2 AND chunk_index=$3 AND content=$4`,
        [JSON.stringify(vec), doc.id, i, chunks[i].content, EMBED_MODEL_TAG, vec.length],
      );
      embedded++;
    } catch (err) {
      pending++;
      if (err.code === 'ERR_EMBED_INVALID') throw err; // poison → DLQ via worker
      incCounter('ingest_embed_total', { outcome: 'fail' });
      if (pending === 1) console.warn(`[ingest] embed pending doc=${doc.id}: ${err.message}`);
    }
  }
  if (pending) console.warn(`[ingest] codeText doc=${doc.id}: embedded ${embedded}/${chunks.length}, ${pending} pending`);
}
