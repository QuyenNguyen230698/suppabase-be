import jwt from 'jsonwebtoken';
import { query } from '../db/index.js';
import { sendError } from '../i18n/messages.js';

const JWT_SECRET = process.env.JWT_SECRET;

// Admin threshold: role có level ≤ ADMIN_LEVEL_MAX được coi là admin.
// Theo seed 003_roles.sql: super_admin=1, regional_admin=2 → admin.
const ADMIN_LEVEL_MAX = 2;
const SUPER_ADMIN_LEVEL = 1;

// Cache role.name → role.level để tránh query mỗi request
const roleLevelCache = new Map();
let roleLevelCacheAt = 0;
const ROLE_LEVEL_TTL_MS = 60 * 1000;

async function getRoleLevel(roleName) {
  const now = Date.now();
  if (now - roleLevelCacheAt > ROLE_LEVEL_TTL_MS) {
    roleLevelCache.clear();
    roleLevelCacheAt = now;
  }
  if (roleLevelCache.has(roleName)) return roleLevelCache.get(roleName);

  const { rows } = await query(
    'SELECT level FROM roles WHERE name = $1 AND is_active = TRUE',
    [roleName]
  );
  const level = rows[0]?.level ?? 99;
  roleLevelCache.set(roleName, level);
  return level;
}

// Small in-memory cache of revoked jtis. Pruned every minute. Hit on this
// cache short-circuits the DB lookup; misses fall through to a DB check so
// freshly-revoked tokens are caught across processes (still racy by up to
// REVOKED_CACHE_TTL_MS — acceptable given the 1h access TTL).
const revokedCache = new Map();
const REVOKED_CACHE_TTL_MS = 60 * 1000;

async function isJtiRevoked(jti) {
  if (!jti) return false;
  const cached = revokedCache.get(jti);
  if (cached && cached > Date.now()) return true;
  const { rows } = await query(
    `SELECT 1 FROM revoked_access_tokens WHERE jti = $1 AND expires_at > NOW() LIMIT 1`,
    [jti],
  );
  if (rows.length) {
    revokedCache.set(jti, Date.now() + REVOKED_CACHE_TTL_MS);
    return true;
  }
  return false;
}

export async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return sendError(res, 401, 'ERR_TOKEN_MISSING');
  const token = header.slice(7);
  if (!token || token === 'null') return sendError(res, 401, 'ERR_TOKEN_MISSING');

  if (!JWT_SECRET) {
    console.error('[AUTH] JWT_SECRET is not configured');
    return res.status(500).json({ error: 'Server misconfiguration', code: 'ERR_INTERNAL' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    if (payload.jti && await isJtiRevoked(payload.jti)) {
      return sendError(res, 401, 'ERR_TOKEN_INVALID');
    }
    req.user = payload;
    return next();
  } catch (err) {
    console.warn(`[AUTH] [${req.id}] JWT verify failed for ${req.method} ${req.path}: ${err.message}`);
    return sendError(res, 401, 'ERR_TOKEN_INVALID');
  }
}

// Optional middleware: kiểm tra JWT.pv == users.permission_version.
// Áp dụng cho endpoints "sensitive" mà ta muốn force re-login khi quyền thay đổi.
// Endpoint thông thường vẫn dùng authMiddleware không-strict (chỉ verify signature).
export async function requireFreshPermissions(req, res, next) {
  const userId = req.user?.id;
  const tokenPv = req.user?.pv ?? 1;
  if (!userId) return sendError(res, 401, 'ERR_AUTH_REQUIRED');

  const { rows } = await query('SELECT permission_version FROM users WHERE id = $1', [userId]);
  const currentPv = rows[0]?.permission_version ?? 1;
  if (tokenPv !== currentPv) return sendError(res, 401, 'ERR_STALE_PERMISSIONS');
  next();
}

export async function adminOnly(req, res, next) {
  const role = req.user?.role;
  if (!role) return sendError(res, 403, 'ERR_ADMIN_REQUIRED');
  const level = await getRoleLevel(role);
  if (level > ADMIN_LEVEL_MAX) return sendError(res, 403, 'ERR_ADMIN_REQUIRED');
  next();
}

export async function superAdminOnly(req, res, next) {
  const role = req.user?.role;
  if (!role) return sendError(res, 403, 'ERR_SUPER_ADMIN_REQUIRED');
  const level = await getRoleLevel(role);
  if (level > SUPER_ADMIN_LEVEL) return sendError(res, 403, 'ERR_SUPER_ADMIN_REQUIRED');
  next();
}
