#!/usr/bin/env node
/**
 * Seed script: tạo user mẫu lấp đầy cơ cấu tổ chức PEBsteel Global
 * Chạy: node scripts/seed-sample-users.js
 *
 * Cơ cấu org nodes (từ 002_rbac.sql):
 *   00..0001  PEB Group (Europe)         — group,   depth 0
 *   00..0002  Pebsteel Global HQ         — hq,      depth 1
 *   00..0010  Fabrication BU             — bu,      depth 2
 *   00..0011  Sales & Export BU          — bu,      depth 2
 *   00..0012  Engineering BU             — bu,      depth 2
 *   00..0020  Nhà máy VN 1 (Bình Dương)  — fab,     depth 3
 *   00..0021  Nhà máy VN 2 (Long An)     — fab,     depth 3
 *   00..0022  Nhà máy VN 3 (Đồng Nai)   — fab,     depth 3
 *   00..0023  Myanmar Plant              — fab,     depth 3
 *   00..0030  Cambodia Office            — country, depth 3
 *   00..0031  Thailand Office            — country, depth 3
 *   00..0032  Philippines Office         — country, depth 3
 *   00..0033  Indonesia Office           — country, depth 3
 *   00..0040  Design Team                — bu,      depth 3
 *   00..0041  QA / QC Team               — bu,      depth 3
 */
import 'dotenv/config';
import bcrypt from 'bcrypt';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const PASSWORD_HASH = await bcrypt.hash('123456', 10);

// ── Định nghĩa user mẫu ───────────────────────────────────────
// Mỗi entry: { username, email, full_name, job_title, department, country_code, timezone, language, contract_type, assignments: [{ node_id, role, country? }] }

const NODE = {
  ROOT:        '00000000-0000-0000-0000-000000000001',
  HQ:          '00000000-0000-0000-0000-000000000002',
  FAB_BU:      '00000000-0000-0000-0000-000000000010',
  SALES_BU:    '00000000-0000-0000-0000-000000000011',
  ENG_BU:      '00000000-0000-0000-0000-000000000012',
  CORP_BU:     '00000000-0000-0000-0000-000000000013',
  VN1:         '00000000-0000-0000-0000-000000000020',
  VN2:         '00000000-0000-0000-0000-000000000021',
  VN3:         '00000000-0000-0000-0000-000000000022',
  MYANMAR:     '00000000-0000-0000-0000-000000000023',
  VN4:         '00000000-0000-0000-0000-000000000024',
  VN5:         '00000000-0000-0000-0000-000000000025',
  VN6:         '00000000-0000-0000-0000-000000000026',
  INDIA_JV:    '00000000-0000-0000-0000-000000000027',
  CAMBODIA:    '00000000-0000-0000-0000-000000000030',
  THAILAND:    '00000000-0000-0000-0000-000000000031',
  PHIL:        '00000000-0000-0000-0000-000000000032',
  INDO:        '00000000-0000-0000-0000-000000000033',
  MALAYSIA:    '00000000-0000-0000-0000-000000000034',
  PHIL_CEBU:   '00000000-0000-0000-0000-000000000035',
  INDO_MKS:    '00000000-0000-0000-0000-000000000036',
  INDO_SBY:    '00000000-0000-0000-0000-000000000037',
  VN_EXPORT:   '00000000-0000-0000-0000-000000000038',
  DESIGN:      '00000000-0000-0000-0000-000000000040',
  QAQC:        '00000000-0000-0000-0000-000000000041',
  HR:          '00000000-0000-0000-0000-000000000050',
  FINANCE:     '00000000-0000-0000-0000-000000000051',
  IT:          '00000000-0000-0000-0000-000000000052',
  MARKETING:   '00000000-0000-0000-0000-000000000053',
};

