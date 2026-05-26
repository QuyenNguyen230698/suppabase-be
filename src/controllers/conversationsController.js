// Conversation extra operations not tied to a specific source ('chat' vs 'pro').
// The existing /api/chat/conversations* endpoints stay for backward-compat;
// these new endpoints work across both sources and add claude.ai-style ops:
//   • PATCH /api/conversations/:id        — pin/star/archive/rename/move-to-project
//   • POST  /api/conversations/:id/share  — generate share link
//   • DELETE /api/conversations/:id/share — revoke share
//   • GET   /api/public/share/:token      — read-only public payload
//   • GET   /api/conversations            — unified list (across sources, filters)
//   • GET   /api/search/conversations     — full-text search
//   • GET   /api/search/messages          — full-text + (optional) semantic search

import crypto from 'crypto';
import { query } from '../db/index.js';
import { sendError } from '../i18n/messages.js';

const SHARE_TOKEN_BYTES = 24; // 24 bytes → 32-char base64url

function generateShareToken() {
  return crypto.randomBytes(SHARE_TOKEN_BYTES).toString('base64url');
}

// ── GET /api/conversations  — unified cross-source list ──────
//   ?source=chat|pro             filter by source
//   ?pinned=1                    only pinned
//   ?archived=1                  only archived (default: hide archived)
//   ?starred=1                   only starred
//   ?project_id=<uuid>           only this project (or 'none' for "no project")
//   ?tag_id=<uuid>               only with this tag
//   ?q=<text>                    title search shortcut
//   ?limit=<n>&offset=<n>
export async function listConversations(req, res) {
  const userId = req.user.id;
  const params = [userId];
  const where  = ['c.user_id = $1'];
  let i = 2;

  if (req.query.source)   { params.push(req.query.source); where.push(`c.source = $${i++}`); }
  if (req.query.pinned === '1')   where.push('c.pinned   = TRUE');
  if (req.query.starred === '1')  where.push('c.starred  = TRUE');
  if (req.query.archived === '1') where.push('c.archived = TRUE');
  else                            where.push('c.archived = FALSE');

  if (req.query.project_id) {
    if (req.query.project_id === 'none') {
      where.push('c.project_id IS NULL');
    } else {
      params.push(req.query.project_id);
      where.push(`c.project_id = $${i++}`);
    }
  }

  if (req.query.tag_id) {
    params.push(req.query.tag_id);
    where.push(`EXISTS (SELECT 1 FROM conversation_tags ct WHERE ct.conversation_id = c.id AND ct.tag_id = $${i++})`);
  }

  if (req.query.q) {
    params.push(`%${req.query.q.trim()}%`);
    where.push(`c.title ILIKE $${i++}`);
  }

  const limit  = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const offset = parseInt(req.query.offset, 10) || 0;
  params.push(limit, offset);

  const { rows } = await query(
    `SELECT c.id, c.title, c.model, c.source,
            c.pinned, c.starred, c.archived,
            c.summary, c.project_id, c.tokens_used,
            c.last_message_at, c.created_at, c.updated_at,
            COALESCE(
              (SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color))
               FROM conversation_tags ct
               JOIN tags t ON t.id = ct.tag_id
               WHERE ct.conversation_id = c.id),
              '[]'::json
            ) AS tags
       FROM conversations c
      WHERE ${where.join(' AND ')}
      ORDER BY c.pinned DESC,
               COALESCE(c.last_message_at, c.updated_at) DESC
      LIMIT $${i++} OFFSET $${i++}`,
    params
  );

  res.json({ items: rows, limit, offset });
}

// ── PATCH /api/conversations/:id ─────────────────────────────
// Body fields (all optional):
//   { title, pinned, starred, archived, project_id|null, summary }
export async function updateConversation(req, res) {
  const userId = req.user.id;
  const { id } = req.params;

  const sets = [];
  const params = [id, userId];
  let i = 3;

  const allow = ['title', 'pinned', 'starred', 'archived', 'project_id', 'summary'];
  for (const field of allow) {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      params.push(req.body[field]);
      sets.push(`${field} = $${i++}`);
    }
  }
  if (!sets.length) return sendError(res, 400, 'ERR_VALIDATION');

  sets.push(`updated_at = NOW()`);

  const { rows } = await query(
    `UPDATE conversations SET ${sets.join(', ')}
       WHERE id = $1 AND user_id = $2
       RETURNING id, title, pinned, starred, archived, project_id, summary, updated_at`,
    params
  );
  if (!rows.length) return sendError(res, 404, 'ERR_CONVERSATION_NOT_FOUND');
  res.json(rows[0]);
}

