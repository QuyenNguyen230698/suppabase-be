-- ============================================================
-- 004_user_profile.sql — Mở rộng bảng users cho tập đoàn
-- ============================================================

-- ── 1. Identity & Contact ─────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS display_name  VARCHAR(80),          -- tên hiển thị ngắn / nickname
  ADD COLUMN IF NOT EXISTS avatar_url    TEXT,                  -- URL ảnh đại diện
  ADD COLUMN IF NOT EXISTS phone         VARCHAR(30);           -- số điện thoại (E.164 hoặc local)

-- ── 2. Organizational ────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS employee_id    VARCHAR(40) UNIQUE,   -- mã nhân viên, VD: PEB-VN-001
  ADD COLUMN IF NOT EXISTS department     VARCHAR(120),          -- phòng ban: "Engineering", "Sales"
  ADD COLUMN IF NOT EXISTS job_title      VARCHAR(120),          -- chức danh: "Senior Engineer"
  ADD COLUMN IF NOT EXISTS manager_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS hire_date      DATE,                  -- ngày bắt đầu làm việc
  ADD COLUMN IF NOT EXISTS contract_type  VARCHAR(20)
                              CHECK (contract_type IN ('full_time','part_time','contractor','intern'));

-- ── 3. Locale & Regional ─────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS country_code  VARCHAR(5),            -- VN, KH, TH, PH, ID, MM, ...
  ADD COLUMN IF NOT EXISTS timezone      VARCHAR(60),            -- Asia/Ho_Chi_Minh, Asia/Bangkok
  ADD COLUMN IF NOT EXISTS language      VARCHAR(10);            -- vi, en, km, th, id, my

-- ── 4. Account Security ──────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_login_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS login_count            INTEGER   NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_attempts        SMALLINT  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until           TIMESTAMPTZ,       -- NULL = không bị khóa
  ADD COLUMN IF NOT EXISTS password_changed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS must_change_password   BOOLEAN   NOT NULL DEFAULT FALSE;

-- ── 5. Metadata ───────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS notes       TEXT;                     -- ghi chú nội bộ, chỉ admin thấy

-- ── 6. Indexes ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_country_code  ON users(country_code);
CREATE INDEX IF NOT EXISTS idx_users_manager_id    ON users(manager_id);
CREATE INDEX IF NOT EXISTS idx_users_employee_id   ON users(employee_id);
CREATE INDEX IF NOT EXISTS idx_users_is_active     ON users(is_active);
