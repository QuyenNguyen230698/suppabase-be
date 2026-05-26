// Admin endpoints for runtime AI-provider routing.
// Allows changing provider rule / panic override without a backend restart.
//
// Routes (mounted under /api/admin/ai-settings, see src/routes/aiSettings.js):
//   GET    /          — current rule + override + a brief health snapshot
//   PATCH  /          — update rule or manual_override (body: { rule?, manual_override?, reason? })
//   DELETE /override  — clear manual override (panic-resume)
//   GET    /health    — full health snapshot
//   GET    /audit     — last 50 settings changes

import { query } from '../db/index.js';
import { getSetting, setSetting, getHealth } from '../services/providerRouter.js';

export async function getSettings(req, res) {
  try {
    const [rule, override, health] = await Promise.all([
      getSetting('ai_provider_rule'),
      getSetting('ai_provider_manual_override'),
      getHealth(),
    ]);
    res.json({ rule: rule || 'auto', manual_override: override, health });
  } catch (err) {
    console.error('[aiSettings] getSettings:', err.message);
    res.status(500).json({ error: 'Failed to load settings', code: 'ERR_DB' });
  }
}

export async function patchSettings(req, res) {
  const userId = req.user?.id || null;
  const { rule, manual_override, reason } = req.body || {};
  if (rule === undefined && manual_override === undefined) {
    return res.status(400).json({ error: 'Provide at least one of: rule, manual_override', code: 'ERR_NO_FIELDS' });
  }
  try {
    const updates = [];
    if (rule !== undefined) {
      await setSetting('ai_provider_rule', rule, { userId, reason });
      updates.push({ key: 'ai_provider_rule', value: rule });
    }
    if (manual_override !== undefined) {
      // Accept null to clear, "cloudflare" | "peb" to set.
      await setSetting('ai_provider_manual_override', manual_override, { userId, reason });
      updates.push({ key: 'ai_provider_manual_override', value: manual_override });
    }
    res.json({ ok: true, updates, health: await getHealth() });
  } catch (err) {
    console.error('[aiSettings] patchSettings:', err.message);
    res.status(400).json({ error: err.message, code: 'ERR_INVALID_VALUE' });
  }
}

export async function clearOverride(req, res) {
  try {
    await setSetting('ai_provider_manual_override', null, {
      userId: req.user?.id || null,
      reason: req.body?.reason || 'manual clear',
    });
    res.json({ ok: true, health: await getHealth() });
  } catch (err) {
    console.error('[aiSettings] clearOverride:', err.message);
    res.status(500).json({ error: err.message, code: 'ERR_DB' });
  }
}

export async function getHealthEndpoint(req, res) {
  try {
    res.json(await getHealth());
  } catch (err) {
    console.error('[aiSettings] getHealth:', err.message);
    res.status(500).json({ error: 'Failed to load health', code: 'ERR_DB' });
  }
}

export async function getAudit(req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const { rows } = await query(
      `SELECT a.key, a.old_value, a.new_value, a.reason, a.changed_at,
              u.username AS changed_by_username
       FROM system_settings_audit a
       LEFT JOIN users u ON u.id = a.changed_by
       WHERE a.key LIKE 'ai_provider%'
       ORDER BY a.changed_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ rows });
  } catch (err) {
    console.error('[aiSettings] getAudit:', err.message);
    res.status(500).json({ error: 'Failed to load audit', code: 'ERR_DB' });
  }
}
