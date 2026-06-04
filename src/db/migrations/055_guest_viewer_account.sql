-- ============================================================
-- 055_guest_viewer_account.sql
-- Seed a shared "guest" account for visitors to try the workspace.
--
--   username: guest-suppabase
--   email:    guest@suppabase.local
--   password: guest@2026   (bcrypt hash below, cost 10)
--   role:     viewer (read-only) on the root org node "PEB Group (Europe)"
--
-- The login flow (authController.login) looks users up in the `users` table and
-- resolves the top role via user_node_roles → roles, so a row in each is enough.
-- Idempotent: ON CONFLICT DO NOTHING / UPDATE so re-running is safe.
-- To change the password, regenerate the hash:
--   node --input-type=module -e "import bcrypt from 'bcrypt'; console.log(await bcrypt.hash('guest@2026', 10));"
-- ============================================================

-- 1. The guest user. Fixed UUID so the row is stable across re-runs.
INSERT INTO users (id, username, email, password_hash, full_name, is_active)
VALUES (
  '00000000-0000-0000-0000-0000000a0001'::uuid,
  'guest-suppabase',
  'guest@suppabase.local',
  '$2b$10$ZRSwA59ASgWLLsSAQ7vGmu8UmxqY.G/QW0LQtZFZKL5gL9ujTXwju',
  'Guest (read-only)',
  TRUE
)
ON CONFLICT (username) DO UPDATE
  SET password_hash = EXCLUDED.password_hash,
      email         = EXCLUDED.email,
      full_name     = EXCLUDED.full_name,
      is_active     = TRUE,
      updated_at    = NOW();

-- 2. Grant the viewer role on the root org node. Resolve both ids by lookup so
--    this works whether or not the user already existed. NOTE: the legacy text
--    `role` column was dropped in 003_roles.sql — assignments are by role_id.
INSERT INTO user_node_roles (user_id, node_id, role_id)
SELECT u.id,
       '00000000-0000-0000-0000-000000000001'::uuid,   -- PEB Group (Europe) root
       r.id
FROM users u
CROSS JOIN roles r
WHERE u.username = 'guest-suppabase'
  AND r.name = 'viewer'
ON CONFLICT (user_id, node_id) DO UPDATE
  SET role_id = EXCLUDED.role_id;
