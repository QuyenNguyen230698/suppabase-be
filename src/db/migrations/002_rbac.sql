-- ============================================================
-- 002_rbac.sql — Role-Based Access Control (PEBsteel Global)
-- ============================================================

-- ── 1. Org nodes (tập đoàn / HQ / BU / nhà máy / quốc gia) ──
CREATE TABLE IF NOT EXISTS org_nodes (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  parent_id   UUID REFERENCES org_nodes(id) ON DELETE RESTRICT,
  label       VARCHAR(120) NOT NULL,
  sub         VARCHAR(255),
  type        VARCHAR(20) NOT NULL CHECK (type IN ('group','hq','bu','fab','country')),
  depth       SMALLINT NOT NULL DEFAULT 0,
  path        TEXT,                   -- breadcrumb, e.g. "PEB Group > HQ > Sales BU"
  sort_order  SMALLINT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── 2. Users ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id           UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  username     VARCHAR(80) UNIQUE NOT NULL,
  email        VARCHAR(120) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name    VARCHAR(120),
  is_active    BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3. User ↔ Org node assignments ──────────────────────────
CREATE TABLE IF NOT EXISTS user_node_roles (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id     UUID NOT NULL REFERENCES org_nodes(id) ON DELETE CASCADE,
  role        VARCHAR(30) NOT NULL CHECK (role IN (
                'super_admin','regional_admin','bu_manager','country_user','viewer'
              )),
  country     VARCHAR(80),            -- scoping hint, e.g. "Vietnam"
  granted_by  UUID REFERENCES users(id),
  granted_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, node_id)
);

-- ── 4. Node-level permission overrides ──────────────────────
--    Stores explicit overrides per (node, module, action).
--    If no row exists → fallback to role matrix default.
CREATE TABLE IF NOT EXISTS node_permission_overrides (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  node_id     UUID NOT NULL REFERENCES org_nodes(id) ON DELETE CASCADE,
  module_id   VARCHAR(30) NOT NULL,   -- reports|users|orders|settings|factory|crm|documents|chat
  action      VARCHAR(20) NOT NULL CHECK (action IN ('view','create','edit','delete','upload')),
  state       VARCHAR(10) NOT NULL CHECK (state IN ('full','partial','none')),
  updated_by  UUID REFERENCES users(id),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (node_id, module_id, action)
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_org_nodes_parent   ON org_nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_org_nodes_type     ON org_nodes(type);
CREATE INDEX IF NOT EXISTS idx_unr_user           ON user_node_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_unr_node           ON user_node_roles(node_id);
CREATE INDEX IF NOT EXISTS idx_npo_node           ON node_permission_overrides(node_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ── Seed: root org nodes ─────────────────────────────────────
INSERT INTO org_nodes (id, parent_id, label, sub, type, depth, path, sort_order)
VALUES
  ('00000000-0000-0000-0000-000000000001', NULL,
   'PEB Group (Europe)', 'Nippon Steel, Okaya & Co.', 'group', 0, 'PEB Group', 1),

  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   'Pebsteel Global HQ', 'Vietnam · CEO / Ban HĐTV · HCM City', 'hq', 1, 'PEB Group > HQ Vietnam', 1),

  ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000002',
   'Fabrication BU', '6 nhà máy VN + 1 Myanmar', 'bu', 2, 'PEB Group > HQ > Fabrication BU', 1),

  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000002',
   'Sales & Export BU', '12 văn phòng · 50+ quốc gia', 'bu', 2, 'PEB Group > HQ > Sales BU', 2),

  ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000002',
   'Engineering BU', 'Thiết kế · Kỹ thuật · QA/QC', 'bu', 2, 'PEB Group > HQ > Engineering BU', 3),

  ('00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000010',
   'Nhà máy VN 1', 'Bình Dương', 'fab', 3, 'PEB Group > HQ > Fabrication BU > VN-1', 1),

  ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000010',
   'Nhà máy VN 2', 'Long An', 'fab', 3, 'PEB Group > HQ > Fabrication BU > VN-2', 2),

  ('00000000-0000-0000-0000-000000000022', '00000000-0000-0000-0000-000000000010',
   'Nhà máy VN 3', 'Đồng Nai', 'fab', 3, 'PEB Group > HQ > Fabrication BU > VN-3', 3),

  ('00000000-0000-0000-0000-000000000023', '00000000-0000-0000-0000-000000000010',
   'Myanmar Plant', 'Yangon', 'fab', 3, 'PEB Group > HQ > Fabrication BU > Myanmar', 4),

  ('00000000-0000-0000-0000-000000000030', '00000000-0000-0000-0000-000000000011',
   'Cambodia Office', 'Phnom Penh · Sales', 'country', 3, 'PEB Group > HQ > Sales BU > Cambodia', 1),

  ('00000000-0000-0000-0000-000000000031', '00000000-0000-0000-0000-000000000011',
   'Thailand Office', 'Bangkok · Sales', 'country', 3, 'PEB Group > HQ > Sales BU > Thailand', 2),

  ('00000000-0000-0000-0000-000000000032', '00000000-0000-0000-0000-000000000011',
   'Philippines Office', 'Manila · Sales', 'country', 3, 'PEB Group > HQ > Sales BU > Philippines', 3),

  ('00000000-0000-0000-0000-000000000033', '00000000-0000-0000-0000-000000000011',
   'Indonesia Office', 'Jakarta · Sales', 'country', 3, 'PEB Group > HQ > Sales BU > Indonesia', 4),

  ('00000000-0000-0000-0000-000000000040', '00000000-0000-0000-0000-000000000012',
   'Design Team', '1400+ engineers', 'bu', 3, 'PEB Group > HQ > Engineering BU > Design', 1),

  ('00000000-0000-0000-0000-000000000041', '00000000-0000-0000-0000-000000000012',
   'QA / QC Team', 'ISO 9001+', 'bu', 3, 'PEB Group > HQ > Engineering BU > QA/QC', 2)

ON CONFLICT (id) DO NOTHING;
