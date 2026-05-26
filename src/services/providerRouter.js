// Runtime AI provider routing.
//
// Resolves which provider (cloudflare | peb) should serve a given chat/embed
// /vision request, based on DB-backed settings that admins can flip via API
// without a restart. Embeds and vision are always CF (no PEB alternative);
// only chat routing is flexible.
//
// Decision tree:
//   1. ai_provider_manual_override is set → use it verbatim (panic kill-switch).
//   2. ai_provider_rule = 'cf_first'      → cloudflare
//   3. ai_provider_rule = 'peb_first'     → peb
//   4. ai_provider_rule = 'auto'          → cloudflare unless CF quota would
//                                            block (shouldFallback) → peb.
//
// Cache: 30s TTL. setSetting() busts the cache immediately so admin changes
// take effect on the next request.

import { query } from '../db/index.js';
import { shouldFallback } from './neuronsTracker.js';
import { isOpen as breakerOpen } from './circuitBreaker.js';
import { isConfigured as pebReady } from './pebService.js';

const CACHE_TTL_MS = 30 * 1000;
const VALID_RULES = new Set(['auto', 'cf_first', 'peb_first']);
const VALID_OVERRIDES = new Set([null, 'cloudflare', 'peb']);

let cache = { at: 0, items: new Map() };

function cacheGet(key) {
  if ((Date.now() - cache.at) > CACHE_TTL_MS) return undefined;
  return cache.items.get(key);
}

async function refresh() {
  try {
    const { rows } = await query(`SELECT key, value FROM system_settings`);
    const map = new Map();
    for (const r of rows) map.set(r.key, r.value);
    cache = { at: Date.now(), items: map };
  } catch (err) {
    console.warn('[providerRouter] refresh failed (using stale cache):', err.message);
  }
}

/**
 * One-time migration from the legacy AI_PROVIDER env var to system_settings.
 * Idempotent: only runs if the corresponding row's `updated_by` is NULL (never
 * touched by admin) AND the env var is set. Logs the migration in audit.
 * Called once at boot from app.js.
 */
export async function migrateFromEnv() {
  const env = (process.env.AI_PROVIDER || '').toLowerCase();
  if (!env) return;
  const targetRule = env === 'peb' ? 'peb_first'
                   : env === 'cloudflare' ? 'cf_first'
                   : null;
  if (!targetRule) return;

  try {
    const { rows } = await query(
      `SELECT value, updated_by FROM system_settings WHERE key = 'ai_provider_rule'`
    );
    const row = rows[0];
    // Only migrate if admin has never set the rule manually.
    if (!row || row.updated_by) return;

    const current = row.value;
    if (current === targetRule) return; // already in sync

    await setSetting('ai_provider_rule', targetRule, {
      userId: null,
      reason: `auto-migrated from AI_PROVIDER=${env}`,
    });
    console.log(`[providerRouter] migrated AI_PROVIDER=${env} → ai_provider_rule=${targetRule}`);
  } catch (err) {
    console.warn('[providerRouter] env migration failed (non-fatal):', err.message);
  }
}

export async function getSetting(key) {
  let v = cacheGet(key);
  if (v === undefined) {
    await refresh();
    v = cache.items.get(key);
  }
  return v === undefined ? null : v;
}

export function _invalidateCache() { cache.at = 0; }

/**
 * Write a setting and append an audit row. Returns the new value.
 * Validates known keys against their allowed value sets.
 */
export async function setSetting(key, value, { userId = null, reason = null } = {}) {
  if (key === 'ai_provider_rule' && !VALID_RULES.has(value)) {
    throw new Error(`Invalid ai_provider_rule: ${value}. Must be one of: ${[...VALID_RULES].join(', ')}`);
  }
  if (key === 'ai_provider_manual_override' && !VALID_OVERRIDES.has(value)) {
    throw new Error(`Invalid ai_provider_manual_override: ${value}. Must be: null | cloudflare | peb`);
  }

  // Read old value for audit before upserting.
  const { rows: oldRows } = await query(`SELECT value FROM system_settings WHERE key = $1`, [key]);
  const oldValue = oldRows[0]?.value ?? null;

  await query(
    `INSERT INTO system_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [key, JSON.stringify(value), userId]
  );
  await query(
    `INSERT INTO system_settings_audit (key, old_value, new_value, reason, changed_by)
     VALUES ($1, $2::jsonb, $3::jsonb, $4, $5)`,
    [key, JSON.stringify(oldValue), JSON.stringify(value), reason, userId]
  );

  _invalidateCache();
  console.log(`[providerRouter] ${key} = ${JSON.stringify(value)} (by ${userId || 'system'}, reason: ${reason || '-'})`);
  return value;
}

/**
 * Resolve the active provider for a request. Returns 'cloudflare' | 'peb'.
 *
 * `kind` is passed in for future routing rules that depend on endpoint type
 * (embed/vision today must be CF — caller knows that and doesn't need to ask
 * us — but a future "embed_only_cf" rule could use it).
 */
export async function resolveProvider({ kind = 'chat' } = {}) {
  const manual = await getSetting('ai_provider_manual_override');
  if (manual === 'cloudflare' || manual === 'peb') {
    if (manual === 'peb' && !pebReady()) {
      console.warn('[providerRouter] manual override = peb but PEB not configured → falling back to cloudflare');
      return 'cloudflare';
    }
    return manual;
  }

  const rule = (await getSetting('ai_provider_rule')) || 'auto';

  if (rule === 'cf_first') return 'cloudflare';
  if (rule === 'peb_first') return pebReady() ? 'peb' : 'cloudflare';

  // 'auto'
  if (await shouldFallback()) return pebReady() ? 'peb' : 'cloudflare';
  if (breakerOpen('cloudflare') && pebReady()) return 'peb';
  return 'cloudflare';
}

/**
 * Snapshot of provider health for the admin dashboard. Cheap — no upstream
 * calls. Use the cached neurons + breaker state we already have.
 */
export async function getHealth() {
  const { getToday } = await import('./neuronsTracker.js');
  const today = await getToday();
  return {
    active_rule: (await getSetting('ai_provider_rule')) || 'auto',
    manual_override: await getSetting('ai_provider_manual_override'),
    cloudflare: {
      configured: !!(process.env.CF_AI_TOKEN && process.env.CF_ACCOUNT_ID),
      breaker: breakerOpen('cloudflare') ? 'open' : 'closed',
      quota: {
        used:      today.neurons_used,
        pending:   today.neurons_pending,
        limit:     today.neurons_limit,
        remaining: today.neurons_remaining,
        percent:   today.percent_used,
        over_threshold: today.should_fallback,
      },
    },
    peb: {
      configured: pebReady(),
    },
    effective_provider_now: await resolveProvider({ kind: 'chat' }),
  };
}
