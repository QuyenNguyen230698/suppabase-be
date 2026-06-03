import { Router } from 'express';
import { CONTEXT_WINDOW, MODELS } from '../services/modelRegistry.js';

const DEFAULT_MODEL = process.env.DEFAULT_MODEL || MODELS.chatDefault;
const ALLOWED_MODELS = (process.env.ALLOWED_MODELS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const router = Router();

// Coarse role tag from the model name so the FE can badge it ('Code' /
// 'Reasoning'). Purely cosmetic — capability gating isn't needed because vision
// is handled out-of-band by the scout model regardless of the chat model.
function roleOf(name) {
  if (name.includes('coder') || name.includes('code')) return 'code';
  if (name.includes('deepseek-r1') || name.includes('qwq')) return 'reasoning';
  return 'general';
}

function buildModelList() {
  return ALLOWED_MODELS.map((name) => ({
    name,
    provider: 'cloudflare',
    role: roleOf(name),
    thinking: name.includes('deepseek-r1') || name.includes('qwq'),
    context_length: CONTEXT_WINDOW[name] || 4096,
    default: DEFAULT_MODEL ? name === DEFAULT_MODEL : false,
  }));
}

router.get('/', (req, res) => {
  res.set('Cache-Control', 'private, max-age=60');
  res.json(buildModelList());
});

export default router;
