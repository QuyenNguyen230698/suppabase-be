import { Router } from 'express';
import { adminOnly } from '../middleware/auth.js';
import { requireModulePermissionScope, assertNodeInScope } from '../middleware/scopeCheck.js';
import { listNodes, getNode, createNode, updateNode, deleteNode } from '../controllers/orgController.js';

const router = Router();

const scopeView = requireModulePermissionScope('permissions', 'view');

// GET / — accessible to any user with permissions.view (full or partial).
// Partial-access actors receive only their scoped nodes (filtering done in controller).
router.get('/', scopeView, listNodes);

// GET /:id — same scope gate; partial-access actors can only fetch nodes within their scope.
router.get('/:id', scopeView, (req, res, next) => {
  if (!assertNodeInScope(req, res, req.params.id)) return;
  next();
}, getNode);

// All org-tree mutation endpoints remain admin-only (Super / Regional Admin).
router.use(adminOnly);

router.post('/',      createNode);
router.patch('/:id',  updateNode);
router.delete('/:id', deleteNode);

export default router;
