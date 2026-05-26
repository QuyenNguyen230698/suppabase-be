-- ============================================================
-- 003_roles.sql — Bảng roles linh hoạt + migrate user_node_roles
-- ============================================================

-- ── 1. Bảng roles ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roles (
  id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  name          VARCHAR(50)  UNIQUE NOT NULL,   -- 'super_admin', 'vendor', ...
  display_name  VARCHAR(100) NOT NULL,           -- 'Super Admin', 'Vendor'
  description   TEXT,
  level         SMALLINT NOT NULL DEFAULT 99,    -- 1 = cao nhất, 99 = thấp nhất
  is_system     BOOLEAN NOT NULL DEFAULT FALSE,  -- role hệ thống, không được xóa
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── 2. Seed 6 roles mặc định ──────────────────────────────────
INSERT INTO roles (name, display_name, description, level, is_system) VALUES
  ('super_admin',    'Super Admin',    'Toàn quyền hệ thống, quản lý tất cả tổ chức và người dùng', 1,  TRUE),
  ('regional_admin', 'Regional Admin', 'Quản lý một hoặc nhiều khu vực / BU được phân quyền',       2,  TRUE),
  ('bu_manager',     'BU Manager',     'Quản lý nội bộ một Business Unit cụ thể',                   3,  TRUE),
  ('country_user',   'Country User',   'Người dùng cấp quốc gia, thao tác theo phạm vi quốc gia',   4,  TRUE),
  ('viewer',         'Viewer',         'Chỉ xem, không thể tạo hoặc chỉnh sửa dữ liệu',            5,  TRUE),
  ('vendor',         'Vendor',         'Đối tác / nhà cung cấp bên ngoài, quyền truy cập hạn chế', 6,  TRUE)
ON CONFLICT (name) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description  = EXCLUDED.description,
      level        = EXCLUDED.level,
      is_system    = EXCLUDED.is_system,
      updated_at   = NOW();

-- ── 3. Thêm cột role_id vào user_node_roles (nếu chưa có) ───
ALTER TABLE user_node_roles
  ADD COLUMN IF NOT EXISTS role_id UUID REFERENCES roles(id);

-- ── 4. Populate role_id từ cột text role (nếu cột đó vẫn còn) ─
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_node_roles' AND column_name = 'role'
  ) THEN
    UPDATE user_node_roles unr
    SET role_id = r.id
    FROM roles r
    WHERE r.name = unr.role
      AND unr.role_id IS NULL;

    -- Drop cột text role cũ
    ALTER TABLE user_node_roles DROP COLUMN IF EXISTS role;
  END IF;
END $$;

-- ── 5. Đảm bảo NOT NULL sau khi migrate ──────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM user_node_roles WHERE role_id IS NULL
  ) THEN
    ALTER TABLE user_node_roles
      ALTER COLUMN role_id SET NOT NULL;
  END IF;
END $$;

-- ── 6. Index ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_unr_role_id ON user_node_roles(role_id);
CREATE INDEX IF NOT EXISTS idx_roles_level  ON roles(level);
