import { Router } from 'express';
import { adminOnly } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  list, getOne, create, update, remove, setDefault,
} from '../controllers/agentTemplatesController.js';
import {
  createAgentTemplateBody, updateAgentTemplateBody,
  listAgentTemplatesQuery, idParam,
} from '../schemas/agentTemplates.js';

const publicRouter = Router();
publicRouter.get('/',     validate({ query: listAgentTemplatesQuery }), list);
publicRouter.get('/:id',  validate({ params: idParam }), getOne);

const adminRouter = Router();
adminRouter.use(adminOnly);
adminRouter.get('/',                  validate({ query: listAgentTemplatesQuery }), list);
adminRouter.get('/:id',               validate({ params: idParam }), getOne);
adminRouter.post('/',                 validate({ body: createAgentTemplateBody }), create);
adminRouter.patch('/:id',             validate({ params: idParam, body: updateAgentTemplateBody }), update);
adminRouter.delete('/:id',            validate({ params: idParam }), remove);
adminRouter.post('/:id/set-default',  validate({ params: idParam }), setDefault);

export { publicRouter, adminRouter };
