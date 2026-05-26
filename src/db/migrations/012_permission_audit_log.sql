-- ============================================================
-- 012_permission_audit_log.sql
-- Audit trail cho mọi thay đổi liên quan đến phân quyền:
--   - role_matrix_overrides (role × module × action)
--   - node_permission_overrides (node × module × action)
--   - user_node_roles (assign / remove)
--   - roles (create / update / deactivate) — future
--   - modules (create / update / delete)
-- ============================================================

CREATE TABLE IF NOT EXISTS permission_audit_log (
  id              BIGSERIAL PRIMARY KEY,
  actor_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  action_type     VARCHAR(40) NOT NULL,        -- 'assign_user','remove_user','set_role_matrix',
                                                -- 'set_node_override','delete_node_override',
                                                -- 'create_module','update_module','delete_module'
  target_type     VARCHAR(20),                  -- 'user' | 'node' | 'role' | 'module'
  target_id       VARCHAR(255),                 -- UUID or string id (modules.id)
  module_id       VARCHAR(50),                  -- module liên quan (nếu có)
  action_name     VARCHAR(20),                  -- view|create|delete|upload (nếu có)
  before_state    JSONB,                        -- snapshot trước thay đổi
  after_state     JSONB,                        -- snapshot sau thay đổi
  meta            JSONB,                        -- ghi chú thêm (ip, ua, reason…)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_actor      ON permission_audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_target     ON permission_audit_log(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_created    ON permission_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action     ON permission_audit_log(action_type);
