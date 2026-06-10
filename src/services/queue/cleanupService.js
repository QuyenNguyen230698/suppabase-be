import { query } from '../../db/index.js';
import { deleteManyFromR2 } from '../r2Service.js';

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // run every 6 hours
const ORPHAN_TTL_DAYS = 7;

async function deleteExpiredDocuments() {
  try {
    const result = await query(
      `DELETE FROM documents WHERE expires_at < NOW() RETURNING id, name, r2_key`,
    );
    if (result.rows.length > 0) {
      const keys = result.rows.map((r) => r.r2_key).filter(Boolean);
      const removed = await deleteManyFromR2(keys);
      console.log(`[cleanup] Deleted ${result.rows.length} expired document(s) (R2: ${removed}/${keys.length}):`,
        result.rows.map((r) => r.name).join(', '));
    }
  } catch (err) {
    console.error('[cleanup] Failed to delete expired documents:', err.message);
  }
}

// Orphan = upload that was never attached to any message and is older than
// ORPHAN_TTL_DAYS. Happens when a user picks a file, sees it process, then
// closes the tab without sending. Keeps R2 from accumulating dead bytes.
async function deleteOrphanDocuments() {
  try {
    const result = await query(
      `DELETE FROM documents d
        WHERE d.created_at < NOW() - ($1 || ' days')::interval
          AND NOT EXISTS (SELECT 1 FROM message_documents md WHERE md.document_id = d.id)
          AND d.conversation_id IS NULL
        RETURNING id, name, r2_key`,
      [String(ORPHAN_TTL_DAYS)],
    );
    if (result.rows.length > 0) {
      const keys = result.rows.map((r) => r.r2_key).filter(Boolean);
      const removed = await deleteManyFromR2(keys);
      console.log(`[cleanup] Removed ${result.rows.length} orphan doc(s) (R2: ${removed}/${keys.length})`);
    }
  } catch (err) {
    console.error('[cleanup] Failed to remove orphan documents:', err.message);
  }
}

export function startCleanupJob() {
  deleteExpiredDocuments();
  deleteOrphanDocuments();
  setInterval(() => {
    deleteExpiredDocuments();
    deleteOrphanDocuments();
  }, CLEANUP_INTERVAL_MS);
  console.log('[cleanup] Document cleanup job started (every 6h)');
}
