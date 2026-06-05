import bcrypt from 'bcrypt';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { query } from '../db/index.js';
import { sendError } from '../i18n/messages.js';
import { sendOtpEmail } from '../services/emailService.js';

const JWT_SECRET = process.env.JWT_SECRET;
const ACCESS_TTL_SEC = 60 * 60;              // 1h
const REFRESH_TTL_SEC = 60 * 60 * 24 * 7;    // 7d

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function signAccessToken(payload) {
  const jti = crypto.randomUUID();
  const token = jwt.sign({ ...payload, jti }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: ACCESS_TTL_SEC,
  });
  return { token, jti };
}

async function issueRefreshToken({ userId, req }) {
  const raw = crypto.randomBytes(48).toString('base64url');
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_SEC * 1000);
  await query(
    `INSERT INTO refresh_tokens (jti, user_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [jti, userId, sha256(raw), expiresAt, req.headers['user-agent']?.slice(0, 500) || null, req.ip || null],
  );
  return { refresh_token: `${jti}.${raw}`, expires_at: expiresAt };
}

export async function login(req, res) {
  const { username, password } = req.body;
  if (!username || !password) return sendError(res, 400, 'ERR_FIELD_REQUIRED');

  // 1. Tìm user kèm thông tin profile
  const { rows } = await query(
    `SELECT
       u.id, u.username, u.email, u.full_name, u.display_name,
       u.avatar_url, u.is_active, u.password_hash,
       u.failed_attempts, u.locked_until, u.must_change_password,
       u.country_code, u.timezone, u.language, u.job_title, u.department,
       u.permission_version
     FROM users u
     WHERE u.username = $1`,
    [username]
  );
  const user = rows[0];

  // 2. Not found or wrong password — same message to avoid user enumeration
  if (!user) return sendError(res, 401, 'ERR_INVALID_CREDENTIALS');

  // 3. Account temp-locked
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const until = new Date(user.locked_until).toLocaleTimeString();
    return sendError(res, 423, 'ERR_ACCOUNT_LOCKED', { detail: until });
  }

  // 4. Check password
  const passwordOk = await bcrypt.compare(password, user.password_hash);
  if (!passwordOk) {
    // Increment failed_attempts; lock after 5 (15min)
    const newAttempts = (user.failed_attempts || 0) + 1;
    const lockUntil = newAttempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
    await query(
      `UPDATE users SET failed_attempts = $1, locked_until = $2 WHERE id = $3`,
      [newAttempts, lockUntil, user.id]
    );
    return sendError(res, 401, 'ERR_INVALID_CREDENTIALS');
  }

  // 5. Active account
  if (!user.is_active) return sendError(res, 403, 'ERR_ACCOUNT_DISABLED');

  // 6-8. Resolve role, refresh login stats, sign + issue tokens, respond.
  return buildLoginResponse(user, req, res);
}

// Shared tail of a successful authentication (password login OR email OTP):
// resolve top role → reset lock + bump login stats → sign JWT + issue refresh
// token → return the standard auth response. `user` must carry the payload
// columns (id, username, full_name, display_name, avatar_url, country_code,
// timezone, language, permission_version, must_change_password).
async function buildLoginResponse(user, req, res) {
  // Top role (lowest level = highest privilege).
  const { rows: roleRows } = await query(
    `SELECT r.name AS role, r.display_name, r.level
     FROM user_node_roles unr
     JOIN roles r ON r.id = unr.role_id
     WHERE unr.user_id = $1
     ORDER BY r.level ASC
     LIMIT 1`,
    [user.id]
  );
  const topRole = roleRows[0]?.role || 'viewer';
  const topRoleDisplay = roleRows[0]?.display_name || 'Viewer';

  await query(
    `UPDATE users
     SET failed_attempts  = 0,
         locked_until     = NULL,
         last_login_at    = NOW(),
         login_count      = login_count + 1
     WHERE id = $1`,
    [user.id]
  );

  if (!JWT_SECRET) {
    console.error('[AUTH] JWT_SECRET is not configured');
    return res.status(500).json({ error: 'Server misconfiguration', code: 'ERR_INTERNAL' });
  }
  const payload = {
    id:           user.id,
    username:     user.username,
    full_name:    user.full_name,
    display_name: user.display_name,
    avatar_url:   user.avatar_url,
    role:         topRole,
    role_display: topRoleDisplay,
    country_code: user.country_code,
    timezone:     user.timezone,
    language:     user.language,
    pv:           user.permission_version ?? 1,  // permission version snapshot at login
  };
  const { token } = signAccessToken(payload);
  const { refresh_token, expires_at: refresh_expires_at } = await issueRefreshToken({ userId: user.id, req });

  return res.json({
    token,
    refresh_token,
    expires_in: ACCESS_TTL_SEC,
    refresh_expires_at,
    must_change_password: user.must_change_password,
    user: payload,
  });
}

// ── Email OTP login ──────────────────────────────────────────
// Selects the same payload columns login() needs, so buildLoginResponse works.
const USER_PAYLOAD_COLS = `
  id, username, email, full_name, display_name, avatar_url, is_active,
  must_change_password, country_code, timezone, language, permission_version
`;

const OTP_TTL_MS = 5 * 60 * 1000;   // 5 minutes
const OTP_MAX_ATTEMPTS = 5;

/**
 * POST /api/auth/send-otp — { email }
 * Always returns { success: true } regardless of whether the email exists, to
 * avoid leaking which addresses are registered (user enumeration). Only sends a
 * mail (and stores a code) when the email maps to an active user.
 */
export async function sendOtp(req, res) {
  const { email } = req.body;

  const { rows } = await query(
    `SELECT id, is_active FROM users WHERE email = $1`,
    [email]
  );
  const user = rows[0];

  if (user && user.is_active) {
    try {
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      // Invalidate any prior un-consumed codes for this user.
      await query(
        `UPDATE email_otp_codes SET consumed_at = NOW()
         WHERE user_id = $1 AND consumed_at IS NULL`,
        [user.id]
      );
      await query(
        `INSERT INTO email_otp_codes (user_id, code_hash, max_attempts, expires_at, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          user.id, sha256(code), OTP_MAX_ATTEMPTS,
          new Date(Date.now() + OTP_TTL_MS),
          req.ip || null, req.headers['user-agent']?.slice(0, 500) || null,
        ]
      );
      await sendOtpEmail(email, code);   // best-effort; never surfaced to client
    } catch (err) {
      console.error('[AUTH] sendOtp failed:', err.message);
      // Still return success — do not reveal anything to the client.
    }
  }

  return res.json({ success: true });
}

