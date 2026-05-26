import { query } from '../db/index.js';
import { sendError } from '../i18n/messages.js';
import { getEffectivePermissionsForUser } from './requireModulePermission.js';

// Role level threshold: level ≤ FULL_ACCESS_LEVEL bypass scope checks entirely
// (super_admin = 1, regional_admin = 2 → both get full access as per matrix)
const FULL_ACCESS_LEVEL = 2;

// Cache role.name → role.level (shared TTL with auth.js, but scoped here)
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

/**
 * Returns the set of node IDs the actor is directly assigned to, plus all
 * descendant nodes (recursive via parent_id).  Used to gate write/read
 * operations for roles with 'partial' permission scope.
 *
 * BU Manager → their BU node + all children (fab, country sub-nodes, …)
 * Country User → their node only (leaf nodes have no children in practice)
 */
export async function getActorAllowedNodeIds(userId) {
  // Get nodes the actor is directly assigned to
  const { rows: assignments } = await query(
    `SELECT DISTINCT unr.node_id
     FROM user_node_roles unr
     WHERE unr.user_id = $1`,
    [userId]
  );
  if (!assignments.length) return new Set();

  const rootIds = assignments.map(a => a.node_id);

  // Recursive CTE: root nodes + all descendants
  const { rows: allNodes } = await query(
    `WITH RECURSIVE subtree AS (
       SELECT id FROM org_nodes WHERE id = ANY($1)
       UNION ALL
       SELECT n.id FROM org_nodes n
       JOIN subtree s ON n.parent_id = s.id
     )
     SELECT id FROM subtree`,
    [rootIds]
  );

  return new Set(allNodes.map(r => r.id));
}

/**
 * Middleware factory: verify that the actor has 'partial' or better on the
 * given module/action, then attach scope info to req for downstream use.
 *
 * Attaches to req:
 *   req.actorIsFullAccess  — boolean: true if level ≤ FULL_ACCESS_LEVEL (skip all scope checks)
 *   req.actorAllowedNodes  — Set<nodeId> of nodes actor can act upon (null when full access)
 *   req.actorRoleLevel     — numeric level of actor's role
 *
 * Usage:
 *   router.post('/assign', requireModulePermissionScope('permissions', 'create'), handler)
 */
export function requireModulePermissionScope(moduleId, action = 'view') {
  return async (req, res, next) => {
    const userId = req.user?.id;
    const roleName = req.user?.role;
    if (!userId || !roleName) return sendError(res, 401, 'ERR_AUTH_REQUIRED');

    try {
      const actorLevel = await getRoleLevel(roleName);
      req.actorRoleLevel = actorLevel;

      // Full-access roles bypass scope — attach flag and continue
      if (actorLevel <= FULL_ACCESS_LEVEL) {
        req.actorIsFullAccess = true;
        req.actorAllowedNodes = null;
        return next();
      }

      // Partial-access roles: check matrix permission first
      const perms = await getEffectivePermissionsForUser(userId, roleName);
      const state = perms?.[moduleId]?.[action];
      if (state !== 'full' && state !== 'partial') {
        return sendError(res, 403, 'ERR_PERMISSION_DENIED');
      }

      // Load allowed nodes for scope checks in downstream handlers
      req.actorIsFullAccess = false;
      req.actorAllowedNodes = await getActorAllowedNodeIds(userId);
      return next();
    } catch (err) {
      console.error('[scopeCheck] error:', err);
      return sendError(res, 500, 'ERR_INTERNAL');
    }
  };
}

/**
 * Assert that a given nodeId is within the actor's allowed scope.
 * Throws a 403 response if not.  Call from inside route handlers after
 * requireModulePermissionScope has populated req.actorAllowedNodes.
 *
 * Returns true if allowed (so callers can short-circuit with early return).
 */
export function assertNodeInScope(req, res, nodeId) {
  if (req.actorIsFullAccess) return true;
  if (!req.actorAllowedNodes?.has(nodeId)) {
    sendError(res, 403, 'ERR_SCOPE_DENIED');
    return false;
  }
  return true;
}

/**
 * Assert that the role being assigned doesn't exceed the actor's own level.
 * Prevents privilege escalation universally — applies to ALL actors including
 * full-access ones (e.g. Regional Admin level 2 cannot assign super_admin level 1).
 *
 * super_admin (level 1) is the only role that can assign other super_admins,
 * because no actor can have a level lower than 1.
 *
 * targetRoleLevel: numeric level of the role being assigned to the target user.
 */
export function assertNoRoleEscalation(req, res, targetRoleLevel) {
  // Actor can only assign roles at the same level or lower privilege (higher number)
  if (targetRoleLevel < req.actorRoleLevel) {
    sendError(res, 403, 'ERR_ROLE_ESCALATION');
    return false;
  }
  return true;
}
