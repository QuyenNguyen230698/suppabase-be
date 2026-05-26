import express from 'express';
import path from 'path';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { authMiddleware } from './middleware/auth.js';
import { apiTokenMiddleware } from './middleware/apiToken.js';
import { contextMiddleware, applyUserLocale } from './middleware/context.js';
import { requireModulePermission } from './middleware/requireModulePermission.js';

import authRoutes from './routes/auth.js';
import chatRoutes from './routes/chat.js';
import publicChatRoutes from './routes/publicChat.js';
import uploadRoutes from './routes/upload.js';
import documentRoutes from './routes/documents.js';
import modelRoutes from './routes/models.js';
import adminRoutes from './routes/admin.js';
import userRoutes from './routes/users.js';
import orgRoutes from './routes/org.js';
import permissionRoutes from './routes/permissions.js';
import visionRoutes from './routes/vision.js';
import pebChatRoutes from './routes/pebChat.js';
import conversationsRoutes from './routes/conversations.js';
import projectsRoutes from './routes/projects.js';
import tagsRoutes from './routes/tags.js';
import publicShareRoutes from './routes/publicShare.js';
import meRoutes from './routes/me.js';
import telemetryRoutes from './routes/telemetry.js';
import aiUsageRoutes from './routes/aiUsage.js';
import aiSettingsRoutes from './routes/aiSettings.js';
import { publicRouter as agentTemplatesPublicRoutes, adminRouter as agentTemplatesAdminRoutes } from './routes/agentTemplates.js';
import qaAuditRoutes from './routes/qaAudit.js';
import { userRouter as ratingUserRoutes, adminRouter as ratingAdminRoutes } from './routes/rating.js';

const app = express();
app.set('etag', 'strong');   // strong ETag — match exact body bytes

// BE serves: JSON APIs, static /uploads, and /api/documents/:id/raw (file
// proxy). Browser code never executes from this origin, so CSP can be
// maximally strict — no scripts, no styles, no framing. The strict policy
// also acts as a second line of defence for the file proxy on top of
// Content-Disposition: attachment / X-Content-Type-Options: nosniff that
// documentController already sets.
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
      frameAncestors: ["'none'"],
      // Allow images to be embedded by the FE app (cross-origin) — uploaded
      // avatars/attachments served from /uploads need this. data: lets
      // browsers render inline error images.
      imgSrc: ["'self'", 'data:'],
      // /api/health and friends — same-origin only.
      connectSrc: ["'self'"],
      // Sandbox any HTML that does slip through.
      sandbox: ['allow-downloads'],
    },
  },
  // Browsers must NOT sniff content-type — relied on by the file proxy.
  noSniff: true,
  referrerPolicy: { policy: 'no-referrer' },
}));
// Serve uploaded files (avatars, etc.) — URLs use unguessable UUIDs so no auth needed
app.use('/uploads', express.static(path.resolve('./uploads'), { maxAge: '7d' }));
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
  exposedHeaders: ['X-Request-Id', 'X-Conversation-Id'],
}));
// 1MB is plenty for a chat JSON body (TOTAL_PROMPT_MAX = 256KB).
// File uploads use multer (memoryStorage with its own per-kind cap),
// so they don't go through express.json() at all.
app.use(express.json({ limit: '1mb' }));
app.use(contextMiddleware);

// Per-user (or per-IP for anonymous) limiter — much fairer than pure-IP
// when multiple users share a NAT or office VPN.
const keyByUserOrIp = (req) => req.user?.id || req.ip;

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUserOrIp,
  message: { error: 'Too many requests, please try again later', code: 'ERR_RATE_LIMIT' },
});
app.use(globalLimiter);

// Relaxed limiter for permission admin endpoints (many small reads/writes per page interaction)
const permissionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUserOrIp,
  message: { error: 'Too many requests, please try again later', code: 'ERR_RATE_LIMIT' },
});

// Chat / streaming endpoints — limit per user to prevent runaway scripts
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,                  // 60 chat messages / minute / user
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUserOrIp,
  message: { error: 'Too many chat requests, slow down', code: 'ERR_RATE_LIMIT' },
});

// Stricter rate limit for unauthenticated public chat
const publicChatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later', code: 'ERR_RATE_LIMIT' },
});

