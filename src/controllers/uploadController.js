import { query } from '../db/index.js';
import { extractText } from '../services/extractors/index.js';
import { runExtract } from '../services/extractorQueue.js';
import { storeDocument } from '../services/ragService.js';
import {
  uploadToR2, deleteFromR2, r2KeyForDocument, r2PublicUrl,
} from '../services/r2Service.js';

// Process an attachment after the R2 upload + DB row are in place.
// - 'image': nothing to index now; vision will read R2 buffer at chat time.
// - 'pdf' / 'document' / 'code' / 'text': extract text and feed RAG.
async function processAttachment(doc, buffer) {
  if (doc.kind === 'image') {
    await query(`UPDATE documents SET status='ready' WHERE id=$1`, [doc.id]);
    return;
  }
  try {
    const text = await runExtract(() => extractText(buffer, doc.type, doc.kind));
    if (!text || !text.trim()) {
      await query(
        `UPDATE documents SET status='error', error_msg='No text could be extracted' WHERE id=$1`,
        [doc.id],
      );
      return;
    }
    await storeDocument(doc.id, text);   // sets status='ready' inside
  } catch (err) {
    console.error(`[upload] processing failed for doc ${doc.id}:`, err.message);
    await query(
      `UPDATE documents SET status='error', error_msg=$1 WHERE id=$2`,
      [err.message.slice(0, 500), doc.id],
    );
  }
}

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

  // 3. Async post-processing (text extraction / RAG).
  setImmediate(() => processAttachment({ id: docId, kind, type: mimetype }, buffer));

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
