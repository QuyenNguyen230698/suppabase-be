import { Router } from 'express';
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  pinDocument,
  unpinDocument,
} from '../controllers/projectsController.js';
import { moduleGuard } from '../middleware/requireModulePermission.js';

const guard = moduleGuard('projects');

const router = Router();

router.get('/',         guard, listProjects);
router.post('/',        guard, createProject);
router.get('/:id',      guard, getProject);
router.patch('/:id',    guard, updateProject);
router.delete('/:id',   guard, deleteProject);

router.post('/:id/documents',           guard, pinDocument);
router.delete('/:id/documents/:doc_id', guard, unpinDocument);

export default router;
