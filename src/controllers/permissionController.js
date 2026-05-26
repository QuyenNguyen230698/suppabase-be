import { query } from '../db/index.js';
import pool from '../db/index.js';
import { assertNodeInScope, assertNoRoleEscalation } from '../middleware/scopeCheck.js';

// ── Helpers ───────────────────────────────────────────────────

// Load active module IDs from DB (falls back to hardcoded if DB unavailable)
async function getModuleIds() {
  const { rows } = await query(
    'SELECT id FROM modules WHERE is_active = TRUE ORDER BY sort_order'
  );
  return rows.map(r => r.id);
}

const ACTIONS  = ['view', 'create', 'delete', 'upload'];

// Lazy in-memory cache cho role matrix defaults (DB-driven).
// Invalidate khi update qua updateRoleMatrix (write path).
let _matrixCache = null;
let _matrixCacheAt = 0;
const MATRIX_TTL_MS = 30 * 1000; // 30s — đủ ngắn để không stale lâu, đủ dài cho request burst

function invalidateMatrixCache() {
  _matrixCache = null;
  _matrixCacheAt = 0;
}

// Trả về matrix mặc định { [role]: { [module]: { [action]: state } } }
// Đọc role_matrix_defaults + roles (filter is_active).
async function getRoleMatrixDefaults() {
  const now = Date.now();
  if (_matrixCache && now - _matrixCacheAt < MATRIX_TTL_MS) return _matrixCache;

  // role_matrix_defaults = seeded baseline, role_matrix_overrides = admin edits.
  // Overrides win — they reflect the latest UI state of the matrix page.
  const [{ rows: defaults }, { rows: overrides }, { rows: roles }] = await Promise.all([
    query('SELECT role_name, module_id, action, state FROM role_matrix_defaults'),
    query('SELECT role_id AS role_name, module_id, action, state FROM role_matrix_overrides'),
    query("SELECT name FROM roles WHERE is_active = TRUE"),
  ]);

  const activeRoles = new Set(roles.map(r => r.name));
  const matrix = {};
  for (const r of activeRoles) matrix[r] = {};
  for (const d of defaults) {
    if (!activeRoles.has(d.role_name)) continue;
    matrix[d.role_name][d.module_id] ??= {};
    matrix[d.role_name][d.module_id][d.action] = d.state;
  }
  // Apply overrides on top
  for (const o of overrides) {
    if (!activeRoles.has(o.role_name)) continue;
    matrix[o.role_name][o.module_id] ??= {};
    matrix[o.role_name][o.module_id][o.action] = o.state;
  }
  _matrixCache = matrix;
  _matrixCacheAt = now;
  return matrix;
}

// Trả về list active role names (cached)
async function getActiveRoles() {
  const matrix = await getRoleMatrixDefaults();
  return Object.keys(matrix);
}

// ── Permission version bumping ────────────────────────────────
// Mỗi khi quyền của user thay đổi (assignment / role-matrix / node-override),
// tăng users.permission_version. FE so sánh với version trong JWT → re-fetch.

async function bumpVersionForUser(userId) {
  await query(
    'UPDATE users SET permission_version = permission_version + 1 WHERE id = $1',
    [userId]
  );
}

async function bumpVersionForRole(roleName) {
  // Bump every user whose effective role is this one — covers both
  // (a) users with a user_node_roles assignment for the role, and
  // (b) users whose JWT default role matches but have no node assignment yet.
  await query(
    `UPDATE users SET permission_version = permission_version + 1
     WHERE id IN (
       SELECT DISTINCT unr.user_id
       FROM user_node_roles unr
       JOIN roles r ON r.id = unr.role_id
       WHERE r.name = $1
     )`,
    [roleName]
  );
  // Note: cannot bump users whose JWT role = $1 without an assignment because
  // role is stored only in JWT; the FE's permission_version check re-fetches
  // on next nav, and we just invalidated the in-memory matrix cache below so
  // any /me request returns fresh data immediately.
  invalidateMatrixCache();
}

async function bumpVersionForNode(nodeId) {
  // Bump tất cả user có assignment ở node này (override ảnh hưởng đến họ)
  await query(
    `UPDATE users SET permission_version = permission_version + 1
     WHERE id IN (SELECT DISTINCT user_id FROM user_node_roles WHERE node_id = $1)`,
    [nodeId]
  );
}

