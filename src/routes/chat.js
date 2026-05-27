import { Router } from 'express';
import {
  sendMessage,
  streamJob,
  listConversations,
  getConversation,
  deleteConversation,
  getQueueStats,
} from '../controllers/chatController.js';
import { moduleGuard } from '../middleware/requireModulePermission.js';
import { validate } from './../middleware/validate.js';
import { chatSendBody } from '../schemas/chat.js';

const guard = moduleGuard('chat');

const router = Router();
router.post('/', guard, validate({ body: chatSendBody }), sendMessage);
router.get('/stream/:jobId', guard, streamJob);
router.get('/queue/stats', guard, getQueueStats);
router.get('/conversations', guard, listConversations);
router.get('/conversations/:id', guard, getConversation);
router.delete('/conversations/:id', guard, deleteConversation);
export default router;
