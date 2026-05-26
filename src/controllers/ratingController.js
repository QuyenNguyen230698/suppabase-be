// ratingController — user thumb up/down on assistant messages.
//
//   POST   /api/messages/:messageId/rating  body: { rating: 1 | -1, reason?, comment? }
//   DELETE /api/messages/:messageId/rating
//
//   GET    /api/admin/ratings/agents              quality stats grouped by agent
//   GET    /api/admin/ratings/agents/:id          stats for one agent + recent negatives

import { query } from '../db/index.js';

const REASONS = ['inaccurate', 'harmful', 'off_topic', 'verbose', 'other'];

// ── User endpoints ───────────────────────────────────────────────

export async function rateMessage(req, res) {
  const { messageId } = req.params;
  const { rating, reason, comment } = req.body || {};
  if (rating !== 1 && rating !== -1) {
    return res.status(400).json({ error: 'rating must be 1 or -1', code: 'ERR_BAD_INPUT' });
  }
  if (reason && !REASONS.includes(reason)) {
    return res.status(400).json({ error: `reason must be one of: ${REASONS.join('|')}`, code: 'ERR_BAD_INPUT' });
  }
  try {
    // Only allow rating assistant messages of conversations the user owns
    const own = await query(
      `SELECT m.id FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
       WHERE m.id = $1 AND c.user_id = $2 AND m.role = 'assistant'`,
      [messageId, req.user.id]
    );
    if (!own.rows[0]) {
      return res.status(404).json({ error: 'Message not found or not yours', code: 'ERR_NOT_FOUND' });
    }
    await query(
      `INSERT INTO qa_rating (message_id, user_id, rating, reason, comment)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (message_id, user_id) DO UPDATE
         SET rating = EXCLUDED.rating,
             reason = EXCLUDED.reason,
             comment = EXCLUDED.comment,
             updated_at = NOW()`,
      [messageId, req.user.id, rating, reason || null, comment || null]
    );
    res.json({ ok: true, rating });
  } catch (err) {
    console.error('[rating] rateMessage:', err);
    res.status(500).json({ error: 'Internal error', code: 'ERR_DB' });
  }
}

export async function clearRating(req, res) {
  const { messageId } = req.params;
  try {
    await query(`DELETE FROM qa_rating WHERE message_id=$1 AND user_id=$2`, [messageId, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[rating] clearRating:', err);
    res.status(500).json({ error: 'Internal error', code: 'ERR_DB' });
  }
}

// ── Admin endpoints ──────────────────────────────────────────────

export async function agentQuality(req, res) {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
  try {
    const overall = await query(
      `SELECT
         agent_template_id, agent_slug, agent_name,
         ratings_total, up_count, down_count, avg_rating, positive_pct
       FROM v_agent_quality
       WHERE agent_template_id IS NOT NULL
       ORDER BY ratings_total DESC, positive_pct DESC NULLS LAST`
    );
    const recentByDay = await query(
      `SELECT date_trunc('day', r.created_at)::date AS day,
              COUNT(*) FILTER (WHERE r.rating =  1)::int AS up,
              COUNT(*) FILTER (WHERE r.rating = -1)::int AS down
         FROM qa_rating r
        WHERE r.created_at >= NOW() - INTERVAL '${days} days'
        GROUP BY day ORDER BY day ASC`
    );
    res.json({ days, agents: overall.rows, by_day: recentByDay.rows });
  } catch (err) {
    console.error('[rating] agentQuality:', err);
    res.status(500).json({ error: 'Internal error', code: 'ERR_DB' });
  }
}

export async function agentDetail(req, res) {
  const agentId = req.params.id;
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
  try {
    const summary = await query(
      `SELECT * FROM v_agent_quality WHERE agent_template_id = $1`,
      [agentId]
    );
    const reasonBreakdown = await query(
      `SELECT r.reason, COUNT(*)::int AS n
         FROM qa_rating r
         JOIN messages m      ON m.id = r.message_id
         JOIN conversations c ON c.id = m.conversation_id
        WHERE c.agent_template_id = $1 AND r.rating = -1
        GROUP BY r.reason ORDER BY n DESC`,
      [agentId]
    );
    const recentNegatives = await query(
      `SELECT m.id AS message_id, m.content, r.reason, r.comment, r.created_at,
              u.username, u.email
         FROM qa_rating r
         JOIN messages m      ON m.id = r.message_id
         JOIN conversations c ON c.id = m.conversation_id
         JOIN users u         ON u.id = r.user_id
        WHERE c.agent_template_id = $1 AND r.rating = -1
          AND r.created_at >= NOW() - INTERVAL '${days} days'
        ORDER BY r.created_at DESC LIMIT 20`,
      [agentId]
    );
    res.json({
      summary: summary.rows[0] || null,
      reason_breakdown: reasonBreakdown.rows,
      recent_negatives: recentNegatives.rows,
    });
  } catch (err) {
    console.error('[rating] agentDetail:', err);
    res.status(500).json({ error: 'Internal error', code: 'ERR_DB' });
  }
}
