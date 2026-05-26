// L7 — Per-user violation rate-limit.
//
// Two windows track repeat offenders:
//   - sev4 window  = 1h    → 3+ violations triggers a 1h SOFT block.
//   - sev5 window  = 24h   → 5+ violations triggers a 24h HARD block.
//                            ALSO immediate HARD if a single CSAM/CBRN hit lands.
//
// Soft block: user can still chat but every message goes through L4 LLM-Guard
//             regardless of agent config (treated as elevated risk).
// Hard block: chat endpoints return 403 until block expires; admin can also
//             override via UI.
//
// Counters update inside recordViolation(). Reads (isBlocked) are cheap — one
// indexed PK lookup. No cron required; the row's window anchors self-expire.

import { query } from '../db/index.js';

const SEV4_WINDOW_MS  = 60 * 60 * 1000;          // 1 hour
const SEV5_WINDOW_MS  = 24 * 60 * 60 * 1000;     // 24 hours
const SEV4_THRESHOLD  = 3;
const SEV5_THRESHOLD  = 5;
const SOFT_BLOCK_MS   = 60 * 60 * 1000;          // 1 hour
const HARD_BLOCK_MS   = 24 * 60 * 60 * 1000;     // 24 hours

// Categories that trigger immediate hard-block on a SINGLE hit (severity 5 +
// zero_tolerance). Mirrors `threat_categories.zero_tolerance = TRUE`.
const INSTANT_HARD_BLOCK_CATEGORIES = new Set(['CSAM', 'CBRN', 'WEAPONS', 'SELF_HARM']);

/**
 * Check if a user is currently blocked. Returns:
 *   { blocked: false }                                 — go ahead
 *   { blocked: 'soft', until: Date, reason: 'rate' }   — allow but force L4
 *   { blocked: 'hard', until: Date, reason: 'rate' }   — refuse 403
 */
export async function getBlockStatus(userId) {
  if (!userId) return { blocked: false };
  const { rows } = await query(
    `SELECT soft_block_until, hard_block_until FROM user_violation_state WHERE user_id = $1`,
    [userId]
  );
  const row = rows[0];
  if (!row) return { blocked: false };
  const now = new Date();
  if (row.hard_block_until && new Date(row.hard_block_until) > now) {
    return { blocked: 'hard', until: row.hard_block_until, reason: 'rate_limit' };
  }
  if (row.soft_block_until && new Date(row.soft_block_until) > now) {
    return { blocked: 'soft', until: row.soft_block_until, reason: 'rate_limit' };
  }
  return { blocked: false };
}

/**
 * Record a violation and update windowed counters. May escalate to soft/hard
 * block. Called from guardService.logViolation() after the audit row is written.
 *
 * Returns the new sanction (if any) so caller can include it in the response.
 */
export async function recordViolation({ userId, category, severity }) {
  if (!userId || !severity) return { escalation: null };

  const now = new Date();
  const instantHard = INSTANT_HARD_BLOCK_CATEGORIES.has(category);

  // Upsert with window-aware counter reset done in SQL to avoid race conditions
  // when concurrent requests violate at the same time.
  const { rows } = await query(
    `INSERT INTO user_violation_state
       (user_id, sev4_count_1h, sev5_count_24h, total_count_24h,
        sev4_window_start, sev5_window_start, total_window_start,
        last_violation_at, last_category, updated_at)
     VALUES ($1,
             CASE WHEN $2 = 4 THEN 1 ELSE 0 END,
             CASE WHEN $2 = 5 THEN 1 ELSE 0 END,
             1, $3, $3, $3, $3, $4, $3)
     ON CONFLICT (user_id) DO UPDATE SET
       sev4_count_1h = CASE
         WHEN user_violation_state.sev4_window_start IS NULL
              OR user_violation_state.sev4_window_start < $3 - INTERVAL '1 hour'
         THEN (CASE WHEN $2 = 4 THEN 1 ELSE 0 END)
         ELSE user_violation_state.sev4_count_1h + (CASE WHEN $2 = 4 THEN 1 ELSE 0 END)
       END,
       sev5_count_24h = CASE
         WHEN user_violation_state.sev5_window_start IS NULL
              OR user_violation_state.sev5_window_start < $3 - INTERVAL '24 hour'
         THEN (CASE WHEN $2 = 5 THEN 1 ELSE 0 END)
         ELSE user_violation_state.sev5_count_24h + (CASE WHEN $2 = 5 THEN 1 ELSE 0 END)
       END,
       total_count_24h = CASE
         WHEN user_violation_state.total_window_start IS NULL
              OR user_violation_state.total_window_start < $3 - INTERVAL '24 hour'
         THEN 1
         ELSE user_violation_state.total_count_24h + 1
       END,
       sev4_window_start = CASE
         WHEN user_violation_state.sev4_window_start IS NULL
              OR user_violation_state.sev4_window_start < $3 - INTERVAL '1 hour'
         THEN $3 ELSE user_violation_state.sev4_window_start
       END,
       sev5_window_start = COALESCE(user_violation_state.sev5_window_start, $3),
       total_window_start = COALESCE(user_violation_state.total_window_start, $3),
       last_violation_at = $3,
       last_category = $4,
       updated_at = $3
     RETURNING sev4_count_1h, sev5_count_24h, total_count_24h,
               soft_block_until, hard_block_until`,
    [userId, severity, now, category]
  );

  const state = rows[0];
  let escalation = null;

  // Instant hard block for zero-tolerance categories — always escalate even if
  // existing sanction is shorter.
  if (instantHard) {
    const until = new Date(now.getTime() + HARD_BLOCK_MS);
    await query(
      `UPDATE user_violation_state
         SET hard_block_until = GREATEST(COALESCE(hard_block_until, $2), $2)
       WHERE user_id = $1`,
      [userId, until]
    );
    escalation = { type: 'hard', until, reason: `zero_tolerance:${category}` };
  } else if (state.sev5_count_24h >= SEV5_THRESHOLD) {
    const until = new Date(now.getTime() + HARD_BLOCK_MS);
    await query(
      `UPDATE user_violation_state
         SET hard_block_until = GREATEST(COALESCE(hard_block_until, $2), $2)
       WHERE user_id = $1`,
      [userId, until]
    );
    escalation = { type: 'hard', until, reason: 'sev5_threshold' };
  } else if (state.sev4_count_1h >= SEV4_THRESHOLD) {
    const until = new Date(now.getTime() + SOFT_BLOCK_MS);
    await query(
      `UPDATE user_violation_state
         SET soft_block_until = GREATEST(COALESCE(soft_block_until, $2), $2)
       WHERE user_id = $1`,
      [userId, until]
    );
    escalation = { type: 'soft', until, reason: 'sev4_threshold' };
  }

  if (escalation) {
    console.warn(`[violationLimiter] user=${userId} → ${escalation.type} block until ${escalation.until.toISOString()} (${escalation.reason})`);
  }
  return { state, escalation };
}

/**
 * Admin override — lift either block early. Used by admin UI.
 */
export async function clearBlock(userId, kind = 'both') {
  if (!userId) return;
  const cols = [];
  if (kind === 'both' || kind === 'soft') cols.push('soft_block_until = NULL');
  if (kind === 'both' || kind === 'hard') cols.push('hard_block_until = NULL');
  if (!cols.length) return;
  await query(`UPDATE user_violation_state SET ${cols.join(', ')}, updated_at = NOW() WHERE user_id = $1`, [userId]);
}
