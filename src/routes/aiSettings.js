import { Router } from 'express';
import { superAdminOnly } from '../middleware/auth.js';
import {
  getSettings,
  patchSettings,
  clearOverride,
  getHealthEndpoint,
  getAudit,
} from '../controllers/aiSettingsController.js';

const router = Router();
router.use(superAdminOnly);

router.get('/', getSettings);
router.patch('/', patchSettings);
router.delete('/override', clearOverride);
router.get('/health', getHealthEndpoint);
router.get('/audit', getAudit);

export default router;
