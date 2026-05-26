// Message-level operations: edit a user message (with branching) and
// regenerate an assistant reply. Both return only the updated message
// metadata — the client should re-fetch the conversation OR call POST
// /api/chat with the new history to stream a fresh assistant reply.
//
// We deliberately don't stream from these endpoints. Streaming belongs
// to /api/chat. Edit/regenerate just rewrite history; the client then
// calls /api/chat which re-runs the full pipeline (guard, RAG, cache, ...).

import { query } from '../db/index.js';

// Helper — load the conversation that owns a message, with ownership check.
async function loadOwnedMessage(messageId, userId) {
  const { rows } = await query(
    `SELECT m.id, m.role, m.content, m.conversation_id, m.parent_message_id,
            c.user_id AS owner_id
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = $1 AND m.is_deleted = FALSE`,
    [messageId],
  );
  const row = rows[0];
  if (!row || row.owner_id !== userId) return null;
  return row;
}

// PATCH /api/messages/:id  — edit a user message.
// Body: { content: string }
// Effect: store original_content (first edit only), update content, set
// edited_at; soft-delete every message after this one in the same conversation
// so the conversation now branches from the edited turn. Client should then
// POST /api/chat with the new history to get a fresh assistant reply.
export async function editUserMessage(req, res) {
  const userId = req.user.id;
  const { content } = req.body || {};
  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'content is required', code: 'ERR_FIELD_REQUIRED' });
  }
  if (content.length > 32 * 1024) {
    return res.status(413).json({ error: 'content too large', code: 'ERR_MESSAGE_TOO_LARGE' });
  }

  const msg = await loadOwnedMessage(req.params.id, userId);
  if (!msg) return res.status(404).json({ error: 'Message not found', code: 'ERR_NOT_FOUND' });
  if (msg.role !== 'user') {
    return res.status(400).json({ error: 'Only user messages can be edited', code: 'ERR_KIND' });
  }

  const client = await (await import('../db/index.js')).default.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE messages
          SET original_content = COALESCE(original_content, content),
              content          = $1,
              edited_at        = NOW()
        WHERE id = $2`,
      [content, msg.id],
    );
    // Soft-delete every later message in this conversation. The client will
    // call /api/chat to produce a new assistant reply branching from here.
    const { rowCount } = await client.query(
      `UPDATE messages
          SET is_deleted = TRUE
        WHERE conversation_id = $1
          AND is_deleted = FALSE
          AND created_at > (SELECT created_at FROM messages WHERE id = $2)`,
      [msg.conversation_id, msg.id],
    );
    await client.query('COMMIT');
    res.json({ success: true, message_id: msg.id, branched_off: rowCount });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[messageOps] edit failed:', err.message);
    res.status(500).json({ error: 'Edit failed', code: 'ERR_DB' });
  } finally {
    client.release();
  }
}

// POST /api/messages/:id/regenerate — discard an assistant reply.
// Effect: soft-delete the assistant message and every later message. Client
// should then POST /api/chat with the history up to the parent user message
// to stream a fresh assistant reply.
export async function regenerateAssistantMessage(req, res) {
  const userId = req.user.id;
  const msg = await loadOwnedMessage(req.params.id, userId);
  if (!msg) return res.status(404).json({ error: 'Message not found', code: 'ERR_NOT_FOUND' });
  if (msg.role !== 'assistant') {
    return res.status(400).json({ error: 'Only assistant messages can be regenerated', code: 'ERR_KIND' });
  }

  const { rowCount } = await query(
    `UPDATE messages
        SET is_deleted = TRUE
      WHERE conversation_id = $1
        AND is_deleted = FALSE
        AND created_at >= (SELECT created_at FROM messages WHERE id = $2)`,
    [msg.conversation_id, msg.id],
  );
  res.json({ success: true, removed: rowCount, conversation_id: msg.conversation_id });
}
