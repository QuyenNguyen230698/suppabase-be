import { Router } from 'express';
import multer from 'multer';
import { pebChat, listPebConversations, getPebConversation, deletePebConversation } from '../controllers/pebController.js';
import { moduleGuard } from '../middleware/requireModulePermission.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (_, file, cb) => {
    cb(null, file.mimetype.startsWith('image/'));
  },
});

const guard = moduleGuard('pro_plan');

const router = Router();
router.post('/', guard, upload.single('image'), pebChat);
router.get('/conversations', guard, listPebConversations);
router.get('/conversations/:id', guard, getPebConversation);
router.delete('/conversations/:id', guard, deletePebConversation);
export default router;
