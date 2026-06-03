// aicore/persistence — all DB read/write for the chat pipeline.
//
// Extracted verbatim from the legacy chatCore.js so every core (and the
// controllers' read endpoints) share one place for conversation/message I/O.
// No behavioural change vs the original functions.

import { query } from '../../db/index.js';
import { deleteManyFromR2 } from '../r2Service.js';

// ── Conversation + message writes ────────────────────────────────
export async function upsertConversation({ userId, model, source, conversationId, title, agentTemplateId }) {
  if (conversationId) {
    // Track the most recently-used agent on the conversation row for FE
    // sidebar badges. Per-turn agent is recorded on each message row, so
    // switching agents mid-thread is fully supported and auditable.
    await query(
      `UPDATE conversations
         SET model = $1,
             agent_template_id = COALESCE($4, agent_template_id)
       WHERE id = $2 AND user_id = $3`,
      [model, conversationId, userId, agentTemplateId || null]
    );
    return conversationId;
  }
  const { rows } = await query(
    `INSERT INTO conversations (user_id, title, model, source, agent_template_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [userId, title, model, source, agentTemplateId || null]
  );
  return rows[0].id;
}

export async function saveUserMessage({ convId, content, agentTemplateId = null }) {
  const { rows } = await query(
    `INSERT INTO messages (conversation_id, role, content, agent_template_id)
     VALUES ($1, 'user', $2, $3) RETURNING id`,
    [convId, content, agentTemplateId]
  );
  return rows[0].id;
}

export async function saveAssistantMessage({ convId, content, model, reasoning, tokensIn, tokensOut, provider, logId, fallbackReason, agentTemplateId = null }) {
  if (!content) return null;
  try {
    const { rows } = await query(
      `INSERT INTO messages
         (conversation_id, role, content, model, reasoning, tokens_in, tokens_out, provider, log_id, fallback_reason, agent_template_id)
       VALUES ($1, 'assistant', $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        convId, content,
        model ?? null,
        reasoning ?? null,
        tokensIn ?? null, tokensOut ?? null,
        provider ?? null, logId ?? null, fallbackReason ?? null,
        agentTemplateId,
      ],
    );
    return rows[0]?.id || null;
  } catch (e) {
    console.warn('[aicore] saveAssistantMessage:', e.message);
    return null;
  }
}

