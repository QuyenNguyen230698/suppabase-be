import { z } from 'zod';
import { isAllowedChatModel } from '../services/modelRegistry.js';

const SLUG_RE = /^[a-z0-9-]{2,64}$/;
const ICON_VALUES = ['sparkles', 'file-text', 'pen-tool', 'code', 'bot'];
// 'pro' = the Pro Plan / PEB agent category (gated behind pro_plan permission).
const CATEGORIES  = ['general', 'document', 'writing', 'coding', 'pro'];
const VISIBILITY  = ['global', 'org', 'private'];
const SEVERITIES  = ['soft', 'block_regex', 'block_llm'];
const TOOLS       = ['search_documents', 'get_current_time', 'calculator'];
// FE pseudo-model that routes a chat to the PEB ('pro') source. Allowed as an
// agent's pinned model even though it isn't a real Cloudflare chat model.
const PEB_MODEL_VALUE = '__peb__';

// Reject invalid regex patterns at validation time (before they hit DB)
const safeRegex = z.string().min(1).refine((p) => {
  try { new RegExp(p); return true; } catch { return false; }
}, { message: 'Invalid regex pattern' });

const RuleSchema = z.object({
  id:       z.string().max(40).optional(),
  text:     z.string().min(1).max(500),
  severity: z.enum(SEVERITIES).default('soft'),
});

const PatternSchema = z.object({
  pattern: safeRegex.max(500),
  flags:   z.string().regex(/^[gimsuy]*$/, 'flags can only contain g/i/m/s/u/y').max(8).optional().default('iu'),
  message: z.string().max(300).optional(),
});

// Common base — applied to both create + update
const baseFields = {
  name:              z.string().min(1).max(120).optional(),
  slug:              z.string().regex(SLUG_RE, 'slug must be 2-64 lowercase/digit/dash chars').optional(),
  description:       z.string().max(1000).nullable().optional(),
  icon:              z.enum(ICON_VALUES).optional(),
  category:          z.enum(CATEGORIES).optional(),
  system_prompt:     z.string().min(1).max(20000).optional(),
  rules:             z.array(RuleSchema).max(50).optional(),
  block_patterns:    z.array(PatternSchema).max(30).optional(),
  block_llm_check:   z.boolean().optional(),
  fallback_response: z.string().max(2000).nullable().optional(),
  locale:            z.enum(['vi', 'en']).optional(),
  temperature:       z.coerce.number().min(0).max(2).optional(),
  max_tokens:        z.coerce.number().int().min(1).max(32000).optional(),
  is_active:         z.boolean().optional(),
  visibility:        z.enum(VISIBILITY).optional(),
  org_node_id:       z.string().uuid().nullable().optional(),
  allowed_tools:     z.array(z.enum(TOOLS)).max(10).optional(),
  // Optional locked model. null/'' = let the user choose. A non-empty value
  // must be in the chat allow-list (modelRegistry), so an agent can't pin a
  // removed/unsupported model.
  model: z.string().max(200).nullable().optional()
    .refine((m) => !m || m === PEB_MODEL_VALUE || isAllowedChatModel(m),
      { message: 'model must be an allowed chat model, __peb__, or null' }),
};

export const createAgentTemplateBody = z.object({
  ...baseFields,
  name:          z.string().min(1).max(120),       // required for create
  system_prompt: z.string().min(1).max(20000),     // required for create
}).strict();

export const updateAgentTemplateBody = z.object(baseFields).strict();

export const listAgentTemplatesQuery = z.object({
  category:         z.enum(CATEGORIES).optional(),
  include_inactive: z.enum(['0', '1']).optional(),
}).strict();

export const idParam = z.object({
  id: z.string().uuid('id must be a UUID'),
}).strict();