// ── POST /api/conversations/:id/share ────────────────────────
//   { expires_in?: '1d'|'7d'|'30d'|'never' }
export async function shareConversation(req, res) {
  const userId = req.user.id;
  const { id } = req.params;
  const expiresIn = req.body?.expires_in || 'never';

  const EXP = { '1d': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, never: null };
  if (!Object.hasOwn(EXP, expiresIn)) return sendError(res, 400, 'ERR_VALIDATION');

  const token = generateShareToken();
  const expiresAt = EXP[expiresIn] ? new Date(Date.now() + EXP[expiresIn]) : null;

  const { rows } = await query(
    `UPDATE conversations
        SET share_token = $1, share_expires_at = $2, updated_at = NOW()
      WHERE id = $3 AND user_id = $4
      RETURNING share_token, share_expires_at`,
    [token, expiresAt, id, userId]
  );
  if (!rows.length) return sendError(res, 404, 'ERR_CONVERSATION_NOT_FOUND');
  res.json({ share_token: rows[0].share_token, share_expires_at: rows[0].share_expires_at });
}

// ── DELETE /api/conversations/:id/share ──────────────────────
export async function revokeShare(req, res) {
  const userId = req.user.id;
  const { id } = req.params;
  const { rowCount } = await query(
    `UPDATE conversations SET share_token = NULL, share_expires_at = NULL
       WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  if (!rowCount) return sendError(res, 404, 'ERR_CONVERSATION_NOT_FOUND');
  res.json({ ok: true });
}

// ── GET /api/public/share/:token (no auth) ────────────────────
export async function getSharedConversation(req, res) {
  const { token } = req.params;
  const { rows } = await query(
    `SELECT id, title, model, summary, created_at, last_message_at,
            share_expires_at
       FROM conversations
      WHERE share_token = $1
        AND (share_expires_at IS NULL OR share_expires_at > NOW())`,
    [token]
  );
  if (!rows.length) return sendError(res, 404, 'ERR_NOT_FOUND');

  const conv = rows[0];
  const msgs = await query(
    `SELECT id, role, content, created_at, model
       FROM messages
      WHERE conversation_id = $1 AND is_deleted = FALSE
      ORDER BY created_at ASC`,
    [conv.id]
  );
  res.json({ ...conv, messages: msgs.rows });
}

// ── GET /api/search/conversations?q=...&limit=20 ─────────────
// Full-text on title; if you want to also match by message body,
// hit /api/search/messages and group.
export async function searchConversations(req, res) {
  const userId = req.user.id;
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ items: [] });
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

  const { rows } = await query(
    `SELECT c.id, c.title, c.source, c.last_message_at, c.summary,
            ts_rank(c.title_tsv, plainto_tsquery('simple', $2)) AS rank
       FROM conversations c
      WHERE c.user_id = $1
        AND c.archived = FALSE
        AND c.title_tsv @@ plainto_tsquery('simple', $2)
      ORDER BY rank DESC, c.last_message_at DESC
      LIMIT $3`,
    [userId, q, limit]
  );
  res.json({ items: rows });
}

// ── GET /api/search/messages?q=...&limit=30 ──────────────────
// Returns matching messages joined with parent conversation.
export async function searchMessages(req, res) {
  const userId = req.user.id;
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ items: [] });
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 200);

  const { rows } = await query(
    `SELECT m.id          AS message_id,
            m.conversation_id,
            m.role,
            substring(m.content for 320) AS snippet,
            m.created_at,
            c.title       AS conversation_title,
            c.source,
            ts_rank(m.content_tsv, plainto_tsquery('simple', $2)) AS rank
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE c.user_id = $1
        AND m.is_deleted = FALSE
        AND m.content_tsv @@ plainto_tsquery('simple', $2)
      ORDER BY rank DESC, m.created_at DESC
      LIMIT $3`,
    [userId, q, limit]
  );
  res.json({ items: rows });
}
