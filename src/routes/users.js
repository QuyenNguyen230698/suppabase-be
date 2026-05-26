import { Router } from 'express';
import { adminOnly, superAdminOnly, requireFreshPermissions } from '../middleware/auth.js';
import { requireModulePermissionScope } from '../middleware/scopeCheck.js';
import { listUsers, getUser, createUser, updateUser, deleteUser } from '../controllers/userController.js';

const router = Router();

// GET / — accessible to any user with permissions.view (full or partial).
// Partial-access actors receive only users within their scoped nodes (filtering in controller).
router.get('/', requireModulePermissionScope('permissions', 'view'), listUsers);

// All other user management endpoints remain admin-only.
router.use(adminOnly);

router.get('/:id',    getUser);
// Write paths additionally require a fresh permissions snapshot — protects against
// an admin whose privileges were revoked mid-session from continuing to mutate users.
router.post('/',      superAdminOnly, requireFreshPermissions, createUser);
router.patch('/:id',  requireFreshPermissions, updateUser);
router.delete('/:id', superAdminOnly, requireFreshPermissions, deleteUser);

export default router;
