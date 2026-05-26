import { query } from '../db/index.js';
import { sendError } from '../i18n/messages.js';

// Lightweight in-process cache for effective permissions per (userId, version).
// Invalidated automatically when users.permission_version changes.
const cache = new Map(); // key: `${userId}:${version}` → { perms, expires }
const CACHE_TTL_MS = 15_000;

const RANK = { full: 2, partial: 1, none: 0 };

let _matrixCache = null;
let _matrixCacheAt = 0;
const MATRIX_TTL_MS = 30 * 1000;

async function getRoleMatrixDefaults() {
  const now = Date.now();
  if (_matrixCache && now - _matrixCacheAt < MATRIX_TTL_MS) return _matrixCache;
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
  for (const o of overrides) {
    if (!activeRoles.has(o.role_name)) continue;
    matrix[o.role_name][o.module_id] ??= {};
    matrix[o.role_name][o.module_id][o.action] = o.state;
  }
  _matrixCache = matrix;
  _matrixCacheAt = now;
  return matrix;
}

export async function getEffectivePermissionsForUser(userId, jwtRole) {
  // Read version to scope cache key
  const { rows: vRows } = await query(
    'SELECT permission_version FROM users WHERE id = $1',
    [userId]
  );
  const version = vRows[0]?.permission_version ?? 1;
  const key = `${userId}:${version}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.perms;

  const defaults = await getRoleMatrixDefaults();
  const { rows: assignments } = await query(
    `SELECT unr.node_id, r.name AS role
     FROM user_node_roles unr
     JOIN roles r ON r.id = unr.role_id
     WHERE unr.user_id = $1 AND r.is_active = TRUE`,
    [userId]
  );

  let perms;
  if (!assignments.length) {
    perms = defaults[jwtRole] ?? {};
  } else {
    const nodeIds = assignments.map(a => a.node_id);
    const { rows: overrides } = await query(
      `SELECT node_id, module_id, action, state
       FROM node_permission_overrides
       WHERE node_id = ANY($1)`,
      [nodeIds]
    );
    const byNode = {};
    for (const o of overrides) {
      byNode[o.node_id] ??= {};
      byNode[o.node_id][o.module_id] ??= {};
      byNode[o.node_id][o.module_id][o.action] = o.state;
    }
    perms = {};
    for (const a of assignments) {
      const base = defaults[a.role] ?? {};
      for (const [mod, acts] of Object.entries(base)) {
        perms[mod] ??= {};
        for (const [act, st] of Object.entries(acts)) {
          const ov = byNode[a.node_id]?.[mod]?.[act];
          const resolved = ov ?? st;
          const cur = perms[mod][act] ?? 'none';
          if (RANK[resolved] > RANK[cur]) perms[mod][act] = resolved;
        }
      }
      // Also surface any override-only modules (no default entry)
      const ovMods = byNode[a.node_id] ?? {};
      for (const [mod, acts] of Object.entries(ovMods)) {
        perms[mod] ??= {};
        for (const [act, st] of Object.entries(acts)) {
          const cur = perms[mod][act] ?? 'none';
          if (RANK[st] > RANK[cur]) perms[mod][act] = st;
        }
      }
    }
  }

  cache.set(key, { perms, expires: now + CACHE_TTL_MS });
  return perms;
}

/**
 * Middleware: enforce that the current user has the given action on the module.
 * Super admin (level 1) is implicitly granted in practice via the role matrix
 * defaults, so no explicit bypass here — matrix already covers it.
 *
 *   router.use(requireModulePermission('api_tokens', 'view'))
 */
export function requireModulePermission(moduleId, action = 'view') {
  return async (req, res, next) => {
    const userId = req.user?.id;
    if (!userId) return sendError(res, 401, 'ERR_AUTH_REQUIRED');
    try {
      const perms = await getEffectivePermissionsForUser(userId, req.user.role);
      const state = perms?.[moduleId]?.[action];
      if (state === 'full' || state === 'partial') return next();
      return sendError(res, 403, 'ERR_PERMISSION_DENIED');
    } catch (err) {
      console.error('[requireModulePermission] error:', err);
      return sendError(res, 500, 'ERR_INTERNAL');
    }
  };
}

/**
 * Suy ra action từ HTTP method + Content-Type:
 *   GET / HEAD            → 'view'
 *   DELETE                → 'delete'
 *   POST/PUT multipart    → 'upload'
 *   POST/PUT/PATCH json   → 'create'
 *
 * Nếu module chưa có row 'upload' trong matrix (undefined), tự động
 * fallback sang 'create' để tránh false-positive 403 khi module mới
 * chưa được admin cấu hình upload riêng.
 *
 *   router.post('/', moduleGuard('pro_plan'), controller)
 */
export function moduleGuard(moduleId) {
  return async (req, res, next) => {
    const userId = req.user?.id;
    if (!userId) return sendError(res, 401, 'ERR_AUTH_REQUIRED');
    try {
      const perms = await getEffectivePermissionsForUser(userId, req.user.role);
      const action = inferAction(req, perms, moduleId);
      const state = perms?.[moduleId]?.[action];
      if (state === 'full' || state === 'partial') return next();
      return sendError(res, 403, 'ERR_PERMISSION_DENIED');
    } catch (err) {
      console.error('[moduleGuard] error:', err);
      return sendError(res, 500, 'ERR_INTERNAL');
    }
  };
}

function inferAction(req, perms, moduleId) {
  const m = req.method;
  if (m === 'GET' || m === 'HEAD') return 'view';
  if (m === 'DELETE') return 'delete';
  // POST / PUT / PATCH
  const ct = req.headers['content-type'] || '';
  if (ct.startsWith('multipart/form-data')) {
    // Fallback sang 'create' nếu module chưa khai báo 'upload' trong matrix
    if (perms?.[moduleId]?.upload === undefined) return 'create';
    return 'upload';
  }
  return 'create';
}
