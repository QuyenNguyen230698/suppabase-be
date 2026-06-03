// embedGuard — validate an embedding before it touches the vector index.
//
// A garbage vector (wrong dimension, NaN/Inf component) silently poisons
// similarity search: cosine distance against it is meaningless and it can
// surface as a "match" for unrelated queries. So every embedding is validated
// here; a chunk whose embedding fails goes to the DLQ (via a thrown error the
// worker catches) instead of being written.
//
// bge-m3 produces 1024-dim vectors. Override via EMBED_DIM if the model changes.

import { generateEmbedding, EMBED_MODEL_TAG } from '../embeddingService.js';
import { query } from '../../db/index.js';
import { incCounter } from './metrics.js';

export const EMBED_DIM = Number(process.env.EMBED_DIM || 1024);

// Validate shape + finiteness. Returns { ok, reason, dim }.
export function validateEmbedding(vec) {
  if (!Array.isArray(vec)) return { ok: false, reason: 'not_array', dim: 0 };
  if (vec.length !== EMBED_DIM) return { ok: false, reason: `dim_${vec.length}_expected_${EMBED_DIM}`, dim: vec.length };
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { ok: false, reason: `non_finite_at_${i}`, dim: vec.length };
    }
  }
  return { ok: true, dim: vec.length };
}

// Embed text then validate. Throws on invalid embedding so the worker retries /
// dead-letters the job rather than persisting a bad vector.
export async function embedValidated(text) {
  const vec = await generateEmbedding(text);
  const v = validateEmbedding(vec);
  if (!v.ok) {
    incCounter('ingest_embed_total', { outcome: 'invalid' });
    const err = new Error(`embedding validation failed: ${v.reason}`);
    err.code = 'ERR_EMBED_INVALID';
    throw err;
  }
  incCounter('ingest_embed_total', { outcome: 'ok' });
  return vec;
}

// Persist one chunk row with its validated embedding + ingestion metadata.
// `meta` carries optional code-aware fields (lang, symbol, start_line, …).
export async function storeChunk(documentId, chunkIndex, content, embedding, meta = {}) {
  const v = validateEmbedding(embedding);
  await query(
    `INSERT INTO document_chunks
       (document_id, chunk_index, content, embedding, embedding_model,
        embedding_dim, embed_ok, embedded_at,
        lang, symbol, start_line, end_line, parent_signature)
     VALUES ($1, $2, $3, $4::vector, $5, $6, $7, NOW(),
             $8, $9, $10, $11, $12)
     ON CONFLICT DO NOTHING`,
    [
      documentId, chunkIndex, content,
      JSON.stringify(embedding), EMBED_MODEL_TAG,
      v.dim, v.ok,
      meta.lang ?? null, meta.symbol ?? null,
      meta.startLine ?? null, meta.endLine ?? null, meta.parentSignature ?? null,
    ],
  );
}
