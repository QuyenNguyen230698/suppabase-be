import { Router } from 'express';
import multer from 'multer';
import {
  getMe, updateMe, changePassword,
  uploadAvatar, deleteAvatar,
  getMyTeam, setPreferredModel,
} from '../controllers/meController.js';
import {
  listMyMemories, createMyMemory, deleteMyMemory, purgeMyMemories,
} from '../controllers/memoriesController.js';

const router = Router();

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024 }, // 512KB raw upload cap; controller enforces stricter 256KB
  fileFilter: (_, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

router.get('/',                getMe);
router.patch('/',              updateMe);
router.post('/password',       changePassword);
router.post('/avatar',         avatarUpload.single('avatar'), uploadAvatar);
router.delete('/avatar',       deleteAvatar);
router.get('/team',            getMyTeam);
router.patch('/preferred-model', setPreferredModel);

// Memories
router.get('/memories',         listMyMemories);
router.post('/memories',        createMyMemory);
router.delete('/memories/:id',  deleteMyMemory);
router.delete('/memories',      purgeMyMemories);

export default router;
