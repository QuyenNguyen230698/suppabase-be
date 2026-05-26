-- Tier 2.3 — Anti-jailbreak: encoding / cipher / persona / context attacks.
-- Targets sophisticated bypass techniques beyond simple DAN-style roleplay.

INSERT INTO global_block_patterns (category_code, pattern, flags, target_form, message, notes) VALUES

-- ── Encoded payloads (suspicious base64/hex blocks near sensitive verbs) ─
-- A long base64-looking blob next to "decode", "execute", "run" is rarely benign.
('JAILBREAK',
 '(decode|giải\s*mã|chạy|execute|eval).{0,30}[A-Za-z0-9+/=]{40,}',
 'iu', 'normalized', 'Không hỗ trợ giải mã / thực thi payload đáng ngờ.', 'JAILBREAK: base64 exec'),

('JAILBREAK',
 '(base64|hex\s*encoded|rot13|caesar\s*cipher|morse).{0,40}(harmful|bypass|jailbreak|payload|malicious|độc\s*hại|tấn\s*công)',
 'iu', 'both', 'Không hỗ trợ encoding để bypass policy.', 'JAILBREAK: encoding intent'),

-- ── Cipher / steganography requests ─────────────────────────────
('JAILBREAK',
 '(write|viết|trả\s*lời|respond|answer).{0,40}(in\s*cipher|in\s*base64|in\s*hex|in\s*morse|in\s*reverse|ngược\s*lại|từng\s*chữ\s*cái\s*đầu)',
 'iu', 'normalized', 'Không trả lời trong định dạng nhằm bypass kiểm duyệt.', 'JAILBREAK: response format bypass'),

('JAILBREAK',
 '(first\s*letter|chữ\s*cái\s*đầu|first\s*character).{0,40}(of\s*each|mỗi\s*câu|mỗi\s*từ).{0,40}(spell|đánh\s*vần|tạo\s*thành)',
 'iu', 'normalized', 'Không hỗ trợ steganography ẩn nội dung vi phạm.', 'JAILBREAK: acrostic'),

-- ── Persona/system inversion ───────────────────────────────────
('JAILBREAK',
 '(you\s*are\s*now|từ\s*nay\s*bạn\s*là|kể\s*từ\s*bây\s*giờ\s*bạn).{0,30}(no\s*longer|không\s*còn).{0,30}(bound\s*by|ràng\s*buộc|restricted|hạn\s*chế).{0,30}(rules|guidelines|policy|quy\s*tắc|chính\s*sách)',
 'iu', 'normalized', 'Không chấp nhận thay đổi vai trò để bypass policy.', 'JAILBREAK: persona inversion'),

('JAILBREAK',
 '(developer\s*mode|dev\s*mode|admin\s*mode|god\s*mode|sudo\s*mode|root\s*mode|chế\s*độ\s*nhà\s*phát\s*triển|chế\s*độ\s*quản\s*trị).{0,40}(enable|activate|on|bật|kích\s*hoạt)',
 'iu', 'normalized', 'Không tồn tại "developer mode" — yêu cầu bypass bị từ chối.', 'JAILBREAK: fake dev mode'),

-- ── Hypothetical / counterfactual framing ──────────────────────
('JAILBREAK',
 '(if\s*you\s*were\s*not|nếu\s*bạn\s*không\s*phải).{0,30}(ai|assistant|trợ\s*lý|chatbot).{0,40}(would|sẽ|how\s*would|làm\s*thế\s*nào)',
 'iu', 'normalized', 'Không tham gia framing giả định để bypass policy.', 'JAILBREAK: counterfactual self'),

('JAILBREAK',
 '(opposite|ngược\s*lại|đối\s*lập).{0,30}(of\s*what|với\s*điều).{0,30}(safe|an\s*toàn|allowed|được\s*phép)',
 'iu', 'normalized', 'Không hỗ trợ trả lời ngược lại policy.', 'JAILBREAK: opposite-day'),

-- ── Multi-turn priming attempts ────────────────────────────────
('JAILBREAK',
 '(remember|nhớ\s*rằng|note\s*that|chú\s*ý).{0,40}(for\s*the\s*rest|cho\s*những\s*câu\s*sau|cho\s*toàn\s*bộ\s*cuộc).{0,40}(ignore|bỏ\s*qua|skip|không\s*áp\s*dụng).{0,30}(safety|an\s*toàn|policy|chính\s*sách|rules|quy\s*tắc)',
 'iu', 'normalized', 'Không chấp nhận priming bypass cho các câu sau.', 'JAILBREAK: session priming'),

-- ── "Educational" / "research" justification ───────────────────
('JAILBREAK',
 '(for\s*educational\s*purpose|cho\s*mục\s*đích\s*học\s*tập|for\s*research|cho\s*nghiên\s*cứu|academic\s*purpose).{0,80}(bomb|thuốc\s*nổ|tnt|malware|exploit|drug\s*synthesis|tổng\s*hợp\s*ma\s*túy|hack|attack|tấn\s*công)',
 'iu', 'normalized', 'Mục đích "học tập/nghiên cứu" không phải lý do hợp lệ để bypass policy.', 'JAILBREAK: educational excuse'),

('JAILBREAK',
 '(i\s*am\s*a\s*(security\s*researcher|pentester|red\s*team)|tôi\s*là\s*(chuyên\s*gia\s*bảo\s*mật|pentester|red\s*team)).{0,80}(malware|exploit|payload|reverse\s*shell|backdoor)',
 'iu', 'normalized', 'Tự nhận là chuyên gia bảo mật không tự động cho phép yêu cầu nhạy cảm.', 'JAILBREAK: pentester excuse'),

-- ── Token smuggling — invisible / unusual delimiters ──────────
('JAILBREAK',
 '\\[\\[.{1,40}(SYSTEM|ADMIN|INSTRUCTION|OVERRIDE).{1,80}\\]\\]',
 'iu', 'normalized', 'Cấu trúc giả mạo system tag bị từ chối.', 'JAILBREAK: fake system tag'),

('JAILBREAK',
 -- Use dollar-quoting to keep regex backslashes untouched by SQL string parsing.
 $reg$<\|(im_start|im_end|system|assistant|endoftext)\|$reg$,
 'iu', 'normalized', 'Cấu trúc chat-template giả mạo bị từ chối.', 'JAILBREAK: chat template injection'),

-- ── Long sequence of zero-width chars (smuggling) ─────────────
-- L0 normalizer already strips zero-width chars before any pattern runs, so
-- a redundant pattern here is hard to write correctly (PG → JS regex escape
-- semantics differ). Skipping for now; if L0 ever changes, re-add carefully
-- with a regex tested in BOTH PG insert form and JS RegExp form.
('JAILBREAK', '__disabled__', 'iu', 'normalized', 'placeholder', 'JAILBREAK: zero-width smuggle (disabled — handled by L0)')

ON CONFLICT DO NOTHING;
