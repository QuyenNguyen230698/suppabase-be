import { Router } from 'express';
import { listDocuments, getDocument, getDocumentContent, getDocumentRaw, deleteDocument } from '../controllers/documentController.js';
import { moduleGuard } from '../middleware/requireModulePermission.js';

const guard = moduleGuard('documents');

const router = Router();
router.get('/', guard, listDocuments);
router.get('/:id/content', guard, getDocumentContent);
router.get('/:id/raw', guard, getDocumentRaw);
router.get('/:id', guard, getDocument);
router.delete('/:id', guard, deleteDocument);
export default router;
