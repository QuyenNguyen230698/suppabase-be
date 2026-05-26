-- ============================================================
-- 030_seed_module_defaults.sql
-- B3: Seed role_matrix_defaults cho tất cả (role × module × action)
-- còn thiếu, đặc biệt modules mới (projects, profile).
--
-- Vấn đề gốc: getEffectivePermissionsForUser trả về undefined cho
-- module chưa có seed → guard bị bypass (state undefined ≠ 'full'/'partial'
-- nhưng logic hiện tại cần row tồn tại để enforce đúng).
-- ============================================================

-- ── 1. Thêm modules còn thiếu vào bảng modules ───────────────
INSERT INTO modules (id, name, abbr, color, route, description, sort_order, admin_only)
VALUES
  ('projects', 'Projects',     'PJ', 'violet', '/projects', 'Nhóm conversation + tài liệu theo dự án', 6, FALSE),
  ('profile',  'Hồ sơ cá nhân','PR', 'slate',  '/me',       'Xem và cập nhật thông tin cá nhân',        7, FALSE)
ON CONFLICT (id) DO NOTHING;

-- ── 2. Seed 'none' cho mọi (active_role × non-admin_module × action) ─
-- Chỉ insert row còn thiếu (ON CONFLICT DO NOTHING = idempotent).
-- Admin sau đó vào Matrix UI để cấp quyền thủ công.
INSERT INTO role_matrix_defaults (role_name, module_id, action, state)
SELECT
  r.name       AS role_name,
  m.id         AS module_id,
  a.action     AS action,
  'none'       AS state
FROM roles r
CROSS JOIN modules m
CROSS JOIN (
  VALUES ('view'), ('create'), ('delete'), ('upload')
) AS a(action)
WHERE r.is_active    = TRUE
  AND m.is_active    = TRUE
  AND m.admin_only   = FALSE
ON CONFLICT (role_name, module_id, action) DO NOTHING;

-- ── 3. Đặt quyền hợp lý cho projects theo từng role ─────────
-- Default none từ bước 2 đã insert. Cập nhật lên mức phù hợp:
UPDATE role_matrix_defaults SET state = 'full'
WHERE module_id = 'projects' AND action IN ('view','create','delete','upload')
  AND role_name IN ('super_admin');

UPDATE role_matrix_defaults SET state = 'full'
WHERE module_id = 'projects' AND action IN ('view','create')
  AND role_name IN ('regional_admin','bu_manager','country_user','viewer','vendor');

UPDATE role_matrix_defaults SET state = 'partial'
WHERE module_id = 'projects' AND action = 'delete'
  AND role_name IN ('regional_admin','bu_manager','country_user');

-- viewer và vendor: chỉ view projects
UPDATE role_matrix_defaults SET state = 'none'
WHERE module_id = 'projects' AND action IN ('create','delete','upload')
  AND role_name IN ('viewer','vendor');

-- ── 4. Đặt quyền cho profile (tất cả roles đều tự quản profile) ─
UPDATE role_matrix_defaults SET state = 'full'
WHERE module_id = 'profile' AND action IN ('view','create')
  AND role_name IN ('super_admin','regional_admin','bu_manager','country_user','viewer','vendor');

UPDATE role_matrix_defaults SET state = 'full'
WHERE module_id = 'profile' AND action = 'upload'
  AND role_name IN ('super_admin','regional_admin','bu_manager','country_user','viewer','vendor');

UPDATE role_matrix_defaults SET state = 'none'
WHERE module_id = 'profile' AND action = 'delete'
  AND role_name IN ('super_admin','regional_admin','bu_manager','country_user','viewer','vendor');
