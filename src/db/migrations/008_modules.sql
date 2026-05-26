-- ============================================================
-- 008_modules.sql — Bảng modules: định nghĩa các feature/page
-- Mỗi module là một tính năng trong app có thể gắn quyền.
-- ============================================================

CREATE TABLE IF NOT EXISTS modules (
  id          VARCHAR(50)  PRIMARY KEY,          -- 'chat', 'documents', 'api_tokens', 'permissions'
  name        VARCHAR(120) NOT NULL,              -- 'AI Chat'
  abbr        VARCHAR(4)   NOT NULL,              -- 'AI'  (hiển thị badge)
  color       VARCHAR(20)  NOT NULL DEFAULT 'gray',
  route       VARCHAR(255),                       -- '/chat'  (link FE page, NULL = không có page riêng)
  icon        TEXT,                               -- tên icon hoặc SVG inline
  description TEXT,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order  SMALLINT     NOT NULL DEFAULT 0,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_modules_active ON modules(is_active);
CREATE INDEX IF NOT EXISTS idx_modules_sort   ON modules(sort_order);

-- ── Seed 4 modules hiện tại ───────────────────────────────────
INSERT INTO modules (id, name, abbr, color, route, description, sort_order) VALUES
  ('chat',        'AI Chat',                 'AI', 'indigo',  '/chat',        'Giao diện chat với AI (Ollama / LLM)',           1),
  ('documents',   'Tài liệu / Documents',    'DC', 'amber',   NULL,           'Quản lý và tìm kiếm tài liệu đính kèm',          2),
  ('api_tokens',  'API Tokens',              'TK', 'pink',    '/admin',       'Quản lý API tokens cho tích hợp bên ngoài',      3),
  ('permissions', 'Phân quyền',              'PM', 'cyan',    '/permissions', 'Phân quyền người dùng theo cơ cấu tổ chức',      4)
ON CONFLICT (id) DO UPDATE
  SET name        = EXCLUDED.name,
      abbr        = EXCLUDED.abbr,
      color       = EXCLUDED.color,
      route       = EXCLUDED.route,
      description = EXCLUDED.description,
      sort_order  = EXCLUDED.sort_order,
      updated_at  = NOW();

-- ── Thêm FK ràng buộc module_id → modules.id ─────────────────
-- role_matrix_overrides
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_rmo_module'
  ) THEN
    -- Xóa các rows orphan trước khi thêm FK
    DELETE FROM role_matrix_overrides
    WHERE module_id NOT IN (SELECT id FROM modules);

    ALTER TABLE role_matrix_overrides
      ADD CONSTRAINT fk_rmo_module
      FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE;
  END IF;
END$$;

-- node_permission_overrides
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_npo_module'
  ) THEN
    DELETE FROM node_permission_overrides
    WHERE module_id NOT IN (SELECT id FROM modules);

    ALTER TABLE node_permission_overrides
      ADD CONSTRAINT fk_npo_module
      FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE;
  END IF;
END$$;
