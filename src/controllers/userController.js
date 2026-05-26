import bcrypt from 'bcrypt';
import { query } from '../db/index.js';

// ── GET /api/admin/users ──────────────────────────────────────
export async function listUsers(req, res) {
  const { node_id, role, search, page = 1, limit = 50 } = req.query;

  const safeLimit  = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const safePage   = Math.max(Number(page) || 1, 1);
  const offset     = (safePage - 1) * safeLimit;

  const params = [];
  const where  = [];

  const baseSql = `
    FROM users u
    LEFT JOIN user_node_roles unr ON unr.user_id = u.id
    LEFT JOIN org_nodes n ON n.id = unr.node_id
    LEFT JOIN roles r ON r.id = unr.role_id
  `;

  // Partial-access actors: restrict to users who belong to at least one allowed node
  if (req.actorAllowedNodes && req.actorAllowedNodes.size > 0) {
    const allowedIds = Array.from(req.actorAllowedNodes);
    params.push(allowedIds);
    where.push(`unr.node_id = ANY($${params.length})`);
  }

  if (node_id) { params.push(node_id);           where.push(`unr.node_id = $${params.length}`); }
  if (role)    { params.push(role);               where.push(`r.name = $${params.length}`); }
  if (search)  { params.push(`%${search}%`);      where.push(`(u.username ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.full_name ILIKE $${params.length} OR u.job_title ILIKE $${params.length} OR u.department ILIKE $${params.length})`); }

  const whereClause = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  // Count query (total rows trước khi phân trang)
  const countSql = `SELECT COUNT(DISTINCT u.id) AS total ${baseSql} ${whereClause}`;
  const { rows: countRows } = await query(countSql, params);
  const total = Number(countRows[0].total);

  // Data query
  const dataSql = `
    SELECT
      u.id, u.username, u.email, u.full_name, u.display_name,
      u.job_title, u.department, u.country_code, u.is_active,
      u.created_at,
      COALESCE(
        json_agg(
          json_build_object(
            'node_id',    unr.node_id,
            'node_label', n.label,
            'node_type',  n.type,
            'role',       r.name,
            'country',    unr.country
          ) ORDER BY n.depth, n.label
        ) FILTER (WHERE unr.id IS NOT NULL),
        '[]'
      ) AS assignments
    ${baseSql}
    ${whereClause}
    GROUP BY u.id
    ORDER BY u.created_at DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `;
  const { rows } = await query(dataSql, [...params, safeLimit, offset]);

  res.json({
    data:       rows,
    total,
    page:       safePage,
    limit:      safeLimit,
    totalPages: Math.ceil(total / safeLimit),
  });
}

// ── GET /api/admin/users/:id ──────────────────────────────────
export async function getUser(req, res) {
  const { id } = req.params;
  const { rows } = await query(
    `SELECT
       u.id, u.username, u.email, u.full_name, u.is_active, u.created_at,
       COALESCE(
         json_agg(
           json_build_object(
             'node_id',    unr.node_id,
             'node_label', n.label,
             'node_type',  n.type,
             'role',       r.name,
             'country',    unr.country,
             'granted_at', unr.granted_at
           ) ORDER BY n.depth, n.label
         ) FILTER (WHERE unr.id IS NOT NULL),
         '[]'
       ) AS assignments
     FROM users u
     LEFT JOIN user_node_roles unr ON unr.user_id = u.id
     LEFT JOIN org_nodes n ON n.id = unr.node_id
     LEFT JOIN roles r ON r.id = unr.role_id
     WHERE u.id = $1
     GROUP BY u.id`,
    [id]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
}

// ── POST /api/admin/users ─────────────────────────────────────
export async function createUser(req, res) {
  const { username, email, password, full_name } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'username, email, password are required' });
  }

  const existing = await query(
    'SELECT id FROM users WHERE username = $1 OR email = $2',
    [username, email]
  );
  if (existing.rows.length) {
    return res.status(409).json({ error: 'Username or email already exists' });
  }

  const password_hash = await bcrypt.hash(password, 10);
  const { rows } = await query(
    `INSERT INTO users (username, email, password_hash, full_name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, username, email, full_name, is_active, created_at`,
    [username, email, password_hash, full_name || null]
  );
  res.status(201).json(rows[0]);
}

// ── PATCH /api/admin/users/:id ────────────────────────────────
export async function updateUser(req, res) {
  const { id } = req.params;
  const {
    full_name, display_name, email, is_active, password,
    job_title, department, country_code, phone, language, timezone,
  } = req.body;
  const sets = [];
  const params = [id];

  const addField = (val, col) => { if (val !== undefined) { params.push(val); sets.push(`${col} = $${params.length}`); } };

  addField(full_name,    'full_name');
  addField(display_name, 'display_name');
  addField(email,        'email');
  addField(is_active,    'is_active');
  addField(job_title,    'job_title');
  addField(department,   'department');
  addField(country_code, 'country_code');
  addField(phone,        'phone');
  addField(language,     'language');
  addField(timezone,     'timezone');

  if (password) {
    const hash = await bcrypt.hash(password, 10);
    params.push(hash);
    sets.push(`password_hash = $${params.length}`);
    params.push(new Date());
    sets.push(`password_changed_at = $${params.length}`);
  }

  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  sets.push(`updated_at = NOW()`);

  const { rows } = await query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $1
     RETURNING id, username, email, full_name, display_name,
               job_title, department, country_code, phone, language,
               is_active, password_changed_at, updated_at`,
    params
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
}

// ── DELETE /api/admin/users/:id ───────────────────────────────
export async function deleteUser(req, res) {
  const { id } = req.params;
  // Prevent deleting own account
  if (req.user?.id === id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  const { rowCount } = await query('DELETE FROM users WHERE id = $1', [id]);
  if (!rowCount) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
}