// ── Audit log helper ──────────────────────────────────────────
// Best-effort; lỗi audit không được làm fail request chính.
async function audit(req, entry) {
  try {
    await query(
      `INSERT INTO permission_audit_log
         (actor_id, action_type, target_type, target_id, module_id, action_name, before_state, after_state, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        req.user?.id ?? null,
        entry.action_type,
        entry.target_type ?? null,
        entry.target_id  != null ? String(entry.target_id) : null,
        entry.module_id  ?? null,
        entry.action_name ?? null,
        entry.before ? JSON.stringify(entry.before) : null,
        entry.after  ? JSON.stringify(entry.after)  : null,
        JSON.stringify({
          ip: req.ip,
          ua: req.headers['user-agent']?.slice(0, 200),
          ...(entry.meta ?? {}),
        }),
      ]
    );
  } catch (err) {
    console.warn('[AUDIT] failed:', err.message);
  }
}

// ── GET /api/admin/permissions/matrix ────────────────────────
// Returns merged matrix: DB defaults + role-level overrides, for active modules only
export async function getRoleMatrix(req, res) {
  const [moduleIds, defaults, { rows: overrideRows }] = await Promise.all([
    getModuleIds(),
    getRoleMatrixDefaults(),
    query('SELECT role_id, module_id, action, state FROM role_matrix_overrides'),
  ]);

  const merged = {};
  for (const role of Object.keys(defaults)) {
    merged[role] = {};
    for (const mod of moduleIds) {
      merged[role][mod] = {};
      for (const action of ACTIONS) {
        merged[role][mod][action] = defaults[role]?.[mod]?.[action] ?? 'none';
      }
    }
  }
  for (const o of overrideRows) {
    if (!merged[o.role_id]?.[o.module_id]) continue;
    merged[o.role_id][o.module_id][o.action] = o.state;
  }

  res.json(merged);
}

// ── PUT /api/admin/permissions/matrix ────────────────────────
// Upsert a role-level matrix override (role, module, action) → state
export async function updateRoleMatrix(req, res) {
  const { role_id, module_id, action, state } = req.body;

  if (!role_id || !module_id || !action || !state) {
    return res.status(400).json({ error: 'role_id, module_id, action, state are required' });
  }
  const activeRoles = await getActiveRoles();
  if (!activeRoles.includes(role_id))       return res.status(400).json({ error: 'Invalid role_id' });
  if (!ACTIONS.includes(action))            return res.status(400).json({ error: 'Invalid action' });
  if (!['full','partial','none'].includes(state)) return res.status(400).json({ error: 'state must be full|partial|none' });

  const moduleIds = await getModuleIds();
  if (!moduleIds.includes(module_id)) return res.status(400).json({ error: 'Invalid module_id' });

  // Đọc state cũ để audit
  const { rows: prev } = await query(
    'SELECT state FROM role_matrix_overrides WHERE role_id=$1 AND module_id=$2 AND action=$3',
    [role_id, module_id, action]
  );
  const before = prev[0]?.state ?? null;

  const { rows } = await query(
    `INSERT INTO role_matrix_overrides (role_id, module_id, action, state, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (role_id, module_id, action)
     DO UPDATE SET state = EXCLUDED.state, updated_by = EXCLUDED.updated_by, updated_at = NOW()
     RETURNING *`,
    [role_id, module_id, action, state, req.user?.id ?? null]
  );

  // Bump permission version cho tất cả user thuộc role này (qua user_node_roles → roles.name)
  await bumpVersionForRole(role_id);
  await audit(req, {
    action_type: 'set_role_matrix',
    target_type: 'role',
    target_id: role_id,
    module_id, action_name: action,
    before: before ? { state: before } : null,
    after:  { state },
  });

  res.json(rows[0]);
}

// ── GET /api/admin/permissions/nodes/:nodeId ──────────────────
// Returns resolved permissions for a node (defaults + overrides)
export async function getNodePermissions(req, res) {
  const { nodeId } = req.params;
  if (!assertNodeInScope(req, res, nodeId)) return;

  const { rows: nodeRows } = await query(
    'SELECT id, label, type FROM org_nodes WHERE id = $1', [nodeId]
  );
  if (!nodeRows.length) return res.status(404).json({ error: 'Node not found' });

  const { rows: overrides } = await query(
    'SELECT module_id, action, state FROM node_permission_overrides WHERE node_id = $1',
    [nodeId]
  );

  // Build resolved matrix from DB defaults + node overrides
  const overrideMap = {};
  for (const o of overrides) {
    if (!overrideMap[o.module_id]) overrideMap[o.module_id] = {};
    overrideMap[o.module_id][o.action] = o.state;
  }

  const [moduleIds, defaults] = await Promise.all([getModuleIds(), getRoleMatrixDefaults()]);
  const resolved = {};
  for (const role of Object.keys(defaults)) {
    resolved[role] = {};
    for (const mod of moduleIds) {
      resolved[role][mod] = {};
      for (const action of ACTIONS) {
        const override = overrideMap[mod]?.[action];
        const def = defaults[role]?.[mod]?.[action] ?? 'none';
        resolved[role][mod][action] = override ?? def;
      }
    }
  }

  res.json({
    node: nodeRows[0],
    overrides: overrideMap,
    resolved,
  });
}

// ── PUT /api/admin/permissions/nodes/:nodeId ──────────────────
// Upsert an override for (node, module, action)
export async function setNodePermission(req, res) {
  const { nodeId } = req.params;
  if (!assertNodeInScope(req, res, nodeId)) return;
  const { module_id, action, state } = req.body;

  if (!module_id || !action || !state) {
    return res.status(400).json({ error: 'module_id, action, state are required' });
  }
  if (!ACTIONS.includes(action))    return res.status(400).json({ error: 'Invalid action' });
  if (!['full','partial','none'].includes(state)) return res.status(400).json({ error: 'state must be full|partial|none' });

  const moduleIds = await getModuleIds();
  if (!moduleIds.includes(module_id)) return res.status(400).json({ error: 'Invalid module_id' });

  const { rows: prev } = await query(
    'SELECT state FROM node_permission_overrides WHERE node_id=$1 AND module_id=$2 AND action=$3',
    [nodeId, module_id, action]
  );
  const before = prev[0]?.state ?? null;

  const { rows } = await query(
    `INSERT INTO node_permission_overrides (node_id, module_id, action, state, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (node_id, module_id, action)
     DO UPDATE SET state = EXCLUDED.state, updated_by = EXCLUDED.updated_by, updated_at = NOW()
     RETURNING *`,
    [nodeId, module_id, action, state, req.user?.id ?? null]
  );
  await bumpVersionForNode(nodeId);
  await audit(req, {
    action_type: 'set_node_override',
    target_type: 'node',
    target_id: nodeId,
    module_id, action_name: action,
    before: before ? { state: before } : null,
    after:  { state },
  });
  res.json(rows[0]);
}

// ── DELETE /api/admin/permissions/nodes/:nodeId/override ──────
// Remove an override (revert to role default)
export async function deleteNodePermission(req, res) {
  const { nodeId } = req.params;
  if (!assertNodeInScope(req, res, nodeId)) return;
  const { module_id, action } = req.query;

  if (!module_id || !action) {
    return res.status(400).json({ error: 'module_id and action are required' });
  }
  const { rows: prev } = await query(
    'SELECT state FROM node_permission_overrides WHERE node_id=$1 AND module_id=$2 AND action=$3',
    [nodeId, module_id, action]
  );
  await query(
    `DELETE FROM node_permission_overrides
     WHERE node_id = $1 AND module_id = $2 AND action = $3`,
    [nodeId, module_id, action]
  );
  await bumpVersionForNode(nodeId);
  await audit(req, {
    action_type: 'delete_node_override',
    target_type: 'node',
    target_id: nodeId,
    module_id, action_name: action,
    before: prev[0] ? { state: prev[0].state } : null,
    after: null,
  });
  res.json({ ok: true });
}

// ── GET /api/admin/permissions/users/:userId ─────────────────
// Returns the effective (resolved) permission set for a specific user
// across ALL their node assignments
export async function getUserPermissions(req, res) {
  const { userId } = req.params;

  // Partial-access actors: target user must belong to at least one node in actor's scope
  if (!req.actorIsFullAccess) {
    const { rows: targetNodes } = await query(
      'SELECT node_id FROM user_node_roles WHERE user_id = $1',
      [userId]
    );
    const inScope = targetNodes.some(r => req.actorAllowedNodes?.has(r.node_id));
    if (!inScope) {
      return res.status(403).json({ error: 'Forbidden', code: 'ERR_SCOPE_DENIED' });
    }
  }

  // All node roles for this user
  const { rows: assignments } = await query(
    `SELECT unr.node_id, r.name AS role, unr.country, n.label, n.type, n.depth
     FROM user_node_roles unr
     JOIN org_nodes n ON n.id = unr.node_id
     JOIN roles r ON r.id = unr.role_id
     WHERE unr.user_id = $1
     ORDER BY n.depth`,
    [userId]
  );

  if (!assignments.length) return res.json({ assignments: [], permissions: {} });

  // Load all overrides for nodes this user belongs to
  const nodeIds = assignments.map(a => a.node_id);
  const { rows: overrides } = await query(
    `SELECT node_id, module_id, action, state
     FROM node_permission_overrides
     WHERE node_id = ANY($1)`,
    [nodeIds]
  );

  const overrideByNode = {};
  for (const o of overrides) {
    if (!overrideByNode[o.node_id]) overrideByNode[o.node_id] = {};
    if (!overrideByNode[o.node_id][o.module_id]) overrideByNode[o.node_id][o.module_id] = {};
    overrideByNode[o.node_id][o.module_id][o.action] = o.state;
  }

  // Merge: highest privilege wins across all assignments (full > partial > none)
  const RANK = { full: 2, partial: 1, none: 0 };
  const [moduleIds, defaults] = await Promise.all([getModuleIds(), getRoleMatrixDefaults()]);
  const merged = {};
  for (const mod of moduleIds) {
    merged[mod] = {};
    for (const action of ACTIONS) {
      let best = 'none';
      for (const a of assignments) {
        const override = overrideByNode[a.node_id]?.[mod]?.[action];
        const def      = defaults[a.role]?.[mod]?.[action] ?? 'none';
        const resolved = override ?? def;
        if (RANK[resolved] > RANK[best]) best = resolved;
      }
      merged[mod][action] = best;
    }
  }

  res.json({ assignments, permissions: merged });
}

// ── POST /api/admin/permissions/assign ───────────────────────
// Assign (or update) a user's role at a node
export async function assignUserRole(req, res) {
  const { user_id, node_id, role, country } = req.body;

  if (!user_id || !node_id || !role) {
    return res.status(400).json({ error: 'user_id, node_id, role are required' });
  }

  // Scope check: partial-access actor can only assign within their allowed nodes
  if (!assertNodeInScope(req, res, node_id)) return;

  // Verify user, node, and role (active) exist
  const [uRes, nRes, rRes] = await Promise.all([
    query('SELECT id FROM users WHERE id = $1', [user_id]),
    query('SELECT id FROM org_nodes WHERE id = $1', [node_id]),
    query('SELECT id, level FROM roles WHERE name = $1 AND is_active = TRUE', [role]),
  ]);
  if (!uRes.rows.length) return res.status(404).json({ error: 'User not found' });
  if (!nRes.rows.length) return res.status(404).json({ error: 'Node not found' });
  if (!rRes.rows.length) return res.status(404).json({ error: 'Role not found or inactive' });

  // Escalation check: partial-access actor cannot assign a role higher than their own
  if (!assertNoRoleEscalation(req, res, rRes.rows[0].level)) return;

  const role_id = rRes.rows[0].id;

  // Snapshot trước thay đổi
  const { rows: prev } = await query(
    `SELECT r.name AS role, unr.country FROM user_node_roles unr
       JOIN roles r ON r.id = unr.role_id
      WHERE unr.user_id=$1 AND unr.node_id=$2`,
    [user_id, node_id]
  );

  const { rows } = await query(
    `INSERT INTO user_node_roles (user_id, node_id, role_id, country, granted_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, node_id)
     DO UPDATE SET role_id    = EXCLUDED.role_id,
                   country    = EXCLUDED.country,
                   granted_by = EXCLUDED.granted_by,
                   granted_at = NOW()
     RETURNING *`,
    [user_id, node_id, role_id, country || null, req.user?.id ?? null]
  );
  await bumpVersionForUser(user_id);
  await audit(req, {
    action_type: 'assign_user',
    target_type: 'user',
    target_id: user_id,
    before: prev[0] ?? null,
    after:  { role, node_id, country: country || null },
  });
  res.status(201).json(rows[0]);
}

// ── GET /api/admin/permissions/audit ─────────────────────────
// Paginated audit log với filter cơ bản.
//   ?limit=50&offset=0&target_type=user&target_id=<uuid>&action_type=assign_user
export async function listAudit(req, res) {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = parseInt(req.query.offset, 10) || 0;
  const filters = [];
  const params = [];
  let idx = 1;

  for (const f of ['target_type', 'target_id', 'action_type', 'module_id']) {
    if (req.query[f]) {
      filters.push(`${f} = $${idx++}`);
      params.push(req.query[f]);
    }
  }
  if (req.query.actor_id) {
    filters.push(`actor_id = $${idx++}`);
    params.push(req.query.actor_id);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  params.push(limit, offset);
  const { rows } = await query(
    `SELECT a.*, u.username AS actor_username, u.display_name AS actor_display_name
       FROM permission_audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
       ${where}
       ORDER BY a.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
    params
  );
  res.json({ items: rows, limit, offset });
}

// ── GET /api/admin/permissions/roles ─────────────────────────
// Active role list — FE dùng cho permission matrix UI.
export async function listRoles(req, res) {
  const { rows } = await query(
    `SELECT id, name, display_name, description, level, is_system, is_active
     FROM roles
     WHERE is_active = TRUE
     ORDER BY level ASC, name ASC`
  );
  res.json(rows);
}

// ── GET /api/admin/permissions/me ────────────────────────────
// Returns the effective permission set for the currently authenticated user.
// Falls back to role_matrix_defaults (DB) when the user has no node assignments
// (e.g. legacy super_admin accounts created before the org tree existed).
export async function getMyPermissions(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  // Đọc permission_version hiện tại
  const { rows: vRows } = await query(
    'SELECT permission_version FROM users WHERE id = $1',
    [userId]
  );
  const currentVersion = vRows[0]?.permission_version ?? 1;

  const { rows: assignments } = await query(
    `SELECT unr.node_id, r.name AS role, r.level AS role_level, unr.country, n.label, n.type, n.depth
     FROM user_node_roles unr
     JOIN org_nodes n ON n.id = unr.node_id
     JOIN roles r ON r.id = unr.role_id
     WHERE unr.user_id = $1 AND r.is_active = TRUE
     ORDER BY n.depth`,
    [userId]
  );

  const [moduleIds, defaults] = await Promise.all([getModuleIds(), getRoleMatrixDefaults()]);
  const RANK = { full: 2, partial: 1, none: 0 };

  // Helper: drop modules where every action is 'none'.
  // Keeps the response lean and avoids leaking module IDs the user cannot use.
  const stripDenied = (perms) => {
    const out = {};
    for (const [mod, acts] of Object.entries(perms)) {
      if (Object.values(acts).some(s => s === 'full' || s === 'partial')) {
        out[mod] = acts;
      }
    }
    return out;
  };

  // No org assignments — fallback dùng role từ JWT
  if (!assignments.length) {
    const role = req.user?.role;
    const roleDefaults = defaults[role] ?? {};
    const permissions = {};
    for (const mod of moduleIds) {
      permissions[mod] = {};
      for (const action of ACTIONS) {
        permissions[mod][action] = roleDefaults[mod]?.[action] ?? 'none';
      }
    }
    const filtered = stripDenied(permissions);
    return res.json({
      role,
      assignments: [],
      permissions: filtered,
      allowed_modules: Object.keys(filtered),
      permission_version: currentVersion,
    });
  }

  // Load all node overrides for this user's nodes
  const nodeIds = assignments.map(a => a.node_id);
  const { rows: overrides } = await query(
    `SELECT node_id, module_id, action, state
     FROM node_permission_overrides
     WHERE node_id = ANY($1)`,
    [nodeIds]
  );

  const overrideByNode = {};
  for (const o of overrides) {
    if (!overrideByNode[o.node_id]) overrideByNode[o.node_id] = {};
    if (!overrideByNode[o.node_id][o.module_id]) overrideByNode[o.node_id][o.module_id] = {};
    overrideByNode[o.node_id][o.module_id][o.action] = o.state;
  }

  // Merge: highest privilege wins across all assignments
  const permissions = {};
  for (const mod of moduleIds) {
    permissions[mod] = {};
    for (const action of ACTIONS) {
      let best = 'none';
      for (const a of assignments) {
        const override = overrideByNode[a.node_id]?.[mod]?.[action];
        const def      = defaults[a.role]?.[mod]?.[action] ?? 'none';
        const resolved = override ?? def;
        if (RANK[resolved] > RANK[best]) best = resolved;
      }
      permissions[mod][action] = best;
    }
  }

  // Top role = role có level nhỏ nhất (roles.level: 1 = cao nhất)
  const topRole = assignments.reduce(
    (best, a) => (best === null || a.role_level < best.role_level) ? a : best,
    null
  )?.role;

  const filtered = stripDenied(permissions);
  res.json({
    role: topRole,
    assignments,
    permissions: filtered,
    allowed_modules: Object.keys(filtered),
    permission_version: currentVersion,
  });
}

// ── DELETE /api/admin/permissions/assign ─────────────────────
// Remove a user from a node
export async function removeUserRole(req, res) {
  const { user_id, node_id } = req.query;
  if (!user_id || !node_id) {
    return res.status(400).json({ error: 'user_id and node_id are required' });
  }
  if (!assertNodeInScope(req, res, node_id)) return;
  const { rows: prev } = await query(
    `SELECT r.name AS role, unr.country FROM user_node_roles unr
       JOIN roles r ON r.id = unr.role_id
      WHERE unr.user_id=$1 AND unr.node_id=$2`,
    [user_id, node_id]
  );
  const { rowCount } = await query(
    'DELETE FROM user_node_roles WHERE user_id=$1 AND node_id=$2',
    [user_id, node_id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Assignment not found' });
  await bumpVersionForUser(user_id);
  await audit(req, {
    action_type: 'remove_user',
    target_type: 'user',
    target_id: user_id,
    before: { node_id, ...prev[0] },
    after: null,
  });
  res.json({ ok: true });
}

// ══════════════════════════════════════════════════════════════
// MODULE CRUD
// ══════════════════════════════════════════════════════════════

// ── GET /api/admin/permissions/modules ───────────────────────
// By default returns only modules the current user can `view`.
// Admins (level ≤ 2) get the full active list. With ?all=true the
// caller must be admin and gets every module including inactive.
export async function listModules(req, res) {
  const includeInactive = req.query.all === 'true';
  const role = req.user?.role;

  // Resolve role level from JWT role (uses same cache as auth middleware)
  const { rows: roleRows } = await query(
    'SELECT level FROM roles WHERE name = $1 AND is_active = TRUE',
    [role]
  );
  const level = roleRows[0]?.level ?? 99;
  const isAdmin = level <= 2;

  // Non-admins cannot request inactive modules
  if (includeInactive && !isAdmin) {
    return res.status(403).json({ error: 'Forbidden', code: 'ERR_ADMIN_REQUIRED' });
  }

  const { rows } = await query(
    `SELECT id, name, abbr, color, route, icon, description, is_active, admin_only, sort_order, created_at, updated_at
     FROM modules
     ${includeInactive ? '' : 'WHERE is_active = TRUE'}
     ORDER BY sort_order, id`
  );

  // Admins (or ?all=true) see everything
  if (isAdmin) return res.json(rows);

  // Non-admin: filter by effective view permission
  const userId = req.user?.id;
  const { rows: assignments } = await query(
    `SELECT unr.node_id, r.name AS role
     FROM user_node_roles unr
     JOIN roles r ON r.id = unr.role_id
     WHERE unr.user_id = $1 AND r.is_active = TRUE`,
    [userId]
  );

  const defaults = await getRoleMatrixDefaults();
  const RANK = { full: 2, partial: 1, none: 0 };

  let viewableModuleIds;
  if (!assignments.length) {
    const roleDefaults = defaults[role] ?? {};
    viewableModuleIds = new Set(
      Object.entries(roleDefaults)
        .filter(([, acts]) => acts.view === 'full' || acts.view === 'partial')
        .map(([mod]) => mod)
    );
  } else {
    const nodeIds = assignments.map(a => a.node_id);
    const { rows: overrides } = await query(
      `SELECT node_id, module_id, action, state
       FROM node_permission_overrides
       WHERE node_id = ANY($1) AND action = 'view'`,
      [nodeIds]
    );
    const overrideByNode = {};
    for (const o of overrides) {
      overrideByNode[o.node_id] ??= {};
      overrideByNode[o.node_id][o.module_id] = o.state;
    }
    viewableModuleIds = new Set();
    for (const m of rows) {
      let best = 'none';
      for (const a of assignments) {
        const ov  = overrideByNode[a.node_id]?.[m.id];
        const def = defaults[a.role]?.[m.id]?.view ?? 'none';
        const resolved = ov ?? def;
        if (RANK[resolved] > RANK[best]) best = resolved;
      }
      if (best === 'full' || best === 'partial') viewableModuleIds.add(m.id);
    }
  }

  // Always strip admin_only modules from non-admin response
  res.json(rows.filter(m => !m.admin_only && viewableModuleIds.has(m.id)));
}

// ── POST /api/admin/permissions/modules ──────────────────────
export async function createModule(req, res) {
  const { id, name, abbr, color, route, icon, description, sort_order, admin_only } = req.body;

  if (!id || !name || !abbr) {
    return res.status(400).json({ error: 'id, name, abbr are required' });
  }
  if (!/^[a-z0-9_]{1,50}$/.test(id)) {
    return res.status(400).json({ error: 'id must be lowercase alphanumeric/underscore, max 50 chars' });
  }
  if (abbr.length > 4) {
    return res.status(400).json({ error: 'abbr max 4 characters' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO modules (id, name, abbr, color, route, icon, description, sort_order, created_by, admin_only)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [id, name, abbr, color || 'gray', route || null, icon || null, description || null,
       sort_order ?? 99, req.user?.id ?? null, admin_only ?? false]
    );

    // Auto-seed 'none' cho mọi active role × 4 actions — admin vào Matrix UI để cấp quyền sau
    if (!rows[0].admin_only) {
      await client.query(
        `INSERT INTO role_matrix_defaults (role_name, module_id, action, state)
         SELECT r.name, $1, a.action, 'none'
         FROM roles r
         CROSS JOIN (VALUES ('view'),('create'),('delete'),('upload')) AS a(action)
         WHERE r.is_active = TRUE
         ON CONFLICT (role_name, module_id, action) DO NOTHING`,
        [id]
      );
    }

    await client.query('COMMIT');
    invalidateMatrixCache();

    await audit(req, {
      action_type: 'create_module',
      target_type: 'module',
      target_id: id,
      before: null,
      after: rows[0],
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── PUT /api/admin/permissions/modules/:id ───────────────────
export async function updateModule(req, res) {
  const { id } = req.params;
  const { name, abbr, color, route, icon, description, is_active, sort_order } = req.body;

  const { rows: existing } = await query('SELECT * FROM modules WHERE id = $1', [id]);
  if (!existing.length) return res.status(404).json({ error: 'Module not found' });

  if (abbr && abbr.length > 4) {
    return res.status(400).json({ error: 'abbr max 4 characters' });
  }

  const { rows } = await query(
    `UPDATE modules SET
       name        = COALESCE($1, name),
       abbr        = COALESCE($2, abbr),
       color       = COALESCE($3, color),
       route       = COALESCE($4, route),
       icon        = COALESCE($5, icon),
       description = COALESCE($6, description),
       is_active   = COALESCE($7, is_active),
       sort_order  = COALESCE($8, sort_order),
       updated_at  = NOW()
     WHERE id = $9
     RETURNING *`,
    [name ?? null, abbr ?? null, color ?? null, route ?? null, icon ?? null,
     description ?? null, is_active ?? null, sort_order ?? null, id]
  );
  // is_active toggle ảnh hưởng matrix — invalidate để guard đọc lại ngay
  if (is_active !== undefined && is_active !== existing[0].is_active) {
    invalidateMatrixCache();
  }
  await audit(req, {
    action_type: 'update_module',
    target_type: 'module',
    target_id: id,
    before: existing[0],
    after: rows[0],
  });
  res.json(rows[0]);
}

// ── DELETE /api/admin/permissions/modules/:id ────────────────
// Cascade: role_matrix_overrides + node_permission_overrides FK sẽ tự xóa
export async function deleteModule(req, res) {
  const { id } = req.params;

  const { rows: existing } = await query('SELECT * FROM modules WHERE id = $1', [id]);
  if (!existing.length) return res.status(404).json({ error: 'Module not found' });

  await query('DELETE FROM modules WHERE id = $1', [id]);
  invalidateMatrixCache();
  await audit(req, {
    action_type: 'delete_module',
    target_type: 'module',
    target_id: id,
    before: existing[0],
    after: null,
  });
  res.json({ ok: true });
}
