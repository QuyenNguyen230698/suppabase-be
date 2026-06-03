import { query } from '../db/index.js';
import {
  uploadToR2, deleteFromR2, r2KeyForDocument, r2PublicUrl,
} from '../services/r2Service.js';
import { enqueueDocument } from '../services/ingest/ingestionCore.js';

export async function uploadFile(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No file provided', code: 'ERR_NO_FILE' });

  const { originalname, mimetype, size, buffer, kind } = req.file;
  const userId = req.user.id;

  // 1. Insert row with status=processing — we need the id for the R2 key.
  let docId;
  try {
    const { rows } = await query(
      `INSERT INTO documents (user_id, name, type, size_bytes, status, kind)
       VALUES ($1, $2, $3, $4, 'processing', $5)
       RETURNING id`,
      [userId, originalname, mimetype, size, kind],
    );
    docId = rows[0].id;
  } catch (err) {
    console.error('[upload] DB insert failed:', err.message);
    return res.status(500).json({ error: 'Database error', code: 'ERR_DB' });
  }

  // 2. Upload to R2 under suppabase-ai/<userId>/<docId>.<ext>
  const r2Key = r2KeyForDocument(userId, docId, originalname);
  try {
    await uploadToR2(r2Key, buffer, mimetype);
  } catch (err) {
    console.error(`[upload] R2 upload failed for ${r2Key}:`, err.message);
    await query(
      `UPDATE documents SET status='error', error_msg=$1 WHERE id=$2`,
      [`R2 upload failed: ${err.message}`.slice(0, 500), docId],
    );
    return res.status(502).json({ error: 'Storage upload failed', code: 'ERR_R2_UPLOAD' });
  }

  // Only expose a direct R2 public URL for kinds that are safe to serve
  // inline from the bucket. HTML/SVG/JS/text/code MUST go through the BE
  // proxy below (forced Content-Disposition: attachment) so the bucket
  // can't be weaponized for stored XSS or malware hosting.
  const PUBLIC_KINDS = new Set(['image', 'pdf']);
  const publicUrl = PUBLIC_KINDS.has(kind) ? r2PublicUrl(r2Key) : null;
  await query(
    `UPDATE documents SET r2_key=$1, r2_public_url=$2 WHERE id=$3`,
    [r2Key, publicUrl, docId],
  );

  // 3. Route + enqueue durable ingest job. The background worker
  //    (services/ingest/queue/worker.js) picks it up — survives restarts and
  //    retries with backoff, unlike the old in-process setImmediate path.
  try {
    await enqueueDocument({ documentId: docId, kind, mimetype });
  } catch (err) {
    console.error(`[upload] enqueue failed for doc ${docId}:`, err.message);
    await query(
      `UPDATE documents SET status='error', error_msg=$1 WHERE id=$2`,
      [`enqueue failed: ${err.message}`.slice(0, 500), docId],
    );
  }

  res.status(201).json({
    document_id: docId,
    name: originalname,
    type: mimetype,
    size,
    kind,
    status: 'processing',
    r2_key: r2Key,
    r2_public_url: publicUrl,
  });
}

// Direct delete (used when the user removes a chip from the composer before
// sending, or via the documents list).
export async function deleteDocument(req, res) {
  const userId = req.user.id;
  const docId  = req.params.id;
  try {
    const { rows } = await query(
      `SELECT id, r2_key FROM documents WHERE id=$1 AND user_id=$2`,
      [docId, userId],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Document not found', code: 'ERR_NOT_FOUND' });
    if (rows[0].r2_key) await deleteFromR2(rows[0].r2_key);
    await query(`DELETE FROM documents WHERE id=$1`, [docId]);
    res.json({ success: true });
  } catch (err) {
    console.error('[upload] delete failed:', err.message);
    res.status(500).json({ error: 'Delete failed', code: 'ERR_DB' });
  }
}
