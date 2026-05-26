import { Router } from 'express';
import {
  listConversations,
  updateConversation,
  shareConversation,
  revokeShare,
  searchConversations,
  searchMessages,
} from '../controllers/conversationsController.js';
import { attachTag, detachTag } from '../controllers/tagsController.js';

const router = Router();

// Unified list (across sources, with filters)
router.get('/conversations', listConversations);

// Per-conversation operations
router.patch('/conversations/:id',           updateConversation);
router.post('/conversations/:id/share',      shareConversation);
router.delete('/conversations/:id/share',    revokeShare);
router.post('/conversations/:id/tags',       attachTag);
router.delete('/conversations/:id/tags/:tag_id', detachTag);

// Search
router.get('/search/conversations', searchConversations);
router.get('/search/messages',      searchMessages);

export default router;
