import { z } from 'zod';

const FLAG_REASONS = ['unsafe', 'low_quality', 'pii_leak', 'off_topic', 'other'];

// ISO 8601 OR plain date — accept both. Postgres will coerce.
const dateStr = z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: 'invalid date' });

const SORT_KEYS = ['created_at', 'user', 'agent', 'flag'];

const filterFields = {
  user_id:  z.string().uuid().optional(),
  agent_id: z.string().uuid().optional(),
  q:        z.string().max(200).optional(),
  from:     dateStr.optional(),
  to:       dateStr.optional(),
  flagged:  z.enum(['0', '1', 'true', 'false']).optional(),
  // Only Q&A pairs that have at least one attached file.
  has_files: z.enum(['0', '1', 'true', 'false']).optional(),
  sort:     z.enum(SORT_KEYS).optional(),
  dir:      z.enum(['asc', 'desc']).optional(),
};

export const listQaAuditQuery = z.object({
  ...filterFields,
  page:     z.coerce.number().int().min(1).max(10000).optional(),
  limit:    z.coerce.number().int().min(1).max(100).optional(),
}).strict();

export const exportQaAuditQuery = z.object({
  ...filterFields,
  format: z.enum(['csv', 'json']).optional(),
  // Tolerated but ignored (export is uncapped up to EXPORT_MAX_ROWS) so a
  // client forwarding its list pagination params doesn't get a 400.
  page:  z.coerce.number().int().optional(),
  limit: z.coerce.number().int().optional(),
}).strict();

export const bulkFlagBody = z.object({
  message_ids: z.array(z.string().uuid()).min(1).max(500),
  reason: z.enum(FLAG_REASONS).optional(),
  note:   z.string().max(2000).nullable().optional(),
}).strict();

export const bulkUnflagBody = z.object({
  message_ids: z.array(z.string().uuid()).min(1).max(500),
}).strict();

export const accessLogQuery = z.object({
  page:  z.coerce.number().int().min(1).max(10000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
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
