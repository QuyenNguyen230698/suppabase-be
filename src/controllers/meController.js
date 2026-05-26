// Self-service endpoints for the authenticated user.
//   GET    /api/me                    → profile
//   PATCH  /api/me                    → update editable profile fields
//   POST   /api/me/password           → change own password
//   POST   /api/me/avatar             → upload avatar (multipart, image)
//   DELETE /api/me/avatar             → clear avatar
//   GET    /api/me/team               → users where manager_id = me
//   GET    /api/me/sessions           → (placeholder) recent logins
//   PATCH  /api/me/preferred-model    → save preferred model name

import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { query } from '../db/index.js';
import { sendError } from '../i18n/messages.js';
import { uploadToR2, deleteFromR2, r2PublicUrl } from '../services/r2Service.js';

const PROFILE_FIELDS = [
  'id','username','email','full_name','display_name','avatar_url','phone',
  'employee_id','department','job_title','manager_id','hire_date','contract_type',
  'country_code','timezone','language',
  'last_login_at','login_count','password_changed_at','must_change_password',
  'created_at','updated_at',
];

// Editable fields a user may change for themselves.
const EDITABLE_FIELDS = new Set([
  'full_name','display_name','phone','country_code','timezone','language',
]);

// Force-change password after this age (env override)
const PASSWORD_MAX_AGE_DAYS = parseInt(process.env.PASSWORD_MAX_AGE_DAYS || '90', 10);

// Avatar size limit (bytes); browsers will accept anywhere from a few KB to ~200KB.
const AVATAR_MAX_BYTES = 256 * 1024;

// ── GET /api/me ──────────────────────────────────────────────
export async function getMe(req, res) {
  const { rows } = await query(
    `SELECT ${PROFILE_FIELDS.map(f => `u.${f}`).join(', ')},
            (SELECT row_to_json(m) FROM (
               SELECT id, username, full_name, display_name, email FROM users WHERE id = u.manager_id
             ) m) AS manager
       FROM users u WHERE u.id = $1`,
    [req.user.id]
  );
  if (!rows.length) return sendError(res, 404, 'ERR_USER_NOT_FOUND');

  const me = rows[0];
  me.password_age_days = me.password_changed_at
    ? Math.floor((Date.now() - new Date(me.password_changed_at).getTime()) / 86400000)
    : null;
  me.password_must_change_soon =
    me.password_age_days !== null && me.password_age_days >= PASSWORD_MAX_AGE_DAYS - 7;
  me.password_must_change = me.must_change_password
    || (me.password_age_days !== null && me.password_age_days >= PASSWORD_MAX_AGE_DAYS);

  res.json(me);
}

// ── PATCH /api/me ────────────────────────────────────────────
export async function updateMe(req, res) {
  const sets = [];
  const params = [req.user.id];
  let i = 2;

  for (const f of Object.keys(req.body || {})) {
    if (!EDITABLE_FIELDS.has(f)) continue;
    params.push(req.body[f] ?? null);
    sets.push(`${f} = $${i++}`);
  }
  if (!sets.length) return sendError(res, 400, 'ERR_VALIDATION');
  sets.push('updated_at = NOW()');

  const { rows } = await query(
    `UPDATE users SET ${sets.join(', ')}
       WHERE id = $1
       RETURNING ${PROFILE_FIELDS.join(', ')}`,
    params
  );
  res.json(rows[0]);
}

// ── POST /api/me/password ────────────────────────────────────
export async function changePassword(req, res) {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return sendError(res, 400, 'ERR_FIELD_REQUIRED');
  if (new_password.length < 8) {
    return res.status(400).json({
      error: 'Password must be at least 8 characters',
      code: 'ERR_VALIDATION',
    });
  }

  const { rows } = await query(
    `SELECT id, password_hash FROM users WHERE id = $1`,
    [req.user.id]
  );
  if (!rows.length) return sendError(res, 404, 'ERR_USER_NOT_FOUND');

  const ok = await bcrypt.compare(current_password, rows[0].password_hash);
  if (!ok) return sendError(res, 401, 'ERR_INVALID_CREDENTIALS');

  const hash = await bcrypt.hash(new_password, 10);
  await query(
    `UPDATE users
        SET password_hash = $1,
            password_changed_at = NOW(),
            must_change_password = FALSE,
            permission_version = permission_version + 1,
            updated_at = NOW()
      WHERE id = $2`,
    [hash, req.user.id]
  );
  res.json({ ok: true });
}

// ── POST /api/me/avatar ──────────────────────────────────────
// Multipart image. Uploaded to Cloudflare R2 bucket: suppabase/avatar/<uuid>.<ext>
export async function uploadAvatar(req, res) {
  const file = req.file;
  if (!file) return sendError(res, 400, 'ERR_FIELD_REQUIRED');
  if (!file.mimetype.startsWith('image/')) {
    return res.status(400).json({ error: 'Expected image', code: 'ERR_VALIDATION' });
  }
  if (file.size > AVATAR_MAX_BYTES) {
    return res.status(400).json({
      error: `Avatar must be ≤ ${Math.floor(AVATAR_MAX_BYTES / 1024)}KB`,
      code: 'ERR_VALIDATION',
    });
  }

  // Delete previous avatar from R2 if it was stored there
  const { rows: prev } = await query(`SELECT avatar_url FROM users WHERE id = $1`, [req.user.id]);
  const oldUrl = prev[0]?.avatar_url || '';
  if (oldUrl && oldUrl.includes('/avatar/')) {
    const oldKey = 'avatar/' + oldUrl.split('/avatar/')[1];
    await deleteFromR2(oldKey);
  }

  const ext = file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
  const key = `avatar/${randomUUID()}.${ext}`;

  await uploadToR2(key, file.buffer, file.mimetype);

  const avatarUrl = r2PublicUrl(key);
  await query(`UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2`,
    [avatarUrl, req.user.id]);
  res.json({ avatar_url: avatarUrl });
}

// ── DELETE /api/me/avatar ────────────────────────────────────
export async function deleteAvatar(req, res) {
  const { rows } = await query(`SELECT avatar_url FROM users WHERE id = $1`, [req.user.id]);
  const oldUrl = rows[0]?.avatar_url || '';
  if (oldUrl && oldUrl.includes('/avatar/')) {
    const oldKey = 'avatar/' + oldUrl.split('/avatar/')[1];
    await deleteFromR2(oldKey);
  }
  await query(`UPDATE users SET avatar_url = NULL, updated_at = NOW() WHERE id = $1`,
    [req.user.id]);
  res.json({ ok: true });
}

// ── GET /api/me/team ─────────────────────────────────────────
// Users whose manager_id = me (direct reports).
export async function getMyTeam(req, res) {
  const { rows } = await query(
    `SELECT id, username, email, full_name, display_name, avatar_url,
            job_title, department, country_code, is_active, last_login_at,
            contract_type, hire_date
       FROM users
      WHERE manager_id = $1
      ORDER BY full_name NULLS LAST, username`,
    [req.user.id]
  );
  res.json({ items: rows });
}

// ── PATCH /api/me/preferred-model ────────────────────────────
// Stored on user_node_roles? No — we keep it client-side via localStorage already.
// This endpoint just gives FE a server-confirmed echo for future sync use.
export async function setPreferredModel(req, res) {
  const model = (req.body?.model || '').trim();
  if (!model) return sendError(res, 400, 'ERR_FIELD_REQUIRED');
  // For now we persist into 'notes' field's JSON if you want; here just echo.
  // (Schema for user prefs is intentionally deferred until we have more prefs.)
  res.json({ ok: true, model });
}
