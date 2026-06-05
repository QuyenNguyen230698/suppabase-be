import { z } from 'zod';

// Email OTP login — request a code, then verify it.
export const sendOtpBody = z.object({
  email: z.string().email().max(120),
}).strict();

export const verifyOtpBody = z.object({
  email: z.string().email().max(120),
  code:  z.string().regex(/^\d{6}$/, 'code must be 6 digits'),
}).strict();
