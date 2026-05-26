import { Router } from 'express';
import { uploadMiddleware, validateFileSize, verifyFileMagic, handleUploadError } from '../middleware/upload.js';
import { uploadFile } from '../controllers/uploadController.js';
import { moduleGuard } from '../middleware/requireModulePermission.js';

const guard = moduleGuard('documents');

const router = Router();

// guard trước multer: multer chưa parse body nên Content-Type header vẫn còn nguyên để inferAction đọc
router.post('/', guard, (req, res, next) => {
  uploadMiddleware(req, res, (err) => {
    if (err) return handleUploadError(err, req, res, next);
    next();
  });
}, validateFileSize, verifyFileMagic, uploadFile);

export default router;
