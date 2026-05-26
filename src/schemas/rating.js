import { z } from 'zod';

export const rateBody = z.object({
  rating:  z.union([z.literal(1), z.literal(-1)]),
  reason:  z.enum(['inaccurate', 'harmful', 'off_topic', 'verbose', 'other']).nullable().optional(),
  comment: z.string().max(1000).nullable().optional(),
}).strict();

export const messageIdParam = z.object({
  messageId: z.string().uuid('messageId must be a UUID'),
}).strict();

export const idParam = z.object({
  id: z.string().uuid('id must be a UUID'),
}).strict();

export const daysQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).optional(),
}).strict();
