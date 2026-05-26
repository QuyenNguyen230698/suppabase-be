import { Router } from 'express';
import { publicChat } from '../controllers/chatController.js';

const router = Router();
router.post('/', publicChat);
export default router;