const USERS = [
  // ── peb1–peb2: Regional Admin tại HQ ─────────────────────────
  {
    username: 'peb1', email: 'peb1@pebsteel.com',
    full_name: 'Nguyen Van An', display_name: 'Van An',
    job_title: 'Regional Director', department: 'Executive',
    country_code: 'VN', timezone: 'Asia/Ho_Chi_Minh', language: 'vi',
    contract_type: 'full_time', employee_id: 'PEB-HQ-001',
    assignments: [{ node_id: NODE.HQ, role: 'regional_admin' }],
  },
  {
    username: 'peb2', email: 'peb2@pebsteel.com',
    full_name: 'Tran Thi Bich', display_name: 'Thi Bich',
    job_title: 'Regional Manager', department: 'Executive',
    country_code: 'VN', timezone: 'Asia/Ho_Chi_Minh', language: 'vi',
    contract_type: 'full_time', employee_id: 'PEB-HQ-002',
    assignments: [{ node_id: NODE.HQ, role: 'regional_admin' }],
  },

  // ── peb3–peb4: BU Manager tại Fabrication BU ─────────────────
  {
    username: 'peb3', email: 'peb3@pebsteel.com',
    full_name: 'Le Minh Tuan', display_name: 'Minh Tuan',
    job_title: 'Fabrication BU Manager', department: 'Fabrication',
    country_code: 'VN', timezone: 'Asia/Ho_Chi_Minh', language: 'vi',
    contract_type: 'full_time', employee_id: 'PEB-FAB-001',
    assignments: [{ node_id: NODE.FAB_BU, role: 'bu_manager' }],
  },
  {
    username: 'peb4', email: 'peb4@pebsteel.com',
    full_name: 'Pham Quoc Hung', display_name: 'Quoc Hung',
    job_title: 'Production Manager', department: 'Fabrication',
    country_code: 'VN', timezone: 'Asia/Ho_Chi_Minh', language: 'vi',
    contract_type: 'full_time', employee_id: 'PEB-FAB-002',
    assignments: [{ node_id: NODE.FAB_BU, role: 'bu_manager' }],
  },

  // ── peb5–peb6: BU Manager tại Sales & Export BU ──────────────
  {
    username: 'peb5', email: 'peb5@pebsteel.com',
    full_name: 'Hoang Duc Manh', display_name: 'Duc Manh',
    job_title: 'Sales BU Director', department: 'Sales & Export',
    country_code: 'VN', timezone: 'Asia/Ho_Chi_Minh', language: 'vi',
    contract_type: 'full_time', employee_id: 'PEB-SALES-001',
    assignments: [{ node_id: NODE.SALES_BU, role: 'bu_manager' }],
  },
  {
    username: 'peb6', email: 'peb6@pebsteel.com',
    full_name: 'Vo Thi Thu', display_name: 'Thi Thu',
    job_title: 'Export Manager', department: 'Sales & Export',
    country_code: 'VN', timezone: 'Asia/Ho_Chi_Minh', language: 'vi',
    contract_type: 'full_time', employee_id: 'PEB-SALES-002',
    assignments: [{ node_id: NODE.SALES_BU, role: 'bu_manager' }],
  },

  // ── peb7–peb8: BU Manager tại Engineering BU ─────────────────
  {
    username: 'peb7', email: 'peb7@pebsteel.com',
    full_name: 'Nguyen Thanh Long', display_name: 'Thanh Long',
    job_title: 'Engineering Director', department: 'Engineering',
    country_code: 'VN', timezone: 'Asia/Ho_Chi_Minh', language: 'vi',
    contract_type: 'full_time', employee_id: 'PEB-ENG-001',
    assignments: [{ node_id: NODE.ENG_BU, role: 'bu_manager' }],
  },
  {
    username: 'peb8', email: 'peb8@pebsteel.com',
    full_name: 'Do Thi Lan', display_name: 'Thi Lan',
    job_title: 'QA/QC Manager', department: 'Engineering',
    country_code: 'VN', timezone: 'Asia/Ho_Chi_Minh', language: 'vi',
    contract_type: 'full_time', employee_id: 'PEB-ENG-002',
    assignments: [
      { node_id: NODE.ENG_BU, role: 'bu_manager' },
      { node_id: NODE.QAQC,   role: 'bu_manager' },
    ],
  },

  // ── peb9–peb11: Country User tại các nhà máy VN ──────────────
  {
    username: 'peb9', email: 'peb9@pebsteel.com',
    full_name: 'Bui Van Khanh', display_name: 'Van Khanh',
    job_title: 'Plant Supervisor', department: 'Fabrication',
    country_code: 'VN', timezone: 'Asia/Ho_Chi_Minh', language: 'vi',
    contract_type: 'full_time', employee_id: 'PEB-VN1-001',
    assignments: [{ node_id: NODE.VN1, role: 'country_user', country: 'Vietnam' }],
  },
  {
    username: 'peb10', email: 'peb10@pebsteel.com',
    full_name: 'Nguyen Thi Hoa', display_name: 'Thi Hoa',
    job_title: 'Production Lead', department: 'Fabrication',
    country_code: 'VN', timezone: 'Asia/Ho_Chi_Minh', language: 'vi',
    contract_type: 'full_time', employee_id: 'PEB-VN2-001',
    assignments: [{ node_id: NODE.VN2, role: 'country_user', country: 'Vietnam' }],
  },
  {
    username: 'peb11', email: 'peb11@pebsteel.com',
    full_name: 'Tran Van Duc', display_name: 'Van Duc',
    job_title: 'Warehouse Lead', department: 'Fabrication',
    country_code: 'VN', timezone: 'Asia/Ho_Chi_Minh', language: 'vi',
    contract_type: 'full_time', employee_id: 'PEB-VN3-001',
    assignments: [{ node_id: NODE.VN3, role: 'country_user', country: 'Vietnam' }],
  },

  // ── peb12: Country User tại Myanmar Plant ────────────────────
  {
    username: 'peb12', email: 'peb12@pebsteel.com',
    full_name: 'Aung Kyaw Zin', display_name: 'Kyaw Zin',
    job_title: 'Plant Supervisor', department: 'Fabrication',
    country_code: 'MM', timezone: 'Asia/Rangoon', language: 'en',
    contract_type: 'full_time', employee_id: 'PEB-MM-001',
    assignments: [{ node_id: NODE.MYANMAR, role: 'country_user', country: 'Myanmar' }],
  },

  // ── peb13–peb16: Country User tại các văn phòng ASEAN ────────
  {
    username: 'peb13', email: 'peb13@pebsteel.com',
    full_name: 'Sokha Chea', display_name: 'Sokha',
    job_title: 'Country Sales Rep', department: 'Sales & Export',
    country_code: 'KH', timezone: 'Asia/Phnom_Penh', language: 'en',
    contract_type: 'full_time', employee_id: 'PEB-KH-001',
    assignments: [{ node_id: NODE.CAMBODIA, role: 'country_user', country: 'Cambodia' }],
  },
  {
    username: 'peb14', email: 'peb14@pebsteel.com',
    full_name: 'Somchai Raksa', display_name: 'Somchai',
    job_title: 'Country Sales Manager', department: 'Sales & Export',
    country_code: 'TH', timezone: 'Asia/Bangkok', language: 'th',
    contract_type: 'full_time', employee_id: 'PEB-TH-001',
    assignments: [{ node_id: NODE.THAILAND, role: 'country_user', country: 'Thailand' }],
  },
  {
    username: 'peb15', email: 'peb15@pebsteel.com',
    full_name: 'Maria Santos', display_name: 'Maria',
    job_title: 'Business Development', department: 'Sales & Export',
    country_code: 'PH', timezone: 'Asia/Manila', language: 'en',
    contract_type: 'full_time', employee_id: 'PEB-PH-001',
    assignments: [{ node_id: NODE.PHIL, role: 'country_user', country: 'Philippines' }],
  },
  {
    username: 'peb16', email: 'peb16@pebsteel.com',
    full_name: 'Budi Santoso', display_name: 'Budi',
    job_title: 'Country Representative', department: 'Sales & Export',
    country_code: 'ID', timezone: 'Asia/Jakarta', language: 'id',
    contract_type: 'full_time', employee_id: 'PEB-ID-001',
    assignments: [{ node_id: NODE.INDO, role: 'country_user', country: 'Indonesia' }],
  },

  // ── peb17–peb18: Viewer tại Design Team & QA/QC ──────────────
  {
    username: 'peb17', email: 'peb17@pebsteel.com',
    full_name: 'Phan Thi Mai', display_name: 'Thi Mai',
    job_title: 'Senior Engineer', department: 'Engineering',
    country_code: 'VN', timezone: 'Asia/Ho_Chi_Minh', language: 'vi',
    contract_type: 'full_time', employee_id: 'PEB-ENG-010',
    assignments: [{ node_id: NODE.DESIGN, role: 'viewer' }],
  },
  {
    username: 'peb18', email: 'peb18@pebsteel.com',
    full_name: 'Ly Van Cuong', display_name: 'Van Cuong',
    job_title: 'QA Inspector', department: 'Engineering',
    country_code: 'VN', timezone: 'Asia/Ho_Chi_Minh', language: 'vi',
    contract_type: 'full_time', employee_id: 'PEB-ENG-011',
    assignments: [{ node_id: NODE.QAQC, role: 'viewer' }],
  },

  // ── peb19: Vendor (contractor bên ngoài) ─────────────────────
  {
    username: 'peb19', email: 'peb19@vendor.com',
    full_name: 'John Smith', display_name: 'John',
    job_title: 'External Consultant', department: 'Vendor',
    country_code: 'SG', timezone: 'Asia/Singapore', language: 'en',
    contract_type: 'contractor', employee_id: 'PEB-EXT-001',
    assignments: [{ node_id: NODE.HQ, role: 'vendor' }],
  },

  // ── peb20: Multi-node — Sales BU Manager + Cambodia ──────────
  {
    username: 'peb20', email: 'peb20@pebsteel.com',
    full_name: 'Nguyen Bao Chau', display_name: 'Bao Chau',
    job_title: 'ASEAN Sales Lead', department: 'Sales & Export',
    country_code: 'VN', timezone: 'Asia/Ho_Chi_Minh', language: 'vi',
    contract_type: 'full_time', employee_id: 'PEB-SALES-010',
    assignments: [
      { node_id: NODE.SALES_BU, role: 'bu_manager' },
      { node_id: NODE.CAMBODIA, role: 'country_user', country: 'Cambodia' },
      { node_id: NODE.THAILAND, role: 'country_user', country: 'Thailand' },
    ],
  },

  // ── peb200–peb202: Nhà máy VN 4, 5, 6 ───────────────────────
  {
    username: 'peb200', email: 'peb200@pebsteel.com',
    full_name: 'Dang Van Thanh', display_name: 'Van Thanh',
    job_title: 'Plant Supervisor', department: 'Fabrication',
    country_code: 'VN', timezone: 'Asia/Ho_Chi_Minh', language: 'vi',
    contract_type: 'full_time', employee_id: 'PEB-VN4-001',
    assignments: [{ node_id: NODE.VN4, role: 'country_user', country: 'Vietnam' }],
  },
  {
    username: 'peb201', email: 'peb201@pebsteel.com',
    full_name: 'Cao Thi Lan', display_name: 'Thi Lan',
    job_title: 'Production Engineer', department: 'Fabrication',
    country_code: 'VN', timezone: 'Asia/Ho_Chi_Minh', language: 'vi',
    contract_type: 'full_time', employee_id: 'PEB-VN5-001',
    assignments: [{ node_id: NODE.VN5, role: 'country_user', country: 'Vietnam' }],
  },
  {
    username: 'peb202', email: 'peb202@pebsteel.com',
    full_name: 'Truong Quoc Viet', display_name: 'Quoc Viet',
    job_title: 'Shift Leader', department: 'Fabrication',
    country_code: 'VN', timezone: 'Asia/Ho_Chi_Minh', language: 'vi',
    contract_type: 'full_time', employee_id: 'PEB-VN6-001',
    assignments: [{ node_id: NODE.VN6, role: 'country_user', country: 'Vietnam' }],
  },

  // ── peb203–peb204: India JV ───────────────────────────────────
  {
    username: 'peb203', email: 'peb203@pebsteel.com',
    full_name: 'Rajesh Kumar', display_name: 'Rajesh',
    job_title: 'JV Plant Manager', department: 'Fabrication',
    country_code: 'IN', timezone: 'Asia/Kolkata', language: 'en',
    contract_type: 'full_time', employee_id: 'PEB-IN-001',
    assignments: [{ node_id: NODE.INDIA_JV, role: 'bu_manager', country: 'India' }],
  },
  {
    username: 'peb204', email: 'peb204@pebsteel.com',
    full_name: 'Priya Sharma', display_name: 'Priya',
    job_title: 'Operations Lead', department: 'Fabrication',
    country_code: 'IN', timezone: 'Asia/Kolkata', language: 'en',
    contract_type: 'full_time', employee_id: 'PEB-IN-002',
    assignments: [{ node_id: NODE.INDIA_JV, role: 'country_user', country: 'India' }],
  },

  // ── peb205: Malaysia ──────────────────────────────────────────
  {
    username: 'peb205', email: 'peb205@pebsteel.com',
    full_name: 'Ahmad Fadzil', display_name: 'Fadzil',
    job_title: 'Country Manager', department: 'Sales & Export',
    country_code: 'MY', timezone: 'Asia/Kuala_Lumpur', language: 'en',
    contract_type: 'full_time', employee_id: 'PEB-MY-001',
    assignments: [{ node_id: NODE.MALAYSIA, role: 'country_user', country: 'Malaysia' }],
  },

  // ── peb206: Philippines Cebu ──────────────────────────────────
  {
    username: 'peb206', email: 'peb206@pebsteel.com',
    full_name: 'Jose Reyes', display_name: 'Jose',
    job_title: 'Sales Representative', department: 'Sales & Export',
    country_code: 'PH', timezone: 'Asia/Manila', language: 'en',
    contract_type: 'full_time', employee_id: 'PEB-PH-010',
    assignments: [{ node_id: NODE.PHIL_CEBU, role: 'country_user', country: 'Philippines' }],
  },

  // ── peb207–peb208: Indonesia Makassar + Surabaya ──────────────
  {
    username: 'peb207', email: 'peb207@pebsteel.com',
    full_name: 'Andi Wijaya', display_name: 'Andi',
    job_title: 'Regional Sales', department: 'Sales & Export',
    country_code: 'ID', timezone: 'Asia/Makassar', language: 'id',
    contract_type: 'full_time', employee_id: 'PEB-ID-010',
    assignments: [{ node_id: NODE.INDO_MKS, role: 'country_user', country: 'Indonesia' }],
  },
  {
    username: 'peb208', email: 'peb208@pebsteel.com',
    full_name: 'Dewi Kusuma', display_name: 'Dewi',
    job_title: 'Sales Executive', department: 'Sales & Export',
    country_code: 'ID', timezone: 'Asia/Jakarta', language: 'id',
    contract_type: 'full_time', employee_id: 'PEB-ID-011',
    assignments: [{ node_id: NODE.INDO_SBY, role: 'country_user', country: 'Indonesia' }],
  },

  // ── peb209: Vietnam Export Hub ────────────────────────────────
  {
    username: 'peb209', email: 'peb209@pebsteel.com',
    full_name: 'Tran Minh Khoa', display_name: 'Minh Khoa',
    job_title: 'Export Sales Manager', department: 'Sales & Export',
    country_code: 'VN', timezone: 'Asia/Ho_Chi_Minh', language: 'vi',
    contract_type: 'full_time', employee_id: 'PEB-EXPORT-001',
    assignments: [
      { node_id: NODE.VN_EXPORT, role: 'bu_manager' },
      { node_id: NODE.SALES_BU,  role: 'bu_manager' },
    ],
  },

  // ── peb210–peb213: Corporate BU sub-teams ────────────────────
  {
    username: 'peb210', email: 'peb210@pebsteel.com',
    full_name: 'Nguyen Thi Huong', display_name: 'Thi Huong',
    job_title: 'HR Manager', department: 'HR & Admin',
    country_code: 'VN', timezone: 'Asia/Ho_Chi_Minh', language: 'vi',
    contract_type: 'full_time', employee_id: 'PEB-HR-001',
    assignments: [
      { node_id: NODE.CORP_BU, role: 'bu_manager' },
      { node_id: NODE.HR,      role: 'bu_manager' },
    ],
  },
  {
    username: 'peb211', email: 'peb211@pebsteel.com',
    full_name: 'Le Van Tung', display_name: 'Van Tung',
    job_title: 'CFO', department: 'Finance',
    country_code: 'VN', timezone: 'Asia/Ho_Chi_Minh', language: 'vi',
    contract_type: 'full_time', employee_id: 'PEB-FIN-001',
    assignments: [{ node_id: NODE.FINANCE, role: 'bu_manager' }],
  },
  {
    username: 'peb212', email: 'peb212@pebsteel.com',
    full_name: 'Pham Duc Anh', display_name: 'Duc Anh',
    job_title: 'IT Director', department: 'IT & Digital',
    country_code: 'VN', timezone: 'Asia/Ho_Chi_Minh', language: 'vi',
    contract_type: 'full_time', employee_id: 'PEB-IT-001',
    assignments: [{ node_id: NODE.IT, role: 'bu_manager' }],
  },
  {
    username: 'peb213', email: 'peb213@pebsteel.com',
    full_name: 'Hoang Thi Ngoc', display_name: 'Thi Ngoc',
    job_title: 'Marketing Manager', department: 'Marketing',
    country_code: 'VN', timezone: 'Asia/Ho_Chi_Minh', language: 'vi',
    contract_type: 'full_time', employee_id: 'PEB-MKT-001',
    assignments: [{ node_id: NODE.MARKETING, role: 'bu_manager' }],
  },

  // ── peb214–peb215: Vendor tại India JV và Malaysia ────────────
  {
    username: 'peb214', email: 'peb214@vendor.com',
    full_name: 'Suresh Patel', display_name: 'Suresh',
    job_title: 'Civil Contractor', department: 'Vendor',
    country_code: 'IN', timezone: 'Asia/Kolkata', language: 'en',
    contract_type: 'contractor', employee_id: 'PEB-EXT-100',
    assignments: [{ node_id: NODE.INDIA_JV, role: 'vendor' }],
  },
  {
    username: 'peb215', email: 'peb215@vendor.com',
    full_name: 'Lim Wei Jie', display_name: 'Wei Jie',
    job_title: 'MEP Consultant', department: 'Vendor',
    country_code: 'MY', timezone: 'Asia/Kuala_Lumpur', language: 'en',
    contract_type: 'contractor', employee_id: 'PEB-EXT-101',
    assignments: [{ node_id: NODE.MALAYSIA, role: 'vendor' }],
  },
];

