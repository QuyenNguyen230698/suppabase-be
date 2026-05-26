// Memory service — fetch active memories for a user, format for prompt injection.
import { query } from '../db/index.js';
import { generateEmbedding } from './embeddingService.js';

const TOP_K = parseInt(process.env.MEMORY_TOP_K || '8', 10);
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

// Rank memories by semantic similarity to the current question, mixed with
// the 3 most recent so identity facts ("user is a backend engineer") don't
// get crowded out by topic-specific recall. Falls back to recency when the
// embedding lookup fails or no query text is available.
async function getRelevantMemories(userId, queryText) {
  if (!userId) return [];
  if (!queryText) return getActiveMemories(userId);

  let emb;
  try {
    emb = await generateEmbedding(queryText);
  } catch {
    return getActiveMemories(userId);
  }

  try {
    const { rows } = await query(
      `WITH ranked AS (
          SELECT id, content, origin, created_at,
                 1 - (embedding <=> $1::vector) AS similarity
            FROM user_memories
           WHERE user_id = $2 AND is_active = TRUE AND embedding IS NOT NULL
           ORDER BY embedding <=> $1::vector
           LIMIT $3
       ),
       recent AS (
          SELECT id, content, origin, created_at, NULL::float AS similarity
            FROM user_memories
           WHERE user_id = $2 AND is_active = TRUE
           ORDER BY created_at DESC
           LIMIT 3
       )
       SELECT DISTINCT ON (id) id, content, origin, created_at, similarity
         FROM (SELECT * FROM ranked UNION ALL SELECT * FROM recent) u
        ORDER BY id, similarity DESC NULLS LAST`,
      [JSON.stringify(emb), userId, TOP_K]
    );
    if (rows.length) return rows;
  } catch (err) {
    console.warn('[memory] semantic recall failed, falling back to recency:', err.message);
  }
  return getActiveMemories(userId);
}

/**
 * Build a plain-text block to append to the system prompt.
 * Pass the latest user question to rank by relevance instead of recency.
 * Returns '' if there are no memories.
 */
export async function buildMemoryBlock(userId, queryText = null) {
  const items = queryText
    ? await getRelevantMemories(userId, queryText)
    : await getActiveMemories(userId);
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

/** Add a manual memory. Embeds inline so semantic recall works immediately. */
export async function addMemory(userId, content) {
  const text = (content || '').trim();
  if (!text) return null;
  let emb = null;
  try { emb = await generateEmbedding(text.slice(0, 600)); } catch {}
  const { rows } = await query(
    `INSERT INTO user_memories (user_id, content, origin, embedding)
     VALUES ($1, $2, 'manual', $3::vector) RETURNING *`,
    [userId, text.slice(0, 600), emb ? JSON.stringify(emb) : null]
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
