-- ============================================================
-- 033_agent_templates_module.sql
-- Register Agent Templates as a sidebar module + grant view to admin roles.
-- ============================================================

INSERT INTO modules (id, name, abbr, color, route, admin_only, icon, sort_order)
VALUES (
  'agent_templates',
  'Agent Templates',
  'AT',
  'purple',
  '/admin/agent-templates',
  TRUE,
  '<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/>',
  90
)
ON CONFLICT (id) DO NOTHING;

-- Seed default permission matrix: only admin-level roles can view by default.
INSERT INTO role_matrix_defaults (role_name, module_id, action, state) VALUES
  ('super_admin',     'agent_templates', 'view',   'full'),
  ('super_admin',     'agent_templates', 'create', 'full'),
  ('super_admin',     'agent_templates', 'delete', 'full'),
  ('regional_admin',  'agent_templates', 'view',   'full'),
  ('regional_admin',  'agent_templates', 'create', 'full'),
  ('regional_admin',  'agent_templates', 'delete', 'none'),
  ('bu_manager',      'agent_templates', 'view',   'none'),
  ('country_user',    'agent_templates', 'view',   'none'),
  ('viewer',          'agent_templates', 'view',   'none'),
  ('vendor',          'agent_templates', 'view',   'none')
ON CONFLICT (role_name, module_id, action) DO NOTHING;