// ── Chạy seed ─────────────────────────────────────────────────
async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Cache role_id map
    const { rows: roleRows } = await client.query('SELECT id, name FROM roles');
    const roleMap = Object.fromEntries(roleRows.map(r => [r.name, r.id]));

    // Lấy admin-suppabase id để set created_by
    const { rows: adminRows } = await client.query(
      `SELECT id FROM users WHERE username = 'admin-suppabase'`
    );
    const adminId = adminRows[0]?.id ?? null;

    let created = 0;
    let skipped = 0;

    for (const u of USERS) {
      // Insert user
      const { rows } = await client.query(
        `INSERT INTO users (
           username, email, password_hash, full_name, display_name,
           job_title, department, country_code, timezone, language,
           contract_type, employee_id, created_by, must_change_password
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true)
         ON CONFLICT (username) DO UPDATE
           SET email         = EXCLUDED.email,
               full_name     = EXCLUDED.full_name,
               display_name  = EXCLUDED.display_name,
               job_title     = EXCLUDED.job_title,
               department    = EXCLUDED.department,
               country_code  = EXCLUDED.country_code,
               timezone      = EXCLUDED.timezone,
               language      = EXCLUDED.language,
               contract_type = EXCLUDED.contract_type,
               employee_id   = EXCLUDED.employee_id,
               updated_at    = NOW()
         RETURNING id, username, xmax`,
        [
          u.username, u.email, PASSWORD_HASH, u.full_name, u.display_name,
          u.job_title, u.department, u.country_code, u.timezone, u.language,
          u.contract_type, u.employee_id, adminId,
        ]
      );

      const user = rows[0];
      const isNew = user.xmax === '0';
      if (isNew) created++; else skipped++;

      // Assign roles
      for (const a of u.assignments) {
        const role_id = roleMap[a.role];
        if (!role_id) {
          console.warn(`  ⚠ Role '${a.role}' không tìm thấy, bỏ qua assignment cho ${u.username}`);
          continue;
        }
        await client.query(
          `INSERT INTO user_node_roles (user_id, node_id, role_id, country, granted_by)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (user_id, node_id)
           DO UPDATE SET role_id    = EXCLUDED.role_id,
                         country    = EXCLUDED.country,
                         granted_by = EXCLUDED.granted_by,
                         granted_at = NOW()`,
          [user.id, a.node_id, role_id, a.country ?? null, adminId]
        );
      }

      const roles = u.assignments.map(a => `${a.role}@${a.node_id.slice(-4)}`).join(', ');
      console.log(`  ${isNew ? '✓ Tạo mới' : '↺ Cập nhật'} ${u.username.padEnd(8)} — ${u.full_name.padEnd(22)} [${roles}]`);
    }

    await client.query('COMMIT');

    console.log(`\n✅ Seed hoàn tất!`)
    console.log(`   Tạo mới : ${created} users`);
    console.log(`   Cập nhật: ${skipped} users`);
    console.log(`   Password: 123456 (must_change_password = true)`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed thất bại:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

console.log('🚀 Bắt đầu seed user mẫu PEBsteel Global...\n');
seed();
