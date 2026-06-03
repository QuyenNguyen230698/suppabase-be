// qaAuditController — admin/super_admin Q&A review endpoints.
//
//   GET    /api/admin/qa-audit                  list paired Q&A rows
//   GET    /api/admin/qa-audit/conversation/:id full thread (read-only)
//   GET    /api/admin/qa-audit/stats            counters + by-day series
//   POST   /api/admin/qa-audit/:messageId/flag  set flag/note
//   DELETE /api/admin/qa-audit/:messageId/flag  clear flag
//
// Access trail: every list/reveal/flag call writes to qa_access_log.

import { query } from '../db/index.js';
import { maskRow, maskText, maskEmail } from '../services/piiMasker.js';

// Validation handled by Zod in routes (see schemas/qaAudit.js).
const MAX_PAGE_SIZE = 100;
const EXPORT_MAX_ROWS = 5000;

// Whitelisted sort columns → SQL expression (prevents injection via ?sort=).
const SORT_COLUMNS = {
  created_at: 'u.created_at',
  user:       'u.username',
  agent:      'u.agent_name',
  flag:       'rv.flagged',
};

function isSuperAdmin(req)  { return req.user?.role === 'super_admin'; }

// Build the shared WHERE clause + params for list/export from query filters.
function buildFilter(query) {
  const { user_id, agent_id, q, from, to, flagged } = query;
  const where = [`u.role = 'user'`];
  const params = [];
  let i = 1;
  if (user_id)  { where.push(`u.user_id = $${i++}`); params.push(user_id); }
  if (agent_id) { where.push(`u.agent_template_id = $${i++}`); params.push(agent_id); }
  if (from)     { where.push(`u.created_at >= $${i++}`); params.push(from); }
  if (to)       { where.push(`u.created_at <  $${i++}`); params.push(to); }
  if (q)        { where.push(`(u.content ILIKE $${i} OR (a.content ILIKE $${i}))`); params.push(`%${q}%`); i++; }
  if (flagged === '1' || flagged === 'true') where.push(`rv.flagged = TRUE`);
  return { whereSql: where.join(' AND '), params, nextIdx: i };
}

function orderClause(sort, dir) {
  const col = SORT_COLUMNS[sort] || SORT_COLUMNS.created_at;
  const d = (dir === 'asc') ? 'ASC' : 'DESC';
  // Stable tiebreaker on created_at so equal sort keys keep deterministic order.
  return `ORDER BY ${col} ${d}${col === SORT_COLUMNS.created_at ? '' : ', u.created_at DESC'}`;
}

