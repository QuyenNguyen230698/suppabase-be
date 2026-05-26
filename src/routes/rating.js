import { Router } from 'express';
import { adminOnly } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  rateMessage, clearRating, agentQuality, agentDetail,
} from '../controllers/ratingController.js';
import {
  rateBody, messageIdParam, idParam, daysQuery,
} from '../schemas/rating.js';
import { editUserMessage, regenerateAssistantMessage } from '../controllers/messageOpsController.js';

// User-facing rating endpoints (authenticated)
export const userRouter = Router();
userRouter.post('/:messageId/rating',
  validate({ params: messageIdParam, body: rateBody }), rateMessage);
userRouter.delete('/:messageId/rating',
  validate({ params: messageIdParam }), clearRating);

// Edit a user message (branches the conversation) / regenerate an assistant
// reply (soft-deletes it). Both rewrite history; client then POSTs /api/chat
// with the new message list to stream a fresh reply.
userRouter.patch('/:id', editUserMessage);
userRouter.post('/:id/regenerate', regenerateAssistantMessage);

// Admin quality dashboard
export const adminRouter = Router();
adminRouter.use(adminOnly);
adminRouter.get('/agents',
  validate({ query: daysQuery }), agentQuality);
adminRouter.get('/agents/:id',
  validate({ params: idParam, query: daysQuery }), agentDetail);
