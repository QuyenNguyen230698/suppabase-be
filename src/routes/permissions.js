import { Router } from 'express';
import { adminOnly, superAdminOnly, requireFreshPermissions } from '../middleware/auth.js';
import { requireModulePermissionScope } from '../middleware/scopeCheck.js';
import {
  getRoleMatrix,
  updateRoleMatrix,
  getNodePermissions,
  setNodePermission,
  deleteNodePermission,
  getUserPermissions,
  getMyPermissions,
  listRoles,
  listAudit,
  assignUserRole,
  removeUserRole,
  listModules,
  createModule,
  updateModule,
  deleteModule,
} from '../controllers/permissionController.js';

const router = Router();

// Short-cache helper — relies on Express's strong ETag for revalidation.
function cacheable(maxAgeSeconds) {
  return (req, res, next) => {
    res.set('Cache-Control', `private, max-age=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds * 2}`);
    next();
  };
}

// Accessible by any authenticated user — returns own permissions
// No HTTP cache: response is per-user and must reflect latest matrix/overrides
// immediately. ETag (set by Express by default) still allows conditional GET.
router.get('/me', getMyPermissions);

// Modules list — any authenticated user can read (needed for FE guard + composables)
// No HTTP cache: visibility is per-user and admin matrix edits must take effect now.
router.get('/modules', listModules);

// Roles list — any authenticated user can read (UI dùng level để xác định 'admin')
router.get('/roles', cacheable(120), listRoles);

// ── Scope-gated: requires permissions.view (full or partial).
// Full-access (admin) roles bypass scope checks entirely.
// Partial-access roles (bu_manager, country_user) get req.actorAllowedNodes populated
// and individual handlers enforce data-boundary checks.
const scopeView   = requireModulePermissionScope('permissions', 'view');
const scopeCreate = requireModulePermissionScope('permissions', 'create');
const scopeDelete = requireModulePermissionScope('permissions', 'delete');

// Node-level permission reads & overrides
router.get('/nodes/:nodeId',             scopeView,   getNodePermissions);
router.put('/nodes/:nodeId',             scopeCreate, requireFreshPermissions, setNodePermission);
router.delete('/nodes/:nodeId/override', scopeDelete, requireFreshPermissions, deleteNodePermission);

// User effective permissions
router.get('/users/:userId', scopeView, getUserPermissions);

// Assign / remove user ↔ node — scope + escalation checks live inside the handlers
router.post('/assign',   scopeCreate, requireFreshPermissions, assignUserRole);
router.delete('/assign', scopeDelete, requireFreshPermissions, removeUserRole);

// ── Admin-only below this line ────────────────────────────────
router.use(adminOnly);

// Role default matrix — structural change, full admins only
router.get('/matrix',  getRoleMatrix);
router.put('/matrix',  requireFreshPermissions, updateRoleMatrix);

// Audit log
router.get('/audit', listAudit);

// Module CRUD — super_admin only (changes affect entire permission model)
router.post('/modules',       superAdminOnly, requireFreshPermissions, createModule);
router.put('/modules/:id',    superAdminOnly, requireFreshPermissions, updateModule);
router.delete('/modules/:id', superAdminOnly, requireFreshPermissions, deleteModule);

export default router;
