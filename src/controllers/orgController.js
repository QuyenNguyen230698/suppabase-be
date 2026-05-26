import { query } from '../db/index.js';

// ── GET /api/admin/org/nodes ──────────────────────────────────
// Returns full tree with user counts.
// Partial-access actors (req.actorAllowedNodes set) get only their scoped nodes.
export async function listNodes(req, res) {
  const { rows } = await query(`
    SELECT
      n.id, n.parent_id, n.label, n.sub, n.type, n.depth,
      n.path, n.sort_order, n.created_at,
      COUNT(unr.id)::int AS user_count
    FROM org_nodes n
    LEFT JOIN user_node_roles unr ON unr.node_id = n.id
    GROUP BY n.id
    ORDER BY n.depth, n.sort_order, n.label
  `);

  // Full-access actors see everything
  if (!req.actorAllowedNodes) return res.json(rows);

  // Partial-access: filter to actor's allowed nodes
  const allowed = req.actorAllowedNodes;
  res.json(rows.filter(n => allowed.has(n.id)));
}

// ── GET /api/admin/org/nodes/:id ─────────────────────────────
export async function getNode(req, res) {
  const { id } = req.params;
  const [nodeRes, usersRes] = await Promise.all([
    query(
      `SELECT n.*, COUNT(unr.id)::int AS user_count
       FROM org_nodes n
       LEFT JOIN user_node_roles unr ON unr.node_id = n.id
       WHERE n.id = $1 GROUP BY n.id`,
      [id]
    ),
    query(
      `SELECT u.id, u.username, u.email, u.full_name, u.is_active,
              r.name AS role, unr.country, unr.granted_at
       FROM user_node_roles unr
       JOIN users u ON u.id = unr.user_id
       JOIN roles r ON r.id = unr.role_id
       WHERE unr.node_id = $1
       ORDER BY r.level, u.full_name`,
      [id]
    ),
  ]);

  if (!nodeRes.rows.length) return res.status(404).json({ error: 'Node not found' });
  res.json({ ...nodeRes.rows[0], users: usersRes.rows });
}

// ── POST /api/admin/org/nodes ────────────────────────────────
export async function createNode(req, res) {
  const { parent_id, label, sub, type, sort_order = 0 } = req.body;
  if (!label || !type) return res.status(400).json({ error: 'label and type are required' });

  // Compute depth & path from parent
  let depth = 0;
  let path = label;
  if (parent_id) {
    const { rows } = await query('SELECT depth, path FROM org_nodes WHERE id = $1', [parent_id]);
    if (!rows.length) return res.status(404).json({ error: 'Parent node not found' });
    depth = rows[0].depth + 1;
    path = `${rows[0].path} > ${label}`;
  }

  const { rows } = await query(
    `INSERT INTO org_nodes (parent_id, label, sub, type, depth, path, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [parent_id || null, label, sub || null, type, depth, path, sort_order]
  );
  res.status(201).json(rows[0]);
}

// ── PATCH /api/admin/org/nodes/:id ───────────────────────────
export async function updateNode(req, res) {
  const { id } = req.params;
  const { label, sub, sort_order } = req.body;
  const sets = ['updated_at = NOW()'];
  const params = [id];

  if (label      !== undefined) { params.push(label);      sets.push(`label = $${params.length}`); }
  if (sub        !== undefined) { params.push(sub);        sets.push(`sub = $${params.length}`); }
  if (sort_order !== undefined) { params.push(sort_order); sets.push(`sort_order = $${params.length}`); }

  const { rows } = await query(
    `UPDATE org_nodes SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    params
  );
  if (!rows.length) return res.status(404).json({ error: 'Node not found' });
  res.json(rows[0]);
}

// ── DELETE /api/admin/org/nodes/:id ──────────────────────────
export async function deleteNode(req, res) {
  const { id } = req.params;

  // Block if has children
  const { rows: children } = await query(
    'SELECT id FROM org_nodes WHERE parent_id = $1 LIMIT 1', [id]
  );
  if (children.length) {
    return res.status(409).json({ error: 'Cannot delete node with children' });
  }

  const { rowCount } = await query('DELETE FROM org_nodes WHERE id = $1', [id]);
  if (!rowCount) return res.status(404).json({ error: 'Node not found' });
  res.json({ ok: true });
}