// Load prior turns of a conversation as a chat-message array (no system),
// so the model sees the full thread even when the client only sent the new
// turn. Capped at `limit` most-recent rows to stay within context window.
// Returns [] when the conversation doesn't belong to userId.
export async function loadConversationMessages({ userId, conversationId, limit = 40 }) {
  if (!conversationId || !userId) return [];
  const { rows } = await query(
    `SELECT role, content
       FROM messages
      WHERE conversation_id = $1
        AND is_deleted = FALSE
        AND role IN ('user','assistant')
        AND content IS NOT NULL AND content <> ''
        AND conversation_id IN (SELECT id FROM conversations WHERE id = $1 AND user_id = $2)
      ORDER BY created_at DESC
      LIMIT $3`,
    [conversationId, userId, limit],
  );
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

// Collect every image document_id ever attached in this conversation,
// so a model switch mid-thread still sees the previously uploaded images.
export async function loadConversationImageDocIds({ userId, conversationId }) {
  if (!conversationId || !userId) return [];
  const { rows } = await query(
    `SELECT DISTINCT d.id
       FROM documents d
  LEFT JOIN message_documents md ON md.document_id = d.id
  LEFT JOIN messages m            ON m.id = md.message_id
      WHERE d.user_id = $1
        AND d.kind = 'image'
        AND d.r2_key IS NOT NULL
        AND (d.conversation_id = $2 OR m.conversation_id = $2)`,
    [userId, conversationId],
  );
  return rows.map((r) => r.id);
}

export async function linkDocumentsToMessage({ messageId, convId, docIds }) {
  if (!messageId || !docIds?.length) return;
  for (const docId of docIds) {
    await query(
      `INSERT INTO message_documents (message_id, document_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [messageId, docId]
    ).catch(() => {});
    await query(
      `UPDATE documents SET conversation_id=$1 WHERE id=$2 AND conversation_id IS NULL`,
      [convId, docId]
    ).catch(() => {});
  }
}

// Look up project custom instructions + conversation summary in one query.
export async function loadProjectAndSummary({ userId, conversationId }) {
  if (!conversationId || !userId) return { projectInstructions: '', conversationSummary: '' };
  try {
    const { rows } = await query(
      `SELECT c.summary, p.custom_instructions
         FROM conversations c
    LEFT JOIN projects p ON p.id = c.project_id AND p.user_id = c.user_id
        WHERE c.id = $1 AND c.user_id = $2`,
      [conversationId, userId]
    );
    return {
      projectInstructions: (rows[0]?.custom_instructions || '').trim(),
      conversationSummary: (rows[0]?.summary || '').trim(),
    };
  } catch (err) {
    console.warn('[aicore] project/summary lookup failed:', err.message);
    return { projectInstructions: '', conversationSummary: '' };
  }
}

// ── Read APIs (shared by controllers) ────────────────────────────
export async function listConversationsBySource({ userId, source }) {
  const { rows } = await query(
    `SELECT id, title, model, created_at, updated_at, last_message_at,
            pinned, starred, archived, summary, project_id, tokens_used
     FROM conversations
     WHERE user_id=$1 AND source=$2 AND archived = FALSE
     ORDER BY pinned DESC, last_message_at DESC NULLS LAST, updated_at DESC`,
    [userId, source]
  );
  return rows;
}

export async function getConversationWithMessages({ userId, source, conversationId }) {
  const conv = await query(
    `SELECT id, title, model, created_at, last_message_at,
            pinned, starred, archived, summary, project_id,
            tokens_used, share_token, share_expires_at
     FROM conversations
     WHERE id=$1 AND user_id=$2 AND source=$3`,
    [conversationId, userId, source]
  );
  if (!conv.rows.length) return null;

  const msgs = await query(
    `SELECT m.id, m.role, m.content, m.reasoning, m.model, m.tokens_in, m.tokens_out,
            m.provider, m.log_id, m.fallback_reason,
            m.parent_message_id, m.edited_at, m.created_at,
            m.agent_template_id,
            a.slug AS agent_slug, a.name AS agent_name,
            r.rating AS user_rating, r.reason AS rating_reason
     FROM messages m
     LEFT JOIN agent_templates a ON a.id = m.agent_template_id
     LEFT JOIN qa_rating r ON r.message_id = m.id AND r.user_id = $2
     WHERE m.conversation_id = $1 AND m.is_deleted = FALSE
     ORDER BY m.created_at ASC`,
    [conversationId, userId]
  );

  const userMsgIds = msgs.rows.filter(m => m.role === 'user').map(m => m.id);
  const docsByMessage = {};
  if (userMsgIds.length) {
    const docs = await query(
      `SELECT md.message_id, d.id AS document_id, d.name, d.type, d.status, d.expires_at
       FROM message_documents md
       JOIN documents d ON d.id = md.document_id
       WHERE md.message_id = ANY($1::uuid[])`,
      [userMsgIds]
    );
    for (const r of docs.rows) {
      (docsByMessage[r.message_id] ||= []).push({
        document_id: r.document_id, name: r.name, type: r.type,
        status: r.status, expires_at: r.expires_at,
      });
    }
  }

  const messages = msgs.rows.map(m => ({
    ...m,
    ...(m.role === 'user' && docsByMessage[m.id] ? { attachedDocs: docsByMessage[m.id] } : {}),
  }));

  return { ...conv.rows[0], messages };
}

export async function deleteConversationBySource({ userId, source, conversationId }) {
  // Collect R2 keys belonging to docs of this conversation BEFORE the cascade.
  // documents.conversation_id may be NULL for older rows; also pick up rows
  // linked via message_documents to be thorough.
  let keys = [];
  try {
    const { rows } = await query(
      `SELECT DISTINCT d.r2_key
         FROM documents d
    LEFT JOIN message_documents md ON md.document_id = d.id
    LEFT JOIN messages m            ON m.id = md.message_id
        WHERE d.r2_key IS NOT NULL
          AND (d.conversation_id = $1 OR m.conversation_id = $1)`,
      [conversationId],
    );
    keys = rows.map((r) => r.r2_key).filter(Boolean);
  } catch (err) {
    console.warn('[aicore] collect R2 keys before delete failed:', err.message);
  }

  const { rowCount } = await query(
    `DELETE FROM conversations WHERE id=$1 AND user_id=$2 AND source=$3`,
    [conversationId, userId, source]
  );
  if (rowCount) {
    await query(`DELETE FROM documents WHERE conversation_id=$1`, [conversationId]).catch(() => {});
    if (keys.length) {
      // Fire-and-forget — don't block the response on R2 deletes.
      deleteManyFromR2(keys).catch((e) => console.warn('[aicore] R2 cleanup:', e.message));
    }
  }
  return rowCount > 0;
}
