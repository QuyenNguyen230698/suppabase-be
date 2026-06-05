-- ============================================================
-- 058_pro_plan_agent_fields.sql
-- Fill in the fields that 057 left at defaults on the Pro Plan agent so it
-- behaves like a fully-configured template in /admin/agent-templates:
--   • rules            — soft quality rules injected into the prompt
--   • allowed_tools    — all built-in tools (RAG search, time, calculator)
--   • block_patterns   — a couple of fast L1 regex guards (VN-friendly)
--   • block_llm_check  — enable L2 LLM safety check (Pro = quality/safety first)
--   • fallback_response— polite refusal when a rule blocks
--
-- Note: schema validation was also widened (category 'pro' + model '__peb__'
-- are now accepted) so this template can be edited/saved from the admin UI.
-- Idempotent: UPDATE by slug; safe to re-run.
-- ============================================================

UPDATE agent_templates SET
  rules = $rules$[
    {"id":"pp1","severity":"soft","text":"Luôn rà soát lại câu trả lời (tự kiểm tra logic, sự thật, edge case) trước khi gửi; chỉ xuất bản cuối đã tinh chỉnh."},
    {"id":"pp2","severity":"soft","text":"Trả lời đúng trọng tâm và đủ chiều sâu; câu hỏi đơn giản thì đáp ngắn gọn tương xứng, không lan man."},
    {"id":"pp3","severity":"soft","text":"Khi viết code: cung cấp code đầy đủ chạy được, không bỏ phần quan trọng; nêu rõ giả định nếu có."},
    {"id":"pp4","severity":"soft","text":"Không bịa số liệu/tên/ngày tháng; nếu không chắc thì nói thẳng và giải thích giới hạn."}
  ]$rules$::jsonb,
  block_patterns = $bp$[
    {"pattern":"(?:^|[^\\p{L}])(jailbreak|bỏ qua (?:mọi )?(?:chỉ dẫn|hướng dẫn|nguyên tắc))","flags":"iu","message":"Yêu cầu này vi phạm chính sách sử dụng."}
  ]$bp$::jsonb,
  allowed_tools = $tools$["search_documents","get_current_time","calculator"]$tools$::jsonb,
  block_llm_check = TRUE,
  fallback_response = 'Mình không thể hỗ trợ yêu cầu này vì vi phạm chính sách sử dụng. Bạn vui lòng đặt câu hỏi khác nhé.',
  updated_at = NOW()
WHERE slug = 'pro-plan';
