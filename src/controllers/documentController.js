import { query } from '../db/index.js';
import { deleteFromR2, fetchFromR2 } from '../services/r2Service.js';

const DOC_COLUMNS = `id, name, type, kind, size_bytes, status, error_msg, r2_key, r2_public_url, created_at`;

export async function listDocuments(req, res) {
  const result = await query(
    `SELECT ${DOC_COLUMNS} FROM documents WHERE user_id=$1 ORDER BY created_at DESC`,
    [req.user.id],
  );
  res.json(result.rows);
}

export async function getDocument(req, res) {
  const result = await query(
    `SELECT ${DOC_COLUMNS} FROM documents WHERE id=$1 AND user_id=$2`,
    [req.params.id, req.user.id],
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Document not found', code: 'ERR_NOT_FOUND' });
  res.json(result.rows[0]);
}

export async function getDocumentContent(req, res) {
  const doc = await query(
    `SELECT id, name, type, kind FROM documents WHERE id=$1 AND user_id=$2`,
    [req.params.id, req.user.id],
  );
  if (!doc.rows.length) return res.status(404).json({ error: 'Document not found', code: 'ERR_NOT_FOUND' });

  // Images don't have extracted text — point the caller at the R2 URL instead.
  if (doc.rows[0].kind === 'image') {
    return res.status(400).json({ error: 'Image documents have no text content', code: 'ERR_KIND' });
  }

  const chunks = await query(
    `SELECT content FROM document_chunks WHERE document_id=$1 ORDER BY chunk_index ASC`,
    [req.params.id],
  );
  const text = chunks.rows.map((r) => r.content).join('\n\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(text);
}

export async function getDocumentRaw(req, res) {
  const doc = await query(
    `SELECT id, name, type, kind, r2_key FROM documents WHERE id=$1 AND user_id=$2`,
    [req.params.id, req.user.id],
  );
  if (!doc.rows.length) return res.status(404).json({ error: 'Document not found', code: 'ERR_NOT_FOUND' });

  const { r2_key, type, name, kind } = doc.rows[0];

  if (!r2_key) return res.status(404).json({ error: 'File not available', code: 'ERR_NO_KEY' });

  try {
    const buffer = await fetchFromR2(r2_key);

    // Only image and PDF are safe to render inline. Everything else (HTML,
    // SVG, JS, docx, txt, code) must be downloaded as an attachment so the
    // browser can't execute it in this origin.
    const INLINE_SAFE = kind === 'image' || kind === 'pdf';
    const safeMime = INLINE_SAFE
      ? (type || 'application/octet-stream')
      : 'application/octet-stream';
    const disposition = INLINE_SAFE ? 'inline' : 'attachment';
    const safeName = String(name || 'file').replace(/[\r\n"\\]/g, '_');

    res.setHeader('Content-Type', safeMime);
    res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(safeName)}"`);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.send(buffer);
  } catch {
    res.status(502).json({ error: 'Failed to fetch file from storage', code: 'ERR_R2' });
  }
}

export async function deleteDocument(req, res) {
  const found = await query(
    `SELECT id, r2_key FROM documents WHERE id=$1 AND user_id=$2`,
    [req.params.id, req.user.id],
  );
  if (!found.rows.length) return res.status(404).json({ error: 'Document not found', code: 'ERR_NOT_FOUND' });

  if (found.rows[0].r2_key) await deleteFromR2(found.rows[0].r2_key);
  await query(`DELETE FROM documents WHERE id=$1`, [req.params.id]);
  res.json({ success: true });
}
