-- ============================================================
-- 035_qa_audit_module.sql
-- Register QA Audit as a sidebar module + permission matrix.
-- ============================================================

INSERT INTO modules (id, name, abbr, color, route, admin_only, icon, sort_order)
VALUES (
  'qa_audit',
  'QA Audit',
  'QA',
  'amber',
  '/admin/qa-audit',
  TRUE,
  '<path d="M9 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-4"/><polyline points="9 11 9 5 15 5 15 11"/><circle cx="12" cy="16" r="1"/>',
  91
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_matrix_defaults (role_name, module_id, action, state) VALUES
  ('super_admin',     'qa_audit', 'view',   'full'),
  ('super_admin',     'qa_audit', 'create', 'full'),
  ('super_admin',     'qa_audit', 'delete', 'full'),
  ('regional_admin',  'qa_audit', 'view',   'full'),
  ('regional_admin',  'qa_audit', 'create', 'none'),
  ('regional_admin',  'qa_audit', 'delete', 'none'),
  ('bu_manager',      'qa_audit', 'view',   'none'),
  ('country_user',    'qa_audit', 'view',   'none'),
  ('viewer',          'qa_audit', 'view',   'none'),
  ('vendor',          'qa_audit', 'view',   'none')
ON CONFLICT (role_name, module_id, action) DO NOTHING;
