import { query } from '../db/index.js';
import { sendError } from '../i18n/messages.js';

// ── GET /api/tags ─────────────────────────────────────────────
export async function listTags(req, res) {
  const { rows } = await query(
    `SELECT t.id, t.name, t.color,
            (SELECT COUNT(*) FROM conversation_tags ct WHERE ct.tag_id = t.id)::int AS usage_count
       FROM tags t
      WHERE t.user_id = $1
      ORDER BY usage_count DESC, t.name ASC`,
    [req.user.id]
  );
  res.json({ items: rows });
}

// ── POST /api/tags  { name, color? } ──────────────────────────
export async function createTag(req, res) {
  const userId = req.user.id;
  const name = (req.body?.name || '').trim();
  if (!name) return sendError(res, 400, 'ERR_FIELD_REQUIRED');
  const color = req.body?.color || 'gray';

  try {
    const { rows } = await query(
      `INSERT INTO tags (user_id, name, color) VALUES ($1, $2, $3) RETURNING *`,
      [userId, name, color]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return sendError(res, 409, 'ERR_DUPLICATE');
    throw err;
  }
}

// ── PATCH /api/tags/:id ───────────────────────────────────────
export async function updateTag(req, res) {
  const userId = req.user.id;
  const { id } = req.params;
  const sets = [];
  const params = [id, userId];
  let i = 3;
  if (Object.hasOwn(req.body || {}, 'name')) {
    params.push((req.body.name || '').trim());
    sets.push(`name = $${i++}`);
  }
  if (Object.hasOwn(req.body || {}, 'color')) {
    params.push(req.body.color);
    sets.push(`color = $${i++}`);
  }
  if (!sets.length) return sendError(res, 400, 'ERR_VALIDATION');

  const { rows } = await query(
    `UPDATE tags SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING *`,
    params
  );
  if (!rows.length) return sendError(res, 404, 'ERR_NOT_FOUND');
  res.json(rows[0]);
}

// ── DELETE /api/tags/:id ──────────────────────────────────────
export async function deleteTag(req, res) {
  const { rowCount } = await query(
    `DELETE FROM tags WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!rowCount) return sendError(res, 404, 'ERR_NOT_FOUND');
  res.json({ ok: true });
}

// ── POST /api/conversations/:id/tags { tag_id } ───────────────
export async function attachTag(req, res) {
  const userId = req.user.id;
  const { id } = req.params;
  const tagId = req.body?.tag_id;
  if (!tagId) return sendError(res, 400, 'ERR_FIELD_REQUIRED');

  const check = await query(
    `SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2
      UNION ALL
     SELECT 1 FROM tags WHERE id = $3 AND user_id = $2`,
    [id, userId, tagId]
  );
  if (check.rowCount < 2) return sendError(res, 404, 'ERR_NOT_FOUND');

  await query(
    `INSERT INTO conversation_tags (conversation_id, tag_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [id, tagId]
  );
  res.json({ ok: true });
}

// ── DELETE /api/conversations/:id/tags/:tag_id ────────────────
export async function detachTag(req, res) {
  const userId = req.user.id;
  const { id, tag_id } = req.params;
  const check = await query(
    `SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  if (!check.rowCount) return sendError(res, 404, 'ERR_NOT_FOUND');
  await query(
    `DELETE FROM conversation_tags WHERE conversation_id = $1 AND tag_id = $2`,
    [id, tag_id]
  );
  res.json({ ok: true });
}
