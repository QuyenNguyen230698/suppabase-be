import { getToday, getHistory } from '../services/neuronsTracker.js';
import { currentMode } from '../services/aiProvider.js';
import { getOrReconcile } from '../services/usageReconciler.js';

export async function getAiUsage(req, res) {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 7, 90);
    const [today, history, mode] = await Promise.all([getToday(), getHistory(days), currentMode()]);
    res.json({ today, history, mode });
  } catch (err) {
    console.error('[aiUsage] error:', err.message);
    res.status(500).json({ error: 'Failed to load AI usage', code: 'ERR_DB' });
  }
}

// FE polls this after seeing `log_id` in the SSE usage event.
// Returns 200 with `reconciled: false` until Gateway Logs API has the entry
// (typically within 2–10s of the request finishing).
export async function getAiUsageLog(req, res) {
  try {
    const { log_id } = req.params;
    if (!log_id) return res.status(400).json({ error: 'log_id required', code: 'ERR_BAD_REQUEST' });

    const row = await getOrReconcile(log_id);
    if (!row) return res.status(404).json({ error: 'Log not found', code: 'ERR_NOT_FOUND' });

    res.json({
      log_id: row.log_id,
      created_at: row.created_at,
      model: row.model,
      provider: row.provider,
      endpoint: row.endpoint,
      reconciled: !!row.reconciled_at,
      reconciled_at: row.reconciled_at,
      reconcile_attempts: row.reconcile_attempts,
      tokens: {
        in: row.tokens_in,
        out: row.tokens_out,
        total: (row.tokens_in || 0) + (row.tokens_out || 0),
      },
      neurons: row.neurons,
      cost_usd: row.cost_usd,
      duration_ms: row.duration_ms,
      cached: row.cached,
    });
  } catch (err) {
    console.error('[aiUsage] log lookup error:', err.message);
    res.status(500).json({ error: 'Failed to load usage log', code: 'ERR_DB' });
  }
}
