-- ============================================================
-- 056_prompt_no_file_export.sql
-- Constraint: the assistant must NEVER claim to produce a downloadable file /
-- attachment. It can only answer with text/code in the chat. Applies to normal
-- (no-agent) chat, where the system prompt comes from prompt_templates. Agent
-- conversations already get this via the constitutional block in
-- agentTemplateService.buildAgentSection().
--
-- Approach: clone the current active chat/pro prompts (vi + en) into version+1
-- with the rule appended, then deactivate the old versions. promptService picks
-- the latest is_active row (ORDER BY version DESC), 60s cache TTL.
-- Idempotent: only acts if a higher version doesn't already exist.
-- ============================================================

DO $$
DECLARE
  rec RECORD;
  add_vi TEXT := E'\n\n## Không xuất file (BẮT BUỘC)\n'
    || E'- Bạn CHỈ trả lời bằng văn bản trong khung chat — không có khả năng tạo tệp tải về.\n'
    || E'- Dù người dùng yêu cầu thế nào ("tạo file cho tôi", "xuất .docx/.pdf/.xlsx/.zip/.csv", "tạo link tải", "đính kèm tệp", "gửi file"), TUYỆT ĐỐI KHÔNG hứa hẹn, giả vờ hay tuyên bố đã tạo ra tệp/đường link tải về.\n'
    || E'- Thay vào đó, trả thẳng NỘI DUNG dưới dạng text hoặc code block, kèm một câu: "Mình không tạo được file tải về; dưới đây là nội dung dạng văn bản, bạn có thể sao chép và lưu lại." Không bịa tên file kèm link giả.';
  add_en TEXT := E'\n\n## No file export (REQUIRED)\n'
    || E'- You can ONLY reply with text/code in the chat — you cannot produce downloadable files.\n'
    || E'- No matter how the user asks ("make me a file", "export .docx/.pdf/.xlsx/.zip/.csv", "give a download link", "attach a file", "send the file"), NEVER promise, pretend, or claim you created a file or download link.\n'
    || E'- Instead, return the CONTENT directly as text or a code block, with one line: "I can''t generate a downloadable file; here is the content as text you can copy and save." Never invent a filename with a fake link.';
BEGIN
  FOR rec IN
    SELECT id, scope, locale, version, content
    FROM prompt_templates t
    WHERE t.scope IN ('chat','pro')
      AND t.is_active = TRUE
      AND t.version = (
        SELECT MAX(version) FROM prompt_templates x
        WHERE x.scope = t.scope AND x.locale = t.locale
      )
      -- skip if a newer version already exists (re-run safety)
      AND NOT EXISTS (
        SELECT 1 FROM prompt_templates y
        WHERE y.scope = t.scope AND y.locale = t.locale AND y.version > t.version
      )
  LOOP
    INSERT INTO prompt_templates (scope, locale, content, version, is_active, description)
    VALUES (
      rec.scope,
      rec.locale,
      rec.content || CASE WHEN rec.locale = 'vi' THEN add_vi ELSE add_en END,
      rec.version + 1,
      TRUE,
      'v' || (rec.version + 1) || ': + no-file-export rule'
    )
    ON CONFLICT (scope, locale, version) DO NOTHING;

    UPDATE prompt_templates
       SET is_active = FALSE, updated_at = NOW()
     WHERE id = rec.id;
  END LOOP;
END $$;
