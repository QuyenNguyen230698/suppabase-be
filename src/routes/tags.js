import { Router } from 'express';
import {
  listTags,
  createTag,
  updateTag,
  deleteTag,
} from '../controllers/tagsController.js';

const router = Router();

router.get('/',       listTags);
router.post('/',      createTag);
router.patch('/:id',  updateTag);
router.delete('/:id', deleteTag);

export default router;
