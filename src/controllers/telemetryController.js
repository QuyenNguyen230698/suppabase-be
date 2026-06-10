// Lightweight admin telemetry — counts/aggregates from existing tables.
// All endpoints require adminOnly (mounted that way in routes).

import { query } from '../db/index.js';
import { listJobs, runNow } from '../services/queue/jobScheduler.js';

// ── GET /api/admin/telemetry/summary ──────────────────────────
// Last-N-days aggregates for a small dashboard.
export async function getSummary(req, res) {
  const days = Math.min(parseInt(req.query.days, 10) || 7, 90);

  const [usersTotal, usersActive7d, conversationsTotal, conversationsDays,
         messagesTotal, messagesDays, tokensDays, topUsers, errorsDay] =
    await Promise.all([
      query(`SELECT COUNT(*)::int AS n FROM users`),
      query(`SELECT COUNT(*)::int AS n FROM users WHERE last_login_at > NOW() - INTERVAL '7 days'`),
      query(`SELECT COUNT(*)::int AS n FROM conversations`),
      query(
        `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
                COUNT(*)::int AS n
           FROM conversations
          WHERE created_at > NOW() - ($1::int || ' days')::interval
       GROUP BY day ORDER BY day`,
        [days]
      ),
      query(`SELECT COUNT(*)::int AS n FROM messages WHERE is_deleted = FALSE`),
      query(
        `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
                COUNT(*)::int AS n
           FROM messages
          WHERE created_at > NOW() - ($1::int || ' days')::interval
            AND is_deleted = FALSE
       GROUP BY day ORDER BY day`,
        [days]
      ),
      query(
        `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
                COALESCE(SUM(tokens_in), 0)::int  AS tokens_in,
                COALESCE(SUM(tokens_out), 0)::int AS tokens_out
           FROM messages
          WHERE created_at > NOW() - ($1::int || ' days')::interval
            AND is_deleted = FALSE
       GROUP BY day ORDER BY day`,
        [days]
      ),
      query(
        `SELECT u.id, u.username, u.full_name,
                COUNT(c.id)::int AS conversation_count,
                COALESCE(SUM(c.tokens_used), 0)::int AS tokens_used
           FROM users u
           JOIN conversations c ON c.user_id = u.id
          WHERE c.created_at > NOW() - ($1::int || ' days')::interval
       GROUP BY u.id
       ORDER BY tokens_used DESC, conversation_count DESC
          LIMIT 10`,
        [days]
      ),
      query(
        `SELECT COUNT(*)::int AS n FROM permission_audit_log
          WHERE created_at > NOW() - INTERVAL '24 hours'`
      ),
    ]);

  res.json({
    range_days: days,
    users:         { total: usersTotal.rows[0].n, active_7d: usersActive7d.rows[0].n },
    conversations: { total: conversationsTotal.rows[0].n, by_day: conversationsDays.rows },
    messages:      { total: messagesTotal.rows[0].n, by_day: messagesDays.rows },
    tokens_by_day: tokensDays.rows,
    top_users:     topUsers.rows,
    audit_24h:     errorsDay.rows[0].n,
  });
}

// ── GET /api/admin/telemetry/jobs ─────────────────────────────
export async function getJobsStatus(req, res) {
  const jobs = await listJobs();
  res.json({ items: jobs });
}

// ── POST /api/admin/telemetry/jobs/:name/run ──────────────────
export async function triggerJob(req, res) {
  try {
    await runNow(req.params.name);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message, code: 'ERR_NOT_FOUND' });
  }
}
