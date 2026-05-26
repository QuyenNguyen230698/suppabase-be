import { Router } from 'express';
import { authMiddleware, adminOnly } from '../middleware/auth.js';
import { getAiUsage, getAiUsageLog } from '../controllers/aiUsageController.js';
import { getStats, clear } from '../services/semanticCache.js';
import { getStats as getBreakerStats, reset as resetBreaker } from '../services/circuitBreaker.js';

const router = Router();
router.use(authMiddleware);
router.get('/', getAiUsage);
router.get('/log/:log_id', getAiUsageLog);

// Semantic cache stats (admin)
router.get('/cache/stats', adminOnly, (req, res) => res.json(getStats()));
router.post('/cache/clear', adminOnly, (req, res) => { clear(); res.json({ ok: true }); });

// Circuit breaker stats + manual reset
router.get('/breaker/stats', adminOnly, (req, res) => res.json(getBreakerStats()));
router.post('/breaker/reset', adminOnly, (req, res) => {
  const name = req.body?.name || null;
  const ok = resetBreaker(name);
  res.json({ ok, name: name || 'all' });
});

export default router;
