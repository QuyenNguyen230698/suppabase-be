import { z } from 'zod';

// Chat body has many legacy fields — we use a permissive schema (passthrough)
// and only enforce shape on the fields we own.

// Per-message: 32KB (~8k tokens). Total prompt: 256KB across all messages.
// Anything bigger should go through document upload + RAG, not raw prompt.
const PER_MESSAGE_MAX = 32 * 1024;
const TOTAL_PROMPT_MAX = 256 * 1024;

const ChatMessage = z.object({
  role:    z.enum(['user', 'assistant', 'system']),
  content: z.string().max(PER_MESSAGE_MAX, `content exceeds ${PER_MESSAGE_MAX} chars`),
  images:  z.array(z.string()).max(8).optional(),
}).passthrough();

export const chatSendBody = z.object({
  messages: z.array(ChatMessage).min(1).max(100).refine(
    (msgs) => msgs.reduce((n, m) => n + (m.content?.length || 0), 0) <= TOTAL_PROMPT_MAX,
    { message: `total prompt exceeds ${TOTAL_PROMPT_MAX} chars` },
  ),
  model:             z.string().min(1).max(200).optional(),
  conversation_id:   z.string().uuid().nullable().optional(),
  document_ids:      z.array(z.string().uuid()).max(20).nullable().optional(),
  parent_message_id: z.string().uuid().nullable().optional(),
  agent_template_id: z.string().uuid().nullable().optional(),
  stream:            z.union([z.boolean(), z.literal('false'), z.literal('true')]).optional(),
}).passthrough();   // tolerate unknown legacy fields (vision payload, etc.)