// Request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const level = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO';
    console.log(`[${level}] [${req.id}] ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// Accepts JWT (from BE login) or API token (from external callers)
function flexAuth(req, res, next) {
  const apiTokenHeader = req.headers['x-api-token'];
  if (apiTokenHeader) return apiTokenMiddleware(req, res, next);
  return authMiddleware(req, res, next);
}

// Auth — public routes. IP-level brute-force guard on top of the per-user
// lockout in authController (which only protects against attacks targeting
// a known username; this also catches credential stuffing across many usernames
// from one IP).
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, slow down', code: 'ERR_RATE_LIMIT' },
});
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth', authRoutes);

// Public chat (no auth — for embedded widget on demo pages)
app.use('/api/chat/public', publicChatLimiter, publicChatRoutes);

// Public share (no auth, read-only — for /share/:token)
app.use('/api/public', publicShareRoutes);

// Protected routes — specific paths before general /api/chat
app.use('/api/models', flexAuth, applyUserLocale, modelRoutes);
app.use('/api/chat/vision', flexAuth, applyUserLocale, chatLimiter, requireModulePermission('chat', 'view'), visionRoutes);
app.use('/api/chat/peb', authMiddleware, applyUserLocale, chatLimiter, pebChatRoutes);
app.use('/api/chat', flexAuth, applyUserLocale, chatLimiter, chatRoutes);
app.use('/api/upload', flexAuth, applyUserLocale, uploadRoutes);
app.use('/api/documents', flexAuth, applyUserLocale, documentRoutes);

// Cross-source conversation ops + search + tags
app.use('/api', authMiddleware, applyUserLocale, conversationsRoutes);
app.use('/api/projects', authMiddleware, applyUserLocale, projectsRoutes); // guard per-route trong projects.js
app.use('/api/tags',     authMiddleware, applyUserLocale, tagsRoutes);
app.use('/api/me',       authMiddleware, applyUserLocale, meRoutes);

// Admin routes — mounted at /api/admin/tokens (was /api/admin which blanket-applied
// adminOnly to EVERY /api/admin/* path, including the public /permissions/me endpoint).
app.use('/api/admin/tokens', authMiddleware, applyUserLocale, adminRoutes);
app.use('/api/admin/users', authMiddleware, applyUserLocale, userRoutes);
app.use('/api/admin/org/nodes', authMiddleware, applyUserLocale, orgRoutes);
app.use('/api/admin/permissions', authMiddleware, applyUserLocale, permissionLimiter, permissionRoutes);

// Admin telemetry
app.use('/api/admin/telemetry', authMiddleware, applyUserLocale, telemetryRoutes);

// Admin AI usage (Cloudflare neurons quota tracking)
app.use('/api/admin/ai-usage', authMiddleware, applyUserLocale, aiUsageRoutes);

// Admin AI provider routing — runtime rule + manual override + audit + health
app.use('/api/admin/ai-settings', authMiddleware, applyUserLocale, aiSettingsRoutes);

// Agent templates — user-facing (list/get) + admin CRUD
app.use('/api/agent-templates', authMiddleware, applyUserLocale, agentTemplatesPublicRoutes);
app.use('/api/admin/agent-templates', authMiddleware, applyUserLocale, agentTemplatesAdminRoutes);

// QA Audit — admin/super_admin review of user Q&A pairs
app.use('/api/admin/qa-audit', authMiddleware, applyUserLocale, qaAuditRoutes);

// Rating — user thumb up/down + admin quality dashboard
app.use('/api/messages', authMiddleware, applyUserLocale, ratingUserRoutes);
app.use('/api/admin/ratings', authMiddleware, applyUserLocale, ratingAdminRoutes);

// Health: db ping + version + uptime
app.get('/api/health', async (req, res) => {
  const { query } = await import('./db/index.js');
  let dbOk = false;
  try { await query('SELECT 1'); dbOk = true; } catch {}
  res.json({
    status: dbOk ? 'ok' : 'degraded',
    db: dbOk,
    uptime: Math.floor(process.uptime()),
    version: process.env.APP_VERSION || 'dev',
    request_id: req.id,
  });
});

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${err.stack || err.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
