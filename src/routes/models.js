import { Router } from 'express';

const DEFAULT_MODEL = process.env.DEFAULT_MODEL || '';
const ALLOWED_MODELS = (process.env.ALLOWED_MODELS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Context window per Cloudflare Workers AI model (tokens). Values from the
// model catalog at developers.cloudflare.com/workers-ai/models. Update when
// adding new models to ALLOWED_MODELS.
const CONTEXT_WINDOW = {
  '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b': 80000,
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast':      24000,
  '@cf/meta/llama-4-scout-17b-16e-instruct':      131000,
  '@cf/qwen/qwq-32b':                              32000,
  '@cf/qwen/qwen2.5-coder-32b-instruct':           32000,
  '@cf/mistral/mistral-small-3.1-24b-instruct':   128000,
  '@cf/meta/llama-3.2-11b-vision-instruct':       128000,
};

const router = Router();

function buildModelList() {
  return ALLOWED_MODELS.map((name) => ({
    name,
    provider: 'cloudflare',
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
