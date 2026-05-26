-- ============================================================
-- 013_drop_edit_action.sql
-- App không có 'edit' flow → bỏ action 'edit' khỏi CHECK constraints
-- để tránh dữ liệu rác. Xoá data 'edit' đã tồn tại (nếu có).
-- ============================================================

DELETE FROM role_matrix_overrides    WHERE action = 'edit';
DELETE FROM node_permission_overrides WHERE action = 'edit';

-- node_permission_overrides
ALTER TABLE node_permission_overrides
  DROP CONSTRAINT IF EXISTS node_permission_overrides_action_check;
ALTER TABLE node_permission_overrides
  ADD CONSTRAINT node_permission_overrides_action_check
  CHECK (action IN ('view','create','delete','upload'));

-- role_matrix_overrides
ALTER TABLE role_matrix_overrides
  DROP CONSTRAINT IF EXISTS role_matrix_overrides_action_check;
ALTER TABLE role_matrix_overrides
  ADD CONSTRAINT role_matrix_overrides_action_check
  CHECK (action IN ('view','create','delete','upload'));
