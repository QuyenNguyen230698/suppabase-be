// searchCore — knowledge-base search over ingested documents (the sitemap's
// "Search Core": filter + full-text + vector, reading back from the DBs the
// ingestion cores populated).
//
// Distinct from the existing /api/search/{conversations,messages} (which search
// chat history). This searches DOCUMENT CONTENT:
//   • document_chunks — hybrid: vector similarity (bge-m3) + keyword (tsvector),
//     scoped to the user, filterable by router_core ('image'|'code'|'text') and
//     code language.
//   • invoices       — structured OCR output, by vendor / invoice_no.
//
// Hybrid ranking: a chunk that matches semantically AND lexically ranks above
// one that matches only one. Vector is best-effort — if embedding the query
// fails (CF quota), we degrade to keyword-only instead of returning nothing.

import { query } from '../../db/index.js';
import { generateEmbedding } from '../embeddingService.js';

const DEFAULT_LIMIT = 10;
const VEC_WEIGHT = 0.6;   // semantic vs lexical blend
const KW_WEIGHT = 0.4;

const VALID_CORES = new Set(['image', 'code', 'text', 'ocr']);

// Search document chunks. Returns ranked rows with source doc + (code) location.
export async function searchChunks({ userId, q, core = null, lang = null, limit = DEFAULT_LIMIT }) {
  if (!userId || !q || !q.trim()) return [];
  const topK = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), 50);
  const coreFilter = VALID_CORES.has(core) ? core : null;

  let queryEmbedding = null;
  try {
    queryEmbedding = await generateEmbedding(q);
  } catch (err) {
    console.warn('[search] query embed failed, keyword-only:', err.message);
  }

  // websearch_to_tsquery handles user-typed queries ("foo bar", quoted phrases)
  // safely — no injection, no syntax errors on stray punctuation.
  const params = [userId, q];
  const filters = [];
  if (coreFilter) { params.push(coreFilter); filters.push(`d.router_core = $${params.length}`); }
  if (lang)       { params.push(lang);       filters.push(`dc.lang = $${params.length}`); }
  const filterSql = filters.length ? `AND ${filters.join(' AND ')}` : '';

  if (queryEmbedding) {
    params.push(JSON.stringify(queryEmbedding)); const embIdx = params.length;
    params.push(VEC_WEIGHT); const vwIdx = params.length;
    params.push(KW_WEIGHT);  const kwIdx = params.length;
    params.push(topK);       const limIdx = params.length;
    const { rows } = await query(
      `SELECT dc.document_id, dc.content, dc.lang, dc.symbol, dc.start_line, dc.end_line,
              d.name AS document_name, d.router_core,
              (1 - (dc.embedding <=> $${embIdx}::vector)) AS vec_score,
              ts_rank(to_tsvector('simple', dc.content), websearch_to_tsquery('simple', $2)) AS kw_score,
              ($${vwIdx} * (1 - (dc.embedding <=> $${embIdx}::vector))
               + $${kwIdx} * ts_rank(to_tsvector('simple', dc.content), websearch_to_tsquery('simple', $2))) AS score
         FROM document_chunks dc
         JOIN documents d ON d.id = dc.document_id
        WHERE d.user_id = $1
          AND d.status = 'ready'
          AND dc.embedding IS NOT NULL
          ${filterSql}
        ORDER BY score DESC
        LIMIT $${limIdx}`,
      params,
    );
    return rows;
  }

  // Keyword-only fallback (no embedding available).
  params.push(topK); const limIdx = params.length;
  const { rows } = await query(
    `SELECT dc.document_id, dc.content, dc.lang, dc.symbol, dc.start_line, dc.end_line,
            d.name AS document_name, d.router_core,
            NULL::float AS vec_score,
            ts_rank(to_tsvector('simple', dc.content), websearch_to_tsquery('simple', $2)) AS kw_score,
            ts_rank(to_tsvector('simple', dc.content), websearch_to_tsquery('simple', $2)) AS score
       FROM document_chunks dc
       JOIN documents d ON d.id = dc.document_id
      WHERE d.user_id = $1
        AND d.status = 'ready'
        AND to_tsvector('simple', dc.content) @@ websearch_to_tsquery('simple', $2)
        ${filterSql}
      ORDER BY score DESC
      LIMIT $${limIdx}`,
    params,
  );
  return rows;
}

// Search structured invoices (OCR core output) by vendor / invoice_no / total.
export async function searchInvoices({ userId, q, limit = DEFAULT_LIMIT }) {
  if (!userId || !q || !q.trim()) return [];
  const topK = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), 50);
  const { rows } = await query(
    `SELECT i.id, i.document_id, i.vendor, i.invoice_no, i.issued_at,
            i.currency, i.total, i.review_status, d.name AS document_name
       FROM invoices i
       JOIN documents d ON d.id = i.document_id
      WHERE i.user_id = $1
        AND (i.vendor ILIKE '%' || $2 || '%' OR i.invoice_no ILIKE '%' || $2 || '%')
      ORDER BY i.created_at DESC
      LIMIT $3`,
    [userId, q, topK],
  );
  return rows;
}
