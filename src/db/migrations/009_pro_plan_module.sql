-- ============================================================
-- 009_pro_plan_module.sql
-- Thêm module 'pro_plan' để route /pro-plan được bảo vệ bởi
-- permission middleware (gate-all principle).
-- Đồng thời sửa lại route của module 'api_tokens' từ '/admin' → '/api-token'
-- cho khớp với FE (loại bỏ workaround FE-side).
-- ============================================================

INSERT INTO modules (id, name, abbr, color, route, description, sort_order) VALUES
  ('pro_plan', 'Pro Plan', 'PP', 'amber', '/pro-plan',
   'Chat với model PEB (qwen3.6:35b) — Pro Plan', 5)
ON CONFLICT (id) DO UPDATE
  SET name        = EXCLUDED.name,
      abbr        = EXCLUDED.abbr,
      color       = EXCLUDED.color,
      route       = EXCLUDED.route,
      description = EXCLUDED.description,
      sort_order  = EXCLUDED.sort_order,
      updated_at  = NOW();

-- Sửa route của api_tokens cho khớp FE
UPDATE modules
   SET route = '/api-token',
       updated_at = NOW()
 WHERE id = 'api_tokens' AND route = '/admin';
