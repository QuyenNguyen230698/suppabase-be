-- ============================================================
-- 005_org_nodes_expand.sql — Mở rộng org chart PEBsteel Global
--   Thêm: NM VN 4-6, India JV, Corporate BU, Malaysia,
--         Philippines Cebu, Indonesia Makassar + Surabaya,
--         Vietnam Export Hub
-- ============================================================

INSERT INTO org_nodes (id, parent_id, label, sub, type, depth, path, sort_order)
VALUES

  -- ── Corporate BU (ngang hàng Fabrication / Sales / Engineering) ──
  ('00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000002',
   'Corporate BU', 'HR · Finance · IT · Marketing · Legal', 'bu', 2,
   'PEB Group > HQ > Corporate BU', 4),

  -- ── Fabrication BU — Nhà máy VN 4, 5, 6 ─────────────────────────
  ('00000000-0000-0000-0000-000000000024', '00000000-0000-0000-0000-000000000010',
   'Nhà máy VN 4', 'Bà Rịa-Vũng Tàu · Bay 15m · Z300 AZ180', 'fab', 3,
   'PEB Group > HQ > Fabrication BU > VN-4', 5),

  ('00000000-0000-0000-0000-000000000025', '00000000-0000-0000-0000-000000000010',
   'Nhà máy VN 5', 'Bà Rịa-Vũng Tàu · Heavy structure · Power/Oil&Gas', 'fab', 3,
   'PEB Group > HQ > Fabrication BU > VN-5', 6),

  ('00000000-0000-0000-0000-000000000026', '00000000-0000-0000-0000-000000000010',
   'Nhà máy VN 6', 'Bà Rịa-Vũng Tàu · Ra mắt 2016 · 100K MT', 'fab', 3,
   'PEB Group > HQ > Fabrication BU > VN-6', 7),

  -- ── India JV (con của Fabrication BU) ────────────────────────────
  ('00000000-0000-0000-0000-000000000027', '00000000-0000-0000-0000-000000000010',
   'India JV — Pithampur', 'PEB Steel Lloyd · 90,000 m² · Nam Á', 'fab', 3,
   'PEB Group > HQ > Fabrication BU > India-JV', 8),

  -- ── Sales BU — văn phòng còn thiếu ──────────────────────────────
  ('00000000-0000-0000-0000-000000000034', '00000000-0000-0000-0000-000000000011',
   'Malaysia Office', 'Kuala Lumpur · Q Sentral F39', 'country', 3,
   'PEB Group > HQ > Sales BU > Malaysia', 5),

  ('00000000-0000-0000-0000-000000000035', '00000000-0000-0000-0000-000000000011',
   'Philippines Cebu', 'Cebu · Arcada 5 Bldg, Mandaue City', 'country', 3,
   'PEB Group > HQ > Sales BU > Philippines-Cebu', 6),

  ('00000000-0000-0000-0000-000000000036', '00000000-0000-0000-0000-000000000011',
   'Indonesia Makassar', 'Makassar · Wisma Kalla Bldg F4', 'country', 3,
   'PEB Group > HQ > Sales BU > Indonesia-Makassar', 7),

  ('00000000-0000-0000-0000-000000000037', '00000000-0000-0000-0000-000000000011',
   'Indonesia Surabaya', 'Surabaya · Graha Bukopin F10', 'country', 3,
   'PEB Group > HQ > Sales BU > Indonesia-Surabaya', 8),

  ('00000000-0000-0000-0000-000000000038', '00000000-0000-0000-0000-000000000011',
   'Vietnam Export Hub', 'HCM City · Export CN/JP/FR/ES/Global', 'country', 3,
   'PEB Group > HQ > Sales BU > Vietnam-Export', 9),

  -- ── Corporate BU — sub-teams ─────────────────────────────────────
  ('00000000-0000-0000-0000-000000000050', '00000000-0000-0000-0000-000000000013',
   'HR & Admin', 'Nhân sự · Hành chính', 'bu', 3,
   'PEB Group > HQ > Corporate BU > HR', 1),

  ('00000000-0000-0000-0000-000000000051', '00000000-0000-0000-0000-000000000013',
   'Finance & Accounting', 'Tài chính · Kế toán · Hợp đồng', 'bu', 3,
   'PEB Group > HQ > Corporate BU > Finance', 2),

  ('00000000-0000-0000-0000-000000000052', '00000000-0000-0000-0000-000000000013',
   'IT & Digital', 'Hệ thống · Phần mềm · Bảo mật', 'bu', 3,
   'PEB Group > HQ > Corporate BU > IT', 3),

  ('00000000-0000-0000-0000-000000000053', '00000000-0000-0000-0000-000000000013',
   'Marketing & Comm', 'Marketing · Truyền thông · Brand', 'bu', 3,
   'PEB Group > HQ > Corporate BU > Marketing', 4)

ON CONFLICT (id) DO UPDATE
  SET label      = EXCLUDED.label,
      sub        = EXCLUDED.sub,
      path       = EXCLUDED.path,
      sort_order = EXCLUDED.sort_order,
      updated_at = NOW();