/**
 * POST /api/auth/verify-otp — { email, code }
 * On success returns the same auth payload as password login.
 */
export async function verifyOtp(req, res) {
  const { email, code } = req.body;

  const { rows } = await query(
    `SELECT ${USER_PAYLOAD_COLS} FROM users WHERE email = $1`,
    [email]
  );
  const user = rows[0];
  if (!user || !user.is_active) return sendError(res, 401, 'ERR_OTP_INVALID');

  // Latest un-consumed, non-expired code for this user.
  const { rows: otpRows } = await query(
    `SELECT id, code_hash, attempts, max_attempts
     FROM email_otp_codes
     WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [user.id]
  );
  const otp = otpRows[0];
  if (!otp) return sendError(res, 401, 'ERR_OTP_INVALID');

  if (otp.attempts >= otp.max_attempts) {
    // Too many wrong guesses — invalidate so the user must request a new code.
    await query(`UPDATE email_otp_codes SET consumed_at = NOW() WHERE id = $1`, [otp.id]);
    return sendError(res, 429, 'ERR_OTP_LOCKED');
  }

  if (sha256(code) !== otp.code_hash) {
    await query(`UPDATE email_otp_codes SET attempts = attempts + 1 WHERE id = $1`, [otp.id]);
    return sendError(res, 401, 'ERR_OTP_INVALID');
  }

  // Correct — consume the code, then issue tokens just like password login.
  await query(`UPDATE email_otp_codes SET consumed_at = NOW() WHERE id = $1`, [otp.id]);
  return buildLoginResponse(user, req, res);
}

// Rotate refresh token. Old refresh is marked revoked + replaced_by; access
// token issued fresh. Reuse-detection: if a revoked refresh is presented
// again, we revoke the entire chain (user re-login required).
export async function refresh(req, res) {
  const { refresh_token } = req.body || {};
  if (!refresh_token || typeof refresh_token !== 'string' || !refresh_token.includes('.')) {
    return sendError(res, 400, 'ERR_TOKEN_MISSING');
  }
  const [jti, raw] = refresh_token.split('.', 2);
  if (!jti || !raw) return sendError(res, 401, 'ERR_TOKEN_INVALID');

  const { rows } = await query(
    `SELECT rt.*, u.username, u.full_name, u.display_name, u.avatar_url,
            u.country_code, u.timezone, u.language, u.is_active, u.permission_version
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
      WHERE rt.jti = $1`,
    [jti],
  );
  const row = rows[0];
  if (!row) return sendError(res, 401, 'ERR_TOKEN_INVALID');
  if (row.token_hash !== sha256(raw)) return sendError(res, 401, 'ERR_TOKEN_INVALID');
  if (!row.is_active) return sendError(res, 403, 'ERR_ACCOUNT_DISABLED');
  if (new Date(row.expires_at) < new Date()) return sendError(res, 401, 'ERR_TOKEN_INVALID');

  // Reuse detection: a revoked refresh being presented = stolen token.
  if (row.revoked_at) {
    await query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [row.user_id]);
    return sendError(res, 401, 'ERR_TOKEN_INVALID');
  }

  // Resolve top role for new access token
  const { rows: roleRows } = await query(
    `SELECT r.name AS role, r.display_name
       FROM user_node_roles unr JOIN roles r ON r.id = unr.role_id
      WHERE unr.user_id = $1 ORDER BY r.level ASC LIMIT 1`,
    [row.user_id],
  );
  const topRole = roleRows[0]?.role || 'viewer';
  const topRoleDisplay = roleRows[0]?.display_name || 'Viewer';

  const payload = {
    id: row.user_id,
    username: row.username,
    full_name: row.full_name,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    role: topRole,
    role_display: topRoleDisplay,
    country_code: row.country_code,
    timezone: row.timezone,
    language: row.language,
    pv: row.permission_version ?? 1,
  };
  const { token } = signAccessToken(payload);
  const { refresh_token: newRefresh, expires_at: newRefreshExpiresAt } = await issueRefreshToken({ userId: row.user_id, req });
  await query(
    `UPDATE refresh_tokens SET revoked_at = NOW(), replaced_by = $1 WHERE jti = $2`,
    [newRefresh.split('.', 1)[0], jti],
  );

  return res.json({
    token,
    refresh_token: newRefresh,
    expires_in: ACCESS_TTL_SEC,
    refresh_expires_at: newRefreshExpiresAt,
    user: payload,
  });
}

// Revoke current access token (by jti) AND the supplied refresh token if any.
export async function logout(req, res) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(auth.slice(7), JWT_SECRET, { algorithms: ['HS256'] });
      if (decoded.jti && decoded.id && decoded.exp) {
        await query(
          `INSERT INTO revoked_access_tokens (jti, user_id, expires_at)
           VALUES ($1, $2, to_timestamp($3))
           ON CONFLICT (jti) DO NOTHING`,
          [decoded.jti, decoded.id, decoded.exp],
        ).catch(() => {});
      }
    } catch {
      // invalid token — still attempt refresh revoke below
    }
  }
  const { refresh_token } = req.body || {};
  if (refresh_token && typeof refresh_token === 'string' && refresh_token.includes('.')) {
    const [jti] = refresh_token.split('.', 2);
    await query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE jti = $1 AND revoked_at IS NULL`, [jti]).catch(() => {});
  }
  return res.json({ success: true });
}
