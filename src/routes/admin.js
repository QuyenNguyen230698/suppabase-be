import { Router } from 'express';
import { adminOnly } from '../middleware/auth.js';
import { listTokens, createToken, revokeToken, deleteToken, getTokenCurl } from '../controllers/adminController.js';

const router = Router();
router.use(adminOnly);
// Mounted at /api/admin/tokens — internal paths are relative.
router.get('/', listTokens);
router.post('/', createToken);
router.delete('/:id', revokeToken);
router.delete('/:id/permanent', deleteToken);
router.get('/:id/curl', getTokenCurl);
export default router;
