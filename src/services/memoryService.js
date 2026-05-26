// Memory service — fetch active memories for a user, format for prompt injection.
import { query } from '../db/index.js';

const TOP_K = parseInt(process.env.MEMORY_TOP_K || '20', 10);
const MAX_CHARS = parseInt(process.env.MEMORY_MAX_CHARS || '1500', 10);

/** Return concise memory bullets for the given user (active only, newest first). */
export async function getActiveMemories(userId) {
  if (!userId) return [];
  const { rows } = await query(
    `SELECT id, content, origin, created_at
       FROM user_memories
      WHERE user_id = $1 AND is_active = TRUE
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, TOP_K]
  );
  return rows;
}

/**
 * Build a plain-text block to append to the system prompt.
 * Returns '' if there are no memories.
 */
export async function buildMemoryBlock(userId) {
  const items = await getActiveMemories(userId);
  if (!items.length) return '';

  // Compact: 1 bullet per line, truncate total to MAX_CHARS
  let out = '';
  for (const m of items) {
    const line = `- ${m.content.trim()}\n`;
    if (out.length + line.length > MAX_CHARS) break;
    out += line;
  }
  if (!out) return '';

  return `\n\n---\n[What you remember about this user]\n${out.trim()}`;
}

/** Add a manual memory. */
export async function addMemory(userId, content) {
  const text = (content || '').trim();
  if (!text) return null;
  const { rows } = await query(
    `INSERT INTO user_memories (user_id, content, origin) VALUES ($1, $2, 'manual') RETURNING *`,
    [userId, text.slice(0, 600)]
  );
  return rows[0];
}

/** Mark a memory inactive (soft delete). */
export async function disableMemory(userId, id) {
  const { rowCount } = await query(
    `UPDATE user_memories SET is_active = FALSE, updated_at = NOW()
      WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return rowCount > 0;
}
