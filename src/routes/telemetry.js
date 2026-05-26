import { Router } from 'express';
import { adminOnly } from '../middleware/auth.js';
import { getSummary, getJobsStatus, triggerJob } from '../controllers/telemetryController.js';

const router = Router();
router.use(adminOnly);

router.get('/summary',          getSummary);
router.get('/jobs',             getJobsStatus);
router.post('/jobs/:name/run',  triggerJob);

export default router;
