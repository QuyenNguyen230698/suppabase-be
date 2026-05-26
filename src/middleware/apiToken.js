import { query } from '../db/index.js';

export async function apiTokenMiddleware(req, res, next) {
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (req.headers['x-api-token']) {
    token = req.headers['x-api-token'];
  }

  if (!token) {
    return res.status(401).json({ error: 'Missing API token' });
  }

  try {
    const result = await query(
      `SELECT * FROM api_tokens
       WHERE token_hash = $1
         AND is_active = true
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [token],
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: 'Invalid or expired API token' });
    }

    const matched = result.rows[0];
    await query('UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1', [matched.id]).catch(() => {});

    req.user = { id: matched.created_by, role: 'user', tokenId: matched.id };
    next();
  } catch (err) {
    console.error('[apiToken] Error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
