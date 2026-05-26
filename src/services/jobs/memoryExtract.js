// Extract durable user preferences/facts from new conversation turns
// and write them to user_memories. Runs hourly, batches a handful per tick.
//
// Heuristic: only scan conversations whose last_message_at moved since the last scan.

import { query } from '../../db/index.js';
import { chat } from '../aiProvider.js';
import { generateEmbedding } from '../embeddingService.js';

const BATCH = 5;
const MIN_MESSAGES = 4;     // skip tiny chats
const MAX_FACTS    = 6;     // cap memories per scan
const MODEL = process.env.MEMORY_MODEL || process.env.DEFAULT_MODEL || '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b';

const SYSTEM = `You extract durable user preferences and identity facts from a chat.
Return a JSON array of short bullets, each ≤ 120 chars, of the user's:
  • role / job / company / location
  • preferred languages, frameworks, tools, brands
  • style preferences (formal, concise, deep technical, etc.)
  • personal facts they explicitly stated about themselves
Avoid one-off questions, transient context, or speculation.
If nothing durable is present, return [].

Format strictly:  ["bullet 1", "bullet 2", ...]   — no prose, no markdown.`;

async function pickCandidates() {
  // Pick conversations whose last_message_at > last scanned_at (or never scanned)
  const { rows } = await query(
    `SELECT c.id, c.user_id, c.last_message_at
       FROM conversations c
  LEFT JOIN memory_extract_log e ON e.conversation_id = c.id
      WHERE c.archived = FALSE
        AND (SELECT COUNT(*) FROM messages m
              WHERE m.conversation_id = c.id AND m.is_deleted = FALSE) >= $1
        AND (e.scanned_at IS NULL OR c.last_message_at > e.scanned_at)
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT $2`,
    [MIN_MESSAGES, BATCH]
  );
  return rows;
}

async function buildPrompt(conversationId) {
  const { rows } = await query(
    `SELECT role, content FROM messages
      WHERE conversation_id = $1 AND is_deleted = FALSE
      ORDER BY created_at ASC`,
    [conversationId]
  );
  // Use ~4k chars from the most recent turns — recent turns dominate preferences
  const tail = rows.slice(-30);
  const joined = tail.map(m => `[${m.role}] ${m.content}`).join('\n').slice(0, 4000);
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user',   content: `Conversation:\n\n${joined}` },
  ];
}

function parseFacts(raw) {
  if (!raw) return [];
  // Strip <think> if present
  let s = raw.replace(/^<think>[\s\S]*?<\/think>\s*/, '').trim();
  // Look for the first [...] block
  const m = s.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .map(x => (typeof x === 'string' ? x.trim() : ''))
      .filter(x => x && x.length <= 160)
      .slice(0, MAX_FACTS);
  } catch {
    return [];
  }
}

async function existingMemoriesSet(userId) {
  const { rows } = await query(
    `SELECT lower(content) AS k FROM user_memories
      WHERE user_id = $1 AND is_active = TRUE`,
    [userId]
  );
  return new Set(rows.map(r => r.k));
}

async function processConversation(conv) {
  const messages = await buildPrompt(conv.id);
  const result = await chat({ model: MODEL, messages });
  const facts = parseFacts(result.content || '');

  if (facts.length) {
    const existing = await existingMemoriesSet(conv.user_id);
    const fresh = facts.filter(f => !existing.has(f.toLowerCase()));
    if (fresh.length) {
      // Embed each new fact so semantic recall (memoryService.buildMemoryBlock)
      // can rank it against future questions. Skip embedding on failure — the
      // row still inserts and falls back to recency-based recall.
      for (const fact of fresh) {
        let emb = null;
        try { emb = await generateEmbedding(fact); } catch {}
        await query(
          `INSERT INTO user_memories (user_id, content, origin, source_conversation_id, embedding)
           VALUES ($1, $2, 'auto', $3, $4::vector)`,
          [conv.user_id, fact, conv.id, emb ? JSON.stringify(emb) : null]
        );
      }
      console.log(`[jobs.memory] ${conv.id} → +${fresh.length} memories`);
    }
  }

  // Always mark scanned so we don't reprocess
  await query(
    `INSERT INTO memory_extract_log (conversation_id, last_message_at, scanned_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (conversation_id) DO UPDATE
        SET last_message_at = EXCLUDED.last_message_at,
            scanned_at = NOW()`,
    [conv.id, conv.last_message_at]
  );
}

export default {
  name: 'memory_extract',
  description: `Extract durable preferences/facts into user_memories (batch ${BATCH}/hour).`,
  intervalMs: 60 * 60 * 1000, // 1h
  runAtBoot: false,
  async run() {
    const candidates = await pickCandidates();
    if (!candidates.length) return;
    for (const c of candidates) {
      try { await processConversation(c); }
      catch (err) { console.warn(`[jobs.memory] failed for ${c.id}:`, err.message); }
    }
  },
};
