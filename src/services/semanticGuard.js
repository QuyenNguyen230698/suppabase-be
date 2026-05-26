// L3 — Semantic similarity guardrail.
//
// Embed the user message with bge-m3, look up top-K closest banned_exemplars
// via pgvector cosine, block when max_similarity ≥ category threshold.
//
// Defends against paraphrase / synonym / typo attacks that L1 regex misses.
//
// Failure modes (all fail-open — never block due to infra):
//   • No exemplars embedded yet → return safe, log once.
//   • Embed API fails / quota → return safe, log warning.
//   • DB error → return safe, log warning.
//
// Performance: 1 embed call (~150ms CF p50) + 1 HNSW query (~5ms). Skipped
// entirely when input < 8 chars (regex enough) or already blocked by earlier layer.

import { query } from '../db/index.js';
import { generateEmbedding } from './embeddingService.js';

const DEFAULT_THRESHOLD = parseFloat(process.env.L3_SIM_THRESHOLD || '0.78');
const TOP_K = 3;
const MIN_LEN_CHARS = 8;

let healthy = null;   // null=unchecked, true=has embeddings, false=empty
let lastHealthCheck = 0;
const HEALTH_TTL_MS = 60 * 1000;

async function isHealthy() {
  if (healthy !== null && (Date.now() - lastHealthCheck) < HEALTH_TTL_MS) return healthy;
  try {
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM banned_exemplars WHERE embedding IS NOT NULL AND is_active = TRUE`
    );
    healthy = (rows[0]?.n || 0) > 0;
    lastHealthCheck = Date.now();
    if (!healthy) console.warn('[L3] no embedded exemplars — fail-open mode');
  } catch (err) {
    healthy = false;
    console.warn('[L3] health check failed:', err.message);
  }
  return healthy;
}

export function _invalidateHealth() { healthy = null; }

/**
 * Check input against banned exemplars by semantic similarity.
 * Returns:
 *   { safe: true }                                          — nothing close
 *   { safe: false, category, similarity, exemplar, threshold } — top-1 ≥ threshold
 *   { safe: true, degraded: true, reason }                  — fail-open
 */
export async function checkSemantic(text) {
  if (!text || text.length < MIN_LEN_CHARS) return { safe: true };
  if (!(await isHealthy())) return { safe: true, degraded: true, reason: 'no_exemplars' };

  let vec;
  try {
    vec = await generateEmbedding(text);
  } catch (err) {
    return { safe: true, degraded: true, reason: `embed_failed:${err.code || err.message}` };
  }
  if (!Array.isArray(vec) || vec.length === 0) {
    return { safe: true, degraded: true, reason: 'empty_embedding' };
  }

  const literal = `[${vec.join(',')}]`;

  let rows;
  try {
    const r = await query(
      `SELECT b.id, b.category_code, b.text, b.threshold,
              1 - (b.embedding <=> $1::vector) AS similarity,
              c.severity
       FROM banned_exemplars b
       JOIN threat_categories c ON c.code = b.category_code
       WHERE b.embedding IS NOT NULL AND b.is_active = TRUE
       ORDER BY b.embedding <=> $1::vector
       LIMIT $2`,
      [literal, TOP_K]
    );
    rows = r.rows;
  } catch (err) {
    return { safe: true, degraded: true, reason: `db_failed:${err.message}` };
  }
  if (!rows || !rows.length) return { safe: true, degraded: true, reason: 'no_neighbors' };

  const top = rows[0];
  const threshold = top.threshold ?? DEFAULT_THRESHOLD;
  if (top.similarity >= threshold) {
    return {
      safe: false,
      layer: 'L3_semantic',
      category: top.category_code,
      severity: top.severity,
      similarity: top.similarity,
      threshold,
      exemplar_id: top.id,
      exemplar_text: top.text,
      reason: `Yêu cầu tương tự một mẫu vi phạm đã biết (${top.category_code}).`,
    };
  }
  return { safe: true, top_similarity: top.similarity, top_category: top.category_code };
}
