import { z } from 'zod';

const FLAG_REASONS = ['unsafe', 'low_quality', 'pii_leak', 'off_topic', 'other'];

// ISO 8601 OR plain date — accept both. Postgres will coerce.
const dateStr = z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: 'invalid date' });

export const listQaAuditQuery = z.object({
  user_id:  z.string().uuid().optional(),
  agent_id: z.string().uuid().optional(),
  q:        z.string().max(200).optional(),
  from:     dateStr.optional(),
  to:       dateStr.optional(),
  flagged:  z.enum(['0', '1', 'true', 'false']).optional(),
  page:     z.coerce.number().int().min(1).max(10000).optional(),
  limit:    z.coerce.number().int().min(1).max(100).optional(),
}).strict();

export const statsQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).optional(),
}).strict();

export const flagBody = z.object({
  reason: z.enum(FLAG_REASONS).optional(),
  note:   z.string().max(2000).nullable().optional(),
}).strict();

export const messageIdParam = z.object({
  messageId: z.string().uuid('messageId must be a UUID'),
}).strict();

export const conversationIdParam = z.object({
  id: z.string().uuid('id must be a UUID'),
}).strict();
