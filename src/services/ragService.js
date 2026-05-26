import { query } from '../db/index.js';
import { generateEmbedding, chunkText, EMBED_MODEL_TAG } from './embeddingService.js';

const BATCH_SIZE = 50;
const TOP_K = 5;

export async function storeDocument(documentId, fullText) {
  const chunks = chunkText(fullText);
  if (chunks.length === 0) {
    await query(`UPDATE documents SET status='ready', error_msg='No text content found' WHERE id=$1`, [documentId]);
    return;
  }

  // First pass: write every chunk WITHOUT embedding so the document is at
  // least readable via the unranked-fallback path in similaritySearch() even
  // if Cloudflare's embed quota is exhausted right now.
  for (let i = 0; i < chunks.length; i++) {
    await query(
      `INSERT INTO document_chunks (document_id, chunk_index, content)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [documentId, i, chunks[i]],
    );
  }
  // Mark ready immediately — user can chat with this file even before embeddings
  // are computed. RAG ranking will kick in once the second pass below finishes.
  await query(`UPDATE documents SET status='ready' WHERE id=$1`, [documentId]);

  // Second pass: try to embed each chunk. On failure (e.g. CF 429) we log
  // and move on — the chunk row already exists, missing embedding just means
  // it won't be ranked by similarity until a future re-embed pass.
  let embeddedCount = 0;
  let failedCount = 0;
  for (let i = 0; i < chunks.length; i++) {
    try {
      const embedding = await generateEmbedding(chunks[i]);
      await query(
        `UPDATE document_chunks
            SET embedding = $1::vector, embedding_model = $2
          WHERE document_id = $3 AND chunk_index = $4`,
        [JSON.stringify(embedding), EMBED_MODEL_TAG, documentId, i],
      );
      embeddedCount += 1;
    } catch (err) {
      failedCount += 1;
      // Don't spam logs — log first failure only, then aggregate.
      if (failedCount === 1) {
        console.warn(`[RAG] embed pending for doc=${documentId}: ${err.message}`);
      }
    }
  }
  if (failedCount > 0) {
    console.warn(`[RAG] doc=${documentId}: embedded ${embeddedCount}/${chunks.length}, ${failedCount} pending re-embed`);
  }
}

const SIMILARITY_THRESHOLD = 0.0;

// Search only within specified document IDs (from user's attached files).
// Falls back to all user docs only when documentIds is explicitly null (legacy/API use).
export async function similaritySearch(queryText, userId, documentIds, topK = TOP_K) {
  if (Array.isArray(documentIds) && documentIds.length === 0) return [];

  let queryEmbedding;
  try {
    queryEmbedding = await generateEmbedding(queryText);
  } catch (err) {
    console.warn('[RAG] Embedding failed:', err.message);
    // When embed is unavailable (e.g. Cloudflare quota exhausted) we still
    // want the user's attached document to reach the model. Fall back to
    // returning the FIRST N chunks of each attached doc — not ranked by
    // similarity, but better than an empty context. Only do this when the
    // caller explicitly attached docs; the global-search fallback (null
    // documentIds) stays disabled because it would dump huge irrelevant text.
    if (Array.isArray(documentIds) && documentIds.length) {
      try {
        const { rows } = await query(
          `SELECT dc.content, dc.document_id, NULL::float AS similarity
           FROM document_chunks dc
           JOIN documents d ON d.id = dc.document_id
           WHERE d.user_id = $1 AND d.status = 'ready'
             AND dc.document_id = ANY($2::uuid[])
           ORDER BY dc.document_id, dc.chunk_index
           LIMIT $3`,
          [userId, documentIds, topK]
        );
        if (rows.length) {
          console.warn(`[RAG] fallback: returning ${rows.length} unranked chunks (embed unavailable)`);
          return rows;
        }
      } catch (fbErr) {
        console.warn('[RAG] unranked fallback also failed:', fbErr.message);
      }
    }
    return [];
  }

  let result;
  if (Array.isArray(documentIds)) {
    result = await query(
      `SELECT dc.content, dc.document_id, d.name AS document_name, d.kind AS document_kind,
              1 - (dc.embedding <=> $1::vector) AS similarity
       FROM document_chunks dc
       JOIN documents d ON d.id = dc.document_id
       WHERE d.user_id = $2 AND d.status = 'ready'
         AND dc.document_id = ANY($3::uuid[])
         AND 1 - (dc.embedding <=> $1::vector) >= $5
       ORDER BY dc.embedding <=> $1::vector
       LIMIT $4`,
      [JSON.stringify(queryEmbedding), userId, documentIds, topK, SIMILARITY_THRESHOLD],
    );
  } else {
    // null = search all user docs (legacy fallback)
    result = await query(
      `SELECT dc.content, dc.document_id, d.name AS document_name, d.kind AS document_kind,
              1 - (dc.embedding <=> $1::vector) AS similarity
       FROM document_chunks dc
       JOIN documents d ON d.id = dc.document_id
       WHERE d.user_id = $2 AND d.status = 'ready'
         AND 1 - (dc.embedding <=> $1::vector) >= $4
       ORDER BY dc.embedding <=> $1::vector
       LIMIT $3`,
      [JSON.stringify(queryEmbedding), userId, topK, SIMILARITY_THRESHOLD],
    );
  }

  return result.rows;
}

/**
 * Build a single context string the model can quote from. Chunks are GROUPED
 * BY source file so a multi-file question ("compare A.pdf vs B.txt") gets a
 * clear, file-labelled context instead of a flat soup of fragments where the
 * model has to guess which chunk came from which file.
 */
export function buildContext(chunks) {
  if (!chunks.length) return null;

  // Group chunks by document, preserving the original similarity order so the
  // most-relevant file appears first.
  const groups = new Map();   // docId → { name, kind, parts: [] }
  for (const c of chunks) {
    const id = c.document_id || 'unknown';
    if (!groups.has(id)) {
      groups.set(id, {
        name: c.document_name || `Document ${id.slice(0, 8)}`,
        kind: c.document_kind || 'document',
        parts: [],
      });
    }
    groups.get(id).parts.push(c.content);
  }

  const sections = [];
  for (const g of groups.values()) {
    const header = `── File: "${g.name}" (${g.kind}) ──`;
    sections.push(`${header}\n${g.parts.join('\n…\n')}`);
  }
  return (
    'Trích nội dung liên quan từ các file người dùng đã đính kèm. Mỗi đoạn được gắn rõ tên file nguồn — khi trả lời hãy nêu rõ thông tin lấy từ file nào nếu có nhiều file:\n\n' +
    sections.join('\n\n')
  );
}

/**
 * List the user's attached documents as a manifest the model can reference in
 * its reply. Independent of RAG ranking — even files that didn't surface in
 * the top-K chunks still appear here so the model knows they exist.
 */
export async function buildAttachmentManifest(docIds, userId) {
  if (!Array.isArray(docIds) || !docIds.length) return '';
  try {
    const { rows } = await query(
      `SELECT id, name, kind, status
       FROM documents
       WHERE user_id = $1 AND id = ANY($2::uuid[])
       ORDER BY created_at ASC`,
      [userId, docIds]
    );
    if (!rows.length) return '';
    const lines = rows.map((r, i) => {
      const tag = r.kind === 'image' ? '🖼' : r.kind === 'pdf' ? '📄' : r.kind === 'code' ? '💻' : '📝';
      const note = r.status !== 'ready' ? ` (đang ${r.status})` : '';
      return `${i + 1}. ${tag} "${r.name}" — loại: ${r.kind}${note}`;
    });
    return `Người dùng đã đính kèm ${rows.length} file trong tin nhắn này:\n${lines.join('\n')}\n\nKhi trả lời, hãy phân biệt rõ thông tin từ file nào nếu câu hỏi liên quan đến nhiều file.`;
  } catch (err) {
    console.warn('[RAG] buildAttachmentManifest failed:', err.message);
    return '';
  }
}