async function logAccess(req, action, targetId = null, meta = null) {
  try {
    await query(
      `INSERT INTO qa_access_log (admin_id, admin_role, action, target_id, meta)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user?.id || null, req.user?.role || null, action, targetId, meta ? JSON.stringify(meta) : null]
    );
  } catch (err) {
    console.warn('[qaAudit] access log failed:', err.message);
  }
}

// ── List Q&A pairs ───────────────────────────────────────────────
// Strategy: query user messages, then attach the next assistant message
// from the same conversation as the "answer" via LATERAL.
export async function list(req, res) {
  const { page = 1, limit = 25, sort, dir } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(limit, 10) || 25));
  const offset = (pageNum - 1) * pageSize;

  const { whereSql, params, nextIdx } = buildFilter(req.query);
  let i = nextIdx;

  // Count for pagination
  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM v_qa_audit u
    LEFT JOIN LATERAL (
      SELECT content, model, tokens_out, created_at FROM v_qa_audit
      WHERE conversation_id = u.conversation_id
        AND role = 'assistant' AND created_at > u.created_at
      ORDER BY created_at ASC LIMIT 1
    ) a ON TRUE
    LEFT JOIN qa_review rv ON rv.message_id = u.message_id
    WHERE ${whereSql}
  `;
  const dataSql = `
    SELECT
      u.message_id          AS user_message_id,
      u.conversation_id,
      u.conversation_title,
      u.user_id, u.username, u.email, u.full_name,
      u.agent_template_id, u.agent_slug, u.agent_name,
      u.content             AS question,
      u.created_at          AS asked_at,
      a.content             AS answer,
      a.model               AS answer_model,
      a.tokens_out          AS answer_tokens,
      a.created_at          AS answered_at,
      rv.flagged, rv.flag_reason, rv.note, rv.reviewed_by, rv.reviewed_at
    FROM v_qa_audit u
    LEFT JOIN LATERAL (
      SELECT content, model, tokens_out, created_at FROM v_qa_audit
      WHERE conversation_id = u.conversation_id
        AND role = 'assistant' AND created_at > u.created_at
      ORDER BY created_at ASC LIMIT 1
    ) a ON TRUE
    LEFT JOIN qa_review rv ON rv.message_id = u.message_id
    WHERE ${whereSql}
    ${orderClause(sort, dir)}
    LIMIT $${i++} OFFSET $${i++}
  `;
  params.push(pageSize, offset);

  try {
    const [countRes, dataRes] = await Promise.all([
      query(countSql, params.slice(0, params.length - 2)),
      query(dataSql, params),
    ]);

    const isSA = isSuperAdmin(req);
    const items = dataRes.rows.map(r => isSA ? r : ({
      ...r,
      email:     maskEmail(r.email),
      full_name: r.full_name,
      question:  maskText(r.question),
      answer:    maskText(r.answer),
    }));

    logAccess(req, 'list', null, { count: items.length, filters: req.query });

    res.json({
      items,
      page: pageNum,
      limit: pageSize,
      total: countRes.rows[0].total,
      masked: !isSA,
    });
  } catch (err) {
    console.error('[qaAudit] list:', err);
    res.status(500).json({ error: 'Internal error', code: 'ERR_DB' });
  }
}

// ── Full thread (read-only) ──────────────────────────────────────
export async function getConversation(req, res) {
  const convId = req.params.id;
  try {
    const conv = await query(
      `SELECT c.id, c.title, c.user_id, c.model, c.created_at,
              c.agent_template_id, at.name AS agent_name,
              u.username, u.email, u.full_name
       FROM conversations c
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN agent_templates at ON at.id = c.agent_template_id
       WHERE c.id = $1`,
      [convId]
    );
    if (!conv.rows[0]) return res.status(404).json({ error: 'Conversation not found', code: 'ERR_NOT_FOUND' });

    const msgs = await query(
      `SELECT m.id, m.role, m.content, m.model, m.tokens_in, m.tokens_out, m.created_at,
              rv.flagged, rv.flag_reason, rv.note
       FROM messages m
       LEFT JOIN qa_review rv ON rv.message_id = m.id
       WHERE m.conversation_id = $1 AND m.is_deleted = FALSE
       ORDER BY m.created_at ASC`,
      [convId]
    );

    const isSA = isSuperAdmin(req);
    const meta = isSA ? conv.rows[0] : {
      ...conv.rows[0],
      email:     maskEmail(conv.rows[0].email),
    };
    const messages = msgs.rows.map(m => isSA ? m : ({ ...m, content: maskText(m.content) }));

    logAccess(req, 'reveal', convId, { messages: messages.length });

    res.json({ conversation: meta, messages, masked: !isSA });
  } catch (err) {
    console.error('[qaAudit] getConversation:', err);
    res.status(500).json({ error: 'Internal error', code: 'ERR_DB' });
  }
}

// ── Stats ────────────────────────────────────────────────────────
export async function stats(req, res) {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
  try {
    const [totals, byDay, topAgents, topFlags] = await Promise.all([
      query(
        `SELECT
           COUNT(*)::int                                              AS messages_total,
           COUNT(*) FILTER (WHERE role='user')::int                   AS questions_total,
           COUNT(DISTINCT conversation_id)::int                       AS conversations_total,
           COUNT(DISTINCT user_id)::int                               AS users_total,
           (SELECT COUNT(*) FROM qa_review WHERE flagged=TRUE)::int   AS flagged_total
         FROM v_qa_audit
         WHERE created_at >= NOW() - INTERVAL '${days} days'`
      ),
      query(
        `SELECT date_trunc('day', created_at)::date AS day,
                COUNT(*) FILTER (WHERE role='user')::int AS questions
         FROM v_qa_audit
         WHERE created_at >= NOW() - INTERVAL '${days} days'
         GROUP BY day ORDER BY day ASC`
      ),
      query(
        `SELECT agent_slug, agent_name, COUNT(*)::int AS uses
         FROM v_qa_audit
         WHERE role='user' AND agent_template_id IS NOT NULL
           AND created_at >= NOW() - INTERVAL '${days} days'
         GROUP BY agent_slug, agent_name
         ORDER BY uses DESC LIMIT 5`
      ),
      query(
        `SELECT flag_reason, COUNT(*)::int AS n
         FROM qa_review WHERE flagged=TRUE AND flag_reason IS NOT NULL
         GROUP BY flag_reason ORDER BY n DESC`
      ),
    ]);

    res.json({
      days,
      totals: totals.rows[0],
      by_day: byDay.rows,
      top_agents: topAgents.rows,
      flag_breakdown: topFlags.rows,
    });
  } catch (err) {
    console.error('[qaAudit] stats:', err);
    res.status(500).json({ error: 'Internal error', code: 'ERR_DB' });
  }
}

// ── Flag / unflag ────────────────────────────────────────────────
export async function setFlag(req, res) {
  const { messageId } = req.params;
  const { reason, note } = req.body || {};
  try {
    const exists = await query(`SELECT 1 FROM messages WHERE id=$1`, [messageId]);
    if (!exists.rows.length) return res.status(404).json({ error: 'Message not found', code: 'ERR_NOT_FOUND' });

    await query(
      `INSERT INTO qa_review (message_id, flagged, flag_reason, note, reviewed_by, reviewed_at)
       VALUES ($1, TRUE, $2, $3, $4, NOW())
       ON CONFLICT (message_id) DO UPDATE
         SET flagged = TRUE, flag_reason = EXCLUDED.flag_reason,
             note = EXCLUDED.note, reviewed_by = EXCLUDED.reviewed_by, reviewed_at = NOW()`,
      [messageId, reason || null, note || null, req.user.id]
    );
    logAccess(req, 'flag', messageId, { reason, has_note: !!note });
    res.json({ ok: true });
  } catch (err) {
    console.error('[qaAudit] setFlag:', err);
    res.status(500).json({ error: 'Internal error', code: 'ERR_DB' });
  }
}

export async function clearFlag(req, res) {
  const { messageId } = req.params;
  try {
    await query(`DELETE FROM qa_review WHERE message_id = $1`, [messageId]);
    logAccess(req, 'unflag', messageId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[qaAudit] clearFlag:', err);
    res.status(500).json({ error: 'Internal error', code: 'ERR_DB' });
  }
}

// ── Bulk flag / unflag ───────────────────────────────────────────
export async function bulkFlag(req, res) {
  const { message_ids, reason, note } = req.body || {};
  if (!Array.isArray(message_ids) || !message_ids.length) {
    return res.status(400).json({ error: 'message_ids[] required', code: 'ERR_BAD_REQUEST' });
  }
  try {
    // One statement flags every id; unnest keeps it a single round-trip.
    await query(
      `INSERT INTO qa_review (message_id, flagged, flag_reason, note, reviewed_by, reviewed_at)
       SELECT mid, TRUE, $2, $3, $4, NOW()
         FROM unnest($1::uuid[]) AS mid
       ON CONFLICT (message_id) DO UPDATE
         SET flagged = TRUE, flag_reason = EXCLUDED.flag_reason,
             note = EXCLUDED.note, reviewed_by = EXCLUDED.reviewed_by, reviewed_at = NOW()`,
      [message_ids, reason || null, note || null, req.user.id]
    );
    logAccess(req, 'bulk_flag', null, { count: message_ids.length, reason });
    res.json({ ok: true, count: message_ids.length });
  } catch (err) {
    console.error('[qaAudit] bulkFlag:', err);
    res.status(500).json({ error: 'Internal error', code: 'ERR_DB' });
  }
}

export async function bulkUnflag(req, res) {
  const { message_ids } = req.body || {};
  if (!Array.isArray(message_ids) || !message_ids.length) {
    return res.status(400).json({ error: 'message_ids[] required', code: 'ERR_BAD_REQUEST' });
  }
  try {
    await query(`DELETE FROM qa_review WHERE message_id = ANY($1::uuid[])`, [message_ids]);
    logAccess(req, 'bulk_unflag', null, { count: message_ids.length });
    res.json({ ok: true, count: message_ids.length });
  } catch (err) {
    console.error('[qaAudit] bulkUnflag:', err);
    res.status(500).json({ error: 'Internal error', code: 'ERR_DB' });
  }
}

// ── Export (CSV / JSON) ──────────────────────────────────────────
// Same filter as list(), no pagination, capped at EXPORT_MAX_ROWS. Respects
// PII masking for non-super_admin (export must not leak what the UI hides).
export async function exportList(req, res) {
  const format = (req.query.format === 'csv') ? 'csv' : 'json';
  const { whereSql, params } = buildFilter(req.query);
  const sql = `
    SELECT u.message_id AS user_message_id, u.conversation_id, u.conversation_title,
           u.username, u.email, u.agent_name,
           u.content AS question, u.created_at AS asked_at,
           a.content AS answer, a.model AS answer_model, a.created_at AS answered_at,
           rv.flagged, rv.flag_reason, rv.note
      FROM v_qa_audit u
 LEFT JOIN LATERAL (
        SELECT content, model, created_at FROM v_qa_audit
         WHERE conversation_id = u.conversation_id AND role='assistant' AND created_at > u.created_at
      ORDER BY created_at ASC LIMIT 1
      ) a ON TRUE
 LEFT JOIN qa_review rv ON rv.message_id = u.message_id
     WHERE ${whereSql}
  ${orderClause(req.query.sort, req.query.dir)}
     LIMIT ${EXPORT_MAX_ROWS}
  `;
  try {
    const { rows } = await query(sql, params);
    const isSA = isSuperAdmin(req);
    const data = rows.map(r => isSA ? r : ({
      ...r, email: maskEmail(r.email), question: maskText(r.question), answer: maskText(r.answer),
    }));
    logAccess(req, 'export', null, { count: data.length, format, filters: req.query });

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="qa-audit-export.json"');
      return res.send(JSON.stringify({ count: data.length, capped: data.length >= EXPORT_MAX_ROWS, items: data }, null, 2));
    }
    // CSV
    const cols = ['asked_at', 'username', 'email', 'agent_name', 'question', 'answer', 'answer_model', 'flagged', 'flag_reason', 'note'];
    const esc = (v) => {
      if (v == null) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    };
    const lines = [cols.join(',')];
    for (const r of data) lines.push(cols.map(c => esc(r[c])).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="qa-audit-export.csv"');
    res.send('﻿' + lines.join('\n'));   // BOM so Excel reads UTF-8
  } catch (err) {
    console.error('[qaAudit] export:', err);
    res.status(500).json({ error: 'Internal error', code: 'ERR_DB' });
  }
}

// ── Access-log viewer (super_admin) ──────────────────────────────
// Transparency: who viewed/flagged/revealed/exported and when.
export async function accessLog(req, res) {
  const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (pageNum - 1) * pageSize;
  try {
    const [rows, count] = await Promise.all([
      query(
        `SELECT l.id, l.admin_id, l.admin_role, l.action, l.target_id, l.meta, l.created_at,
                u.username AS admin_username, u.email AS admin_email
           FROM qa_access_log l
      LEFT JOIN users u ON u.id = l.admin_id
       ORDER BY l.created_at DESC
          LIMIT $1 OFFSET $2`,
        [pageSize, offset]
      ),
      query(`SELECT COUNT(*)::int AS total FROM qa_access_log`),
    ]);
    res.json({ items: rows.rows, page: pageNum, limit: pageSize, total: count.rows[0].total });
  } catch (err) {
    console.error('[qaAudit] accessLog:', err);
    res.status(500).json({ error: 'Internal error', code: 'ERR_DB' });
  }
}

// ── Filter helpers ───────────────────────────────────────────────
export async function filterOptions(req, res) {
  try {
    const [agents, users] = await Promise.all([
      query(
        `SELECT id, slug, name FROM agent_templates
         WHERE is_active = TRUE ORDER BY name ASC`
      ),
      query(
        `SELECT u.id, u.username, u.email, u.full_name
         FROM users u
         WHERE EXISTS (SELECT 1 FROM conversations c WHERE c.user_id = u.id)
         ORDER BY u.username ASC LIMIT 200`
      ),
    ]);
    const isSA = isSuperAdmin(req);
    const userList = users.rows.map(u => isSA ? u : ({
      ...u, email: maskEmail(u.email),
    }));
    res.json({ agents: agents.rows, users: userList });
  } catch (err) {
    console.error('[qaAudit] filterOptions:', err);
    res.status(500).json({ error: 'Internal error', code: 'ERR_DB' });
  }
}
