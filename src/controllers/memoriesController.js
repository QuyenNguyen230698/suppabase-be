// Self-service memories under /api/me/memories.
import { query } from '../db/index.js';
import { addMemory, disableMemory } from '../services/memoryService.js';
import { sendError } from '../i18n/messages.js';

export async function listMyMemories(req, res) {
  const { rows } = await query(
    `SELECT id, content, origin, is_active, source_conversation_id, created_at
       FROM user_memories
      WHERE user_id = $1
      ORDER BY is_active DESC, created_at DESC
      LIMIT 200`,
    [req.user.id]
  );
  res.json({ items: rows });
}

export async function createMyMemory(req, res) {
  const text = (req.body?.content || '').trim();
  if (!text) return sendError(res, 400, 'ERR_FIELD_REQUIRED');
  const m = await addMemory(req.user.id, text);
  res.status(201).json(m);
}

export async function deleteMyMemory(req, res) {
  const ok = await disableMemory(req.user.id, req.params.id);
  if (!ok) return sendError(res, 404, 'ERR_NOT_FOUND');
  res.json({ ok: true });
}

// Permanently purge inactive memories (or all) for the user
export async function purgeMyMemories(req, res) {
  const all = req.query.all === '1';
  const { rowCount } = await query(
    `DELETE FROM user_memories WHERE user_id = $1 ${all ? '' : 'AND is_active = FALSE'}`,
    [req.user.id]
  );
  res.json({ ok: true, deleted: rowCount });
}
