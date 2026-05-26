-- ============================================================
-- 011_permission_version.sql
-- Thêm cột permission_version để FE biết khi cache stale.
-- JWT carry version cũ → middleware so sánh; lệch → 401 STALE_PERMISSIONS.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS permission_version INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_users_permission_version
  ON users(permission_version);

-- Bump version mọi user hiện có để JWT cũ sẽ bị invalidate sau deploy
-- (an toàn — chỉ ép user re-fetch /me, không buộc đăng nhập lại).
UPDATE users SET permission_version = permission_version + 1;
