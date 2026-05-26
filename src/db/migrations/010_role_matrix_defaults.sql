-- ============================================================
-- 010_role_matrix_defaults.sql
-- Đưa ROLE_MATRIX hardcoded ra DB. Bảng này lưu permission mặc định
-- theo (role_name, module_id, action). Override-table giữ nguyên ý nghĩa.
-- ============================================================

CREATE TABLE IF NOT EXISTS role_matrix_defaults (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  role_name   VARCHAR(50)  NOT NULL,            -- khớp roles.name
  module_id   VARCHAR(50)  NOT NULL,            -- khớp modules.id
  action      VARCHAR(20)  NOT NULL CHECK (action IN ('view','create','delete','upload')),
  state       VARCHAR(10)  NOT NULL CHECK (state IN ('full','partial','none')),
  updated_at  TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (role_name, module_id, action)
);

CREATE INDEX IF NOT EXISTS idx_rmd_role   ON role_matrix_defaults(role_name);
CREATE INDEX IF NOT EXISTS idx_rmd_module ON role_matrix_defaults(module_id);

-- ── Thêm cờ admin_only vào modules ───────────────────────────
-- Page admin-only được gate dựa vào cờ này, không phải list cứng ở FE/middleware.
ALTER TABLE modules
  ADD COLUMN IF NOT EXISTS admin_only BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE modules SET admin_only = TRUE  WHERE id IN ('permissions', 'api_tokens');
UPDATE modules SET admin_only = FALSE WHERE id NOT IN ('permissions', 'api_tokens');

-- ── Seed defaults (copy từ ROLE_MATRIX trong code) ───────────
-- Mỗi (role, module, action) một row. ON CONFLICT để re-run idempotent.
INSERT INTO role_matrix_defaults (role_name, module_id, action, state) VALUES
  -- super_admin
  ('super_admin','chat','view','full'),       ('super_admin','chat','create','full'),       ('super_admin','chat','delete','full'),       ('super_admin','chat','upload','full'),
  ('super_admin','documents','view','full'),  ('super_admin','documents','create','full'),  ('super_admin','documents','delete','full'),  ('super_admin','documents','upload','full'),
  ('super_admin','api_tokens','view','full'), ('super_admin','api_tokens','create','full'), ('super_admin','api_tokens','delete','full'), ('super_admin','api_tokens','upload','none'),
  ('super_admin','permissions','view','full'),('super_admin','permissions','create','full'),('super_admin','permissions','delete','full'),('super_admin','permissions','upload','none'),
  ('super_admin','pro_plan','view','full'),   ('super_admin','pro_plan','create','full'),   ('super_admin','pro_plan','delete','full'),   ('super_admin','pro_plan','upload','full'),

  -- regional_admin
  ('regional_admin','chat','view','full'),       ('regional_admin','chat','create','full'),       ('regional_admin','chat','delete','partial'),    ('regional_admin','chat','upload','full'),
  ('regional_admin','documents','view','full'),  ('regional_admin','documents','create','partial'),('regional_admin','documents','delete','none'), ('regional_admin','documents','upload','partial'),
  ('regional_admin','api_tokens','view','full'), ('regional_admin','api_tokens','create','full'), ('regional_admin','api_tokens','delete','none'), ('regional_admin','api_tokens','upload','none'),
  ('regional_admin','permissions','view','full'),('regional_admin','permissions','create','none'),('regional_admin','permissions','delete','none'),('regional_admin','permissions','upload','none'),
  ('regional_admin','pro_plan','view','full'),   ('regional_admin','pro_plan','create','full'),   ('regional_admin','pro_plan','delete','partial'),('regional_admin','pro_plan','upload','full'),

  -- bu_manager
  ('bu_manager','chat','view','full'),         ('bu_manager','chat','create','full'),         ('bu_manager','chat','delete','partial'),    ('bu_manager','chat','upload','full'),
  ('bu_manager','documents','view','partial'), ('bu_manager','documents','create','partial'), ('bu_manager','documents','delete','none'),  ('bu_manager','documents','upload','partial'),
  ('bu_manager','api_tokens','view','none'),   ('bu_manager','api_tokens','create','none'),   ('bu_manager','api_tokens','delete','none'), ('bu_manager','api_tokens','upload','none'),
  ('bu_manager','permissions','view','none'),  ('bu_manager','permissions','create','none'),  ('bu_manager','permissions','delete','none'),('bu_manager','permissions','upload','none'),
  ('bu_manager','pro_plan','view','none'),     ('bu_manager','pro_plan','create','none'),     ('bu_manager','pro_plan','delete','none'),   ('bu_manager','pro_plan','upload','none'),

  -- country_user
  ('country_user','chat','view','full'),         ('country_user','chat','create','full'),         ('country_user','chat','delete','partial'),  ('country_user','chat','upload','full'),
  ('country_user','documents','view','partial'), ('country_user','documents','create','none'),    ('country_user','documents','delete','none'),('country_user','documents','upload','none'),
  ('country_user','api_tokens','view','none'),   ('country_user','api_tokens','create','none'),   ('country_user','api_tokens','delete','none'),('country_user','api_tokens','upload','none'),
  ('country_user','permissions','view','none'),  ('country_user','permissions','create','none'),  ('country_user','permissions','delete','none'),('country_user','permissions','upload','none'),
  ('country_user','pro_plan','view','none'),     ('country_user','pro_plan','create','none'),     ('country_user','pro_plan','delete','none'), ('country_user','pro_plan','upload','none'),

  -- viewer
  ('viewer','chat','view','full'),         ('viewer','chat','create','full'),         ('viewer','chat','delete','none'),  ('viewer','chat','upload','partial'),
  ('viewer','documents','view','partial'), ('viewer','documents','create','none'),    ('viewer','documents','delete','none'),('viewer','documents','upload','none'),
  ('viewer','api_tokens','view','none'),   ('viewer','api_tokens','create','none'),   ('viewer','api_tokens','delete','none'),('viewer','api_tokens','upload','none'),
  ('viewer','permissions','view','none'),  ('viewer','permissions','create','none'),  ('viewer','permissions','delete','none'),('viewer','permissions','upload','none'),
  ('viewer','pro_plan','view','none'),     ('viewer','pro_plan','create','none'),     ('viewer','pro_plan','delete','none'),('viewer','pro_plan','upload','none'),

  -- vendor
  ('vendor','chat','view','full'),         ('vendor','chat','create','full'),         ('vendor','chat','delete','none'),  ('vendor','chat','upload','none'),
  ('vendor','documents','view','partial'), ('vendor','documents','create','partial'), ('vendor','documents','delete','none'),('vendor','documents','upload','full'),
  ('vendor','api_tokens','view','none'),   ('vendor','api_tokens','create','none'),   ('vendor','api_tokens','delete','none'),('vendor','api_tokens','upload','none'),
  ('vendor','permissions','view','none'),  ('vendor','permissions','create','none'),  ('vendor','permissions','delete','none'),('vendor','permissions','upload','none'),
  ('vendor','pro_plan','view','none'),     ('vendor','pro_plan','create','none'),     ('vendor','pro_plan','delete','none'),('vendor','pro_plan','upload','none')
ON CONFLICT (role_name, module_id, action) DO NOTHING;
