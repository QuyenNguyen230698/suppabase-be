import { Router } from 'express';
import { adminOnly } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  list, getConversation, stats, setFlag, clearFlag, filterOptions,
} from '../controllers/qaAuditController.js';
import {
  listQaAuditQuery, statsQuery, flagBody, messageIdParam, conversationIdParam,
} from '../schemas/qaAudit.js';

const router = Router();
router.use(adminOnly);

router.get('/',                  validate({ query: listQaAuditQuery }),    list);
router.get('/stats',              validate({ query: statsQuery }),          stats);
router.get('/filter-options',     filterOptions);
router.get('/conversation/:id',   validate({ params: conversationIdParam }), getConversation);
router.post('/:messageId/flag',   validate({ params: messageIdParam, body: flagBody }), setFlag);
router.delete('/:messageId/flag', validate({ params: messageIdParam }), clearFlag);

export default router;
