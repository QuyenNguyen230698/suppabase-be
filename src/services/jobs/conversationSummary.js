import { query } from '../../db/index.js';
import { chat } from '../aiProvider.js';
import { MODELS } from '../modelRegistry.js';

// Auto-generate `conversations.summary` for chats that:
//   • have ≥ MIN_MESSAGES messages
//   • are not archived
//   • do not yet have a summary OR were updated after the last summary was written
//
// We hit the local Ollama service with a deterministic short-summary prompt.
// Runs once per hour and processes at most BATCH conversations per tick.

const BATCH = 5;
const MIN_MESSAGES = parseInt(process.env.SUMMARY_MIN_MESSAGES || '6', 10);
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || MODELS.chatDefault;

async function pickCandidates() {
  // Pick conversations that:
  //  1. Have no summary yet, OR
  //  2. Have a summary but were updated (new messages) more than 30 min after the summary was written
  // Both cases require at least MIN_MESSAGES messages.
  const { rows } = await query(
    `SELECT c.id, c.title
       FROM conversations c
      WHERE c.archived = FALSE
        AND (
          c.summary IS NULL
          OR (c.last_message_at > c.updated_at - INTERVAL '30 minutes'
              AND c.last_message_at > NOW() - INTERVAL '7 days')
        )
        AND (SELECT COUNT(*) FROM messages m
              WHERE m.conversation_id = c.id AND m.is_deleted = FALSE) >= $1
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT $2`,
    [MIN_MESSAGES, BATCH]
  );
  return rows;
}

async function buildPromptFor(convId) {
  const { rows } = await query(
    `SELECT role, content FROM messages
      WHERE conversation_id = $1 AND is_deleted = FALSE
      ORDER BY created_at ASC`,
    [convId]
  );
  // Trim to ~6k chars to stay under context. Take first 2 + last 14 turns.
  const head = rows.slice(0, 2);
  const tail = rows.slice(-14);
  const merged = [...head, ...tail];
  const joined = merged.map(m => `[${m.role}] ${m.content}`).join('\n').slice(0, 6000);
  return [
    { role: 'system', content: 'You write extremely concise conversation summaries — 1 to 2 sentences (under 240 characters) describing what the chat is about. Plain prose. No quotes. Match the user\'s language.' },
    { role: 'user',   content: `Summarize this conversation in 1-2 sentences:\n\n${joined}` },
  ];
}

async function summarize(convId) {
  const messages = await buildPromptFor(convId);
  const result = await chat({ model: SUMMARY_MODEL, messages });
  let raw = result.content || '';
  // Strip any <think> if model emitted it
  raw = raw.replace(/^<think>[\s\S]*?<\/think>\s*/, '').trim();
  if (!raw) return null;
  return raw.slice(0, 280);
}

export default {
  name: 'conversation_summary',
  description: `Auto-summarize conversations ≥ ${MIN_MESSAGES} messages; re-summarize when updated (batches of ${BATCH}/hour).`,
  intervalMs: 10 * 60 * 1000, // 10 min — keep summary fresh enough to be useful in-chat
  runAtBoot: false,
  async run() {
    const candidates = await pickCandidates();
    if (!candidates.length) return;
    for (const c of candidates) {
      try {
        const summary = await summarize(c.id);
        if (summary) {
          await query(`UPDATE conversations SET summary = $1, updated_at = NOW() WHERE id = $2`,
            [summary, c.id]);
          console.log(`[jobs.summary] ${c.id} → ${summary.slice(0, 60)}…`);
        }
      } catch (err) {
        console.warn(`[jobs.summary] failed for ${c.id}:`, err.message);
      }
    }
  },
};
