#!/usr/bin/env node
/**
 * Re-embed all document chunks with the new model (Cloudflare bge-m3, 1024-dim).
 *
 * Run after applying migration 025_embedding_bge_m3.sql, which set every previously
 * 'ready' document to 'reindexing' and cleared the embedding column.
 *
 * Usage:
 *   node --env-file=.env.development scripts/reembed-all.js
 *   node --env-file=.env.development scripts/reembed-all.js --batch=20 --doc=<uuid>
 *
 * Idempotent: only touches chunks where embedding IS NULL. Re-runnable on failure.
 * Respects the neurons fallback threshold via aiProvider.embed (throws ERR_EMBED_QUOTA
 * when ≥9500 neurons used today — the script stops and reports remaining work).
 */
import { query, closePool } from '../src/db/index.js';
import { generateEmbedding, EMBED_MODEL_TAG } from '../src/services/embeddingService.js';

const args = process.argv.slice(2).reduce((acc, a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  acc[k] = v ?? true;
  return acc;
}, {});

const BATCH = parseInt(args.batch || '20', 10);
const ONLY_DOC = args.doc || null;

async function listPendingDocs() {
  const sql = ONLY_DOC
    ? `SELECT id, name FROM documents WHERE id = $1 AND status IN ('reindexing','ready')`
    : `SELECT id, name FROM documents WHERE status = 'reindexing' ORDER BY created_at ASC`;
  const params = ONLY_DOC ? [ONLY_DOC] : [];
  const { rows } = await query(sql, params);
  return rows;
}

async function reembedDoc(doc) {
  const { rows: chunks } = await query(
    `SELECT id, chunk_index, content
     FROM document_chunks
     WHERE document_id = $1 AND embedding IS NULL
     ORDER BY chunk_index ASC`,
    [doc.id],
  );

  if (chunks.length === 0) {
    await query(`UPDATE documents SET status = 'ready' WHERE id = $1`, [doc.id]);
    console.log(`  → ${doc.name}: no chunks to re-embed, marked ready`);
    return { processed: 0, total: 0 };
  }

  console.log(`  → ${doc.name} (${chunks.length} chunks)`);
  let processed = 0;

  for (let i = 0; i < chunks.length; i += BATCH) {
    const slice = chunks.slice(i, i + BATCH);
    for (const c of slice) {
      const vec = await generateEmbedding(c.content);
      if (!Array.isArray(vec) || vec.length === 0) {
        throw new Error(`Empty embedding returned for chunk ${c.id}`);
      }
      await query(
        `UPDATE document_chunks
         SET embedding = $1::vector, embedding_model = $2
         WHERE id = $3`,
        [JSON.stringify(vec), EMBED_MODEL_TAG, c.id],
      );
      processed += 1;
    }
    process.stdout.write(`    ${processed}/${chunks.length}\r`);
  }
  process.stdout.write('\n');

  await query(`UPDATE documents SET status = 'ready' WHERE id = $1`, [doc.id]);
  return { processed, total: chunks.length };
}

async function main() {
  console.log(`[reembed] model = ${EMBED_MODEL_TAG}, batch = ${BATCH}${ONLY_DOC ? `, doc = ${ONLY_DOC}` : ''}`);

  const docs = await listPendingDocs();
  if (docs.length === 0) {
    console.log('[reembed] No documents in reindexing state — nothing to do.');
    return;
  }

  console.log(`[reembed] ${docs.length} document(s) to process`);
  let okCount = 0;
  let failCount = 0;

  for (const doc of docs) {
    try {
      await reembedDoc(doc);
      okCount += 1;
    } catch (err) {
      failCount += 1;
      console.error(`[reembed] FAILED ${doc.name} (${doc.id}): ${err.message}`);
      if (err.code === 'ERR_EMBED_QUOTA') {
        console.error('[reembed] Neurons threshold reached — stopping. Resume after UTC 00:00.');
        break;
      }
      if (err.code === 'ERR_CF_NOT_CONFIGURED') {
        console.error('[reembed] Cloudflare not configured. Set CF_ACCOUNT_ID + CF_AI_TOKEN.');
        break;
      }
      await query(
        `UPDATE documents SET status = 'error', error_msg = $1 WHERE id = $2`,
        [`re-embed failed: ${err.message}`.slice(0, 500), doc.id],
      );
    }
  }

  console.log(`[reembed] done — ok=${okCount}, failed=${failCount}, skipped=${docs.length - okCount - failCount}`);
}

main()
  .catch((err) => {
    console.error('[reembed] fatal:', err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
