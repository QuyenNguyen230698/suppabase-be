-- ============================================================
-- 006_role_matrix_overrides.sql
-- Stores admin-edited overrides to the default role×module×action matrix.
-- If no row exists for a (role, module, action) → code falls back to
-- the hardcoded ROLE_MATRIX default.
-- ============================================================

CREATE TABLE IF NOT EXISTS role_matrix_overrides (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  role_id     VARCHAR(30) NOT NULL,   -- super_admin|regional_admin|bu_manager|country_user|viewer
  module_id   VARCHAR(30) NOT NULL,
  action      VARCHAR(20) NOT NULL CHECK (action IN ('view','create','edit','delete','upload')),
  state       VARCHAR(10) NOT NULL CHECK (state IN ('full','partial','none')),
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (role_id, module_id, action)
);

CREATE INDEX IF NOT EXISTS idx_rmo_role ON role_matrix_overrides(role_id);
