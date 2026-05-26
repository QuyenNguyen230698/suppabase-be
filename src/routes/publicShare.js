import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { getSharedConversation } from '../controllers/conversationsController.js';

const router = Router();

// Throttle public share lookups to discourage scraping.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests', code: 'ERR_RATE_LIMIT' },
});

router.get('/share/:token', limiter, getSharedConversation);

export default router;
