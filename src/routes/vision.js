import { Router } from 'express';
import multer from 'multer';
import { analyzeImage } from '../controllers/visionController.js';

const IMAGE_MIMETYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (IMAGE_MIMETYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed (jpg, png, gif, webp, bmp)'));
    }
  },
}).single('image');

const router = Router();

router.post('/', (req, res, next) => {
  upload(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.message });
    }
    if (err) return res.status(400).json({ error: err.message });
    // image is optional — proceed regardless
    next();
  });
}, analyzeImage);

export default router;
