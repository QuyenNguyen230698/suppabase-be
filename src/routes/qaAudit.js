import { Router } from 'express';
import { adminOnly, superAdminOnly } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  list, getConversation, stats, setFlag, clearFlag, filterOptions,
  bulkFlag, bulkUnflag, exportList, accessLog,
} from '../controllers/qaAuditController.js';
import {
  listQaAuditQuery, statsQuery, flagBody, messageIdParam, conversationIdParam,
  exportQaAuditQuery, bulkFlagBody, bulkUnflagBody, accessLogQuery,
} from '../schemas/qaAudit.js';

const router = Router();
router.use(adminOnly);

router.get('/',                  validate({ query: listQaAuditQuery }),    list);
router.get('/stats',              validate({ query: statsQuery }),          stats);
router.get('/filter-options',     filterOptions);
router.get('/export',             validate({ query: exportQaAuditQuery }),  exportList);
router.get('/conversation/:id',   validate({ params: conversationIdParam }), getConversation);
router.post('/bulk-flag',         validate({ body: bulkFlagBody }),         bulkFlag);
router.post('/bulk-unflag',       validate({ body: bulkUnflagBody }),       bulkUnflag);
router.post('/:messageId/flag',   validate({ params: messageIdParam, body: flagBody }), setFlag);
router.delete('/:messageId/flag', validate({ params: messageIdParam }), clearFlag);

// Access-log viewer — super_admin only (it exposes who revealed PII).
router.get('/access-log', superAdminOnly, validate({ query: accessLogQuery }), accessLog);

export default router;
