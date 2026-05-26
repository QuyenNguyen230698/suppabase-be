import { query } from '../db/index.js';
import { sendError } from '../i18n/messages.js';

// ── GET /api/projects ─────────────────────────────────────────
export async function listProjects(req, res) {
  const userId = req.user.id;
  const includeArchived = req.query.archived === '1';
  const { rows } = await query(
    `SELECT p.*,
            (SELECT COUNT(*) FROM conversations c
              WHERE c.project_id = p.id AND c.archived = FALSE)::int AS conversation_count,
            (SELECT COUNT(*) FROM project_documents pd
              WHERE pd.project_id = p.id)::int AS document_count
       FROM projects p
      WHERE p.user_id = $1
        ${includeArchived ? '' : 'AND p.is_archived = FALSE'}
      ORDER BY p.updated_at DESC`,
    [userId]
  );
  res.json({ items: rows });
}

// ── GET /api/projects/:id ─────────────────────────────────────
export async function getProject(req, res) {
  const userId = req.user.id;
  const { id } = req.params;

  const proj = await query(
    `SELECT * FROM projects WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  if (!proj.rows.length) return sendError(res, 404, 'ERR_NOT_FOUND');

  const [convs, docs] = await Promise.all([
    query(
      `SELECT id, title, source, summary, last_message_at, pinned, archived
         FROM conversations
        WHERE project_id = $1 AND user_id = $2
        ORDER BY pinned DESC, last_message_at DESC NULLS LAST
        LIMIT 200`,
      [id, userId]
    ),
    query(
      `SELECT d.id, d.name, d.type, d.size_bytes, d.status, d.created_at, pd.pinned_at
         FROM project_documents pd
         JOIN documents d ON d.id = pd.document_id
        WHERE pd.project_id = $1 AND d.user_id = $2
        ORDER BY pd.pinned_at DESC`,
      [id, userId]
    ),
  ]);

  res.json({ ...proj.rows[0], conversations: convs.rows, documents: docs.rows });
}

// ── POST /api/projects ────────────────────────────────────────
export async function createProject(req, res) {
  const userId = req.user.id;
  const { name, description, custom_instructions, color, icon } = req.body || {};
  if (!name || !name.trim()) return sendError(res, 400, 'ERR_FIELD_REQUIRED');

  const { rows } = await query(
    `INSERT INTO projects (user_id, name, description, custom_instructions, color, icon)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [userId, name.trim(), description || null, custom_instructions || null, color || 'indigo', icon || null]
  );
  res.status(201).json(rows[0]);
}

// ── PATCH /api/projects/:id ───────────────────────────────────
export async function updateProject(req, res) {
  const userId = req.user.id;
  const { id } = req.params;
  const sets = [];
  const params = [id, userId];
  let i = 3;
  const allow = ['name', 'description', 'custom_instructions', 'color', 'icon', 'is_archived'];
  for (const f of allow) {
    if (Object.hasOwn(req.body || {}, f)) {
      params.push(req.body[f]);
      sets.push(`${f} = $${i++}`);
    }
  }
  if (!sets.length) return sendError(res, 400, 'ERR_VALIDATION');
  sets.push('updated_at = NOW()');

  const { rows } = await query(
    `UPDATE projects SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING *`,
    params
  );
  if (!rows.length) return sendError(res, 404, 'ERR_NOT_FOUND');
  res.json(rows[0]);
}

// ── DELETE /api/projects/:id ──────────────────────────────────
export async function deleteProject(req, res) {
  const userId = req.user.id;
  const { rowCount } = await query(
    `DELETE FROM projects WHERE id = $1 AND user_id = $2`,
    [req.params.id, userId]
  );
  if (!rowCount) return sendError(res, 404, 'ERR_NOT_FOUND');
  res.json({ ok: true });
}

// ── POST /api/projects/:id/documents { document_id } ─────────
export async function pinDocument(req, res) {
  const userId = req.user.id;
  const { id } = req.params;
  const documentId = req.body?.document_id;
  if (!documentId) return sendError(res, 400, 'ERR_FIELD_REQUIRED');

  // Verify both belong to the user
  const check = await query(
    `SELECT 1 FROM projects WHERE id = $1 AND user_id = $2
      UNION ALL
     SELECT 1 FROM documents WHERE id = $3 AND user_id = $2`,
    [id, userId, documentId]
  );
  if (check.rowCount < 2) return sendError(res, 404, 'ERR_NOT_FOUND');

  await query(
    `INSERT INTO project_documents (project_id, document_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [id, documentId]
  );
  res.json({ ok: true });
}

// ── DELETE /api/projects/:id/documents/:doc_id ────────────────
export async function unpinDocument(req, res) {
  const userId = req.user.id;
  const { id, doc_id } = req.params;
  // ownership check
  const check = await query(
    `SELECT 1 FROM projects WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  if (!check.rowCount) return sendError(res, 404, 'ERR_NOT_FOUND');
  await query(
    `DELETE FROM project_documents WHERE project_id = $1 AND document_id = $2`,
    [id, doc_id]
  );
  res.json({ ok: true });
}
