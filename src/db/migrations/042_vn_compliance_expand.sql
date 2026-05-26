-- Tier 2 — Expand VN_COMPLIANCE patterns.
--
-- Covers Vietnamese legal red lines that generic English guardrails miss:
--   - Luật An ninh mạng 2018 (cybersecurity, anti-state)
--   - Nghị định 15/2020 + 53/2022 (misinformation, social media)
--   - Luật Báo chí 2016 (press law)
--   - Bộ luật Hình sự (state security, separatism)
--   - Luật quản lý vũ khí, vật liệu nổ
--   - Luật phòng chống ma túy
--   - Nghị định 137/2020 về pháo
--
-- Patterns intentionally narrow — prefer false-negative over false-positive.
-- A user discussing history academically should NOT be blocked; one calling
-- for action against the state SHOULD be.

INSERT INTO global_block_patterns (category_code, pattern, flags, target_form, message, notes) VALUES

-- ── Anti-state / separatism ──────────────────────────────────────
('VN_COMPLIANCE',
 '(kích\s*động|kêu\s*gọi|tổ\s*chức|hô\s*hào|hướng\s*dẫn).{0,40}(biểu\s*tình\s*chống|bạo\s*loạn|lật\s*đổ|bạo\s*động|nổi\s*dậy\s*chống)',
 'iu', 'normalized', 'Nội dung kích động bạo loạn vi phạm pháp luật Việt Nam.', 'VN: incitement'),

('VN_COMPLIANCE',
 '(ly\s*khai|tách\s*khỏi|độc\s*lập\s*cho).{0,30}(việt\s*nam|tây\s*nguyên|tây\s*bắc|chăm\s*pa|khmer\s*krom|phục\s*quốc)',
 'iu', 'normalized', 'Nội dung kêu gọi ly khai vi phạm pháp luật Việt Nam.', 'VN: separatism'),

('VN_COMPLIANCE',
 '(đả\s*đảo|down\s*with).{0,20}(đảng\s*cộng\s*sản|chính\s*phủ|nhà\s*nước\s*việt\s*nam|nhà\s*nước\s*cộng\s*sản)',
 'iu', 'normalized', 'Nội dung này vi phạm pháp luật Việt Nam.', 'VN: anti-CCP slogans'),

('VN_COMPLIANCE',
 '(thành\s*lập|tổ\s*chức|hoạt\s*động).{0,40}(việt\s*tân|fulro|chính\s*phủ\s*quốc\s*gia\s*việt\s*nam\s*lâm\s*thời|đảng\s*phục\s*quốc)',
 'iu', 'normalized', 'Nội dung liên quan tổ chức bị cấm tại Việt Nam.', 'VN: banned orgs'),

-- ── Anti-government propaganda / leader defamation ───────────────
('VN_COMPLIANCE',
 '(viết|tạo|soạn).{0,30}(bài|status|bài\s*đăng).{0,40}(xuyên\s*tạc|bôi\s*nhọ|nói\s*xấu).{0,40}(lãnh\s*đạo\s*đảng|nhà\s*nước|chủ\s*tịch\s*nước|tổng\s*bí\s*thư)',
 'iu', 'normalized', 'Nội dung bôi nhọ lãnh đạo Nhà nước vi phạm pháp luật.', 'VN: defamation of state leaders'),

('VN_COMPLIANCE',
 '(xuyên\s*tạc|bịa\s*đặt|phủ\s*nhận).{0,40}(lịch\s*sử\s*dân\s*tộc|chiến\s*thắng|kháng\s*chiến|bác\s*hồ|hồ\s*chí\s*minh.{0,20}(sai|tội|xấu))',
 'iu', 'normalized', 'Nội dung xuyên tạc lịch sử vi phạm pháp luật Việt Nam.', 'VN: historical revisionism'),

-- ── Religious / ethnic incitement ────────────────────────────────
('VN_COMPLIANCE',
 '(kích\s*động|gây\s*chia\s*rẽ|kêu\s*gọi\s*tẩy\s*chay).{0,30}(dân\s*tộc|tôn\s*giáo|người\s*kinh|người\s*hoa|người\s*khmer|công\s*giáo|phật\s*giáo|tin\s*lành|hồi\s*giáo)',
 'iu', 'normalized', 'Nội dung kích động chia rẽ dân tộc/tôn giáo vi phạm pháp luật.', 'VN: ethnic/religious incitement'),

-- ── Misinformation (NĐ 15/2020) ──────────────────────────────────
('VN_COMPLIANCE',
 '(tung|lan\s*truyền|đăng).{0,30}(tin\s*giả|tin\s*đồn|fake\s*news).{0,40}(dịch\s*bệnh|covid|thiên\s*tai|bầu\s*cử|gây\s*hoang\s*mang)',
 'iu', 'normalized', 'Lan truyền tin giả gây hoang mang vi phạm Nghị định 15/2020.', 'VN: misinfo ND15'),

('VN_COMPLIANCE',
 '(viết|tạo|soạn).{0,30}(bài|tin).{0,30}(sai\s*sự\s*thật|bịa\s*đặt).{0,40}(quan\s*chức|cán\s*bộ|nhà\s*nước)',
 'iu', 'normalized', 'Đưa tin sai sự thật về cán bộ vi phạm pháp luật.', 'VN: false info about officials'),

-- ── Illegal gambling / lottery ───────────────────────────────────
('VN_COMPLIANCE',
 '(hướng\s*dẫn|cách|chơi).{0,30}(cá\s*độ|đánh\s*bạc|lô\s*đề|tài\s*xỉu|baccarat|poker\s*tiền\s*thật).{0,40}(online|trực\s*tuyến|nhà\s*cái|app|website)',
 'iu', 'normalized', 'Không hỗ trợ cờ bạc / cá độ phi pháp.', 'VN: illegal gambling guide'),

('VN_COMPLIANCE',
 '(tạo|mở|setup).{0,30}(sòng\s*bạc|nhà\s*cái|website\s*cá\s*độ|app\s*lô\s*đề)',
 'iu', 'normalized', 'Không hỗ trợ tổ chức cờ bạc phi pháp.', 'VN: gambling org'),

-- ── Harmful superstition ────────────────────────────────────────
('VN_COMPLIANCE',
 '(làm|cách).{0,20}(bùa|ngải|tà\s*thuật|phép\s*chú|ếm).{0,40}(hại|giết|gây\s*bệnh|chết|yêu\s*đương|tình\s*yêu)',
 'iu', 'normalized', 'Nội dung mê tín dị đoan có hại không được hỗ trợ.', 'VN: harmful magic'),

('VN_COMPLIANCE',
 '(chữa|trị).{0,20}(ung\s*thư|hiv|aids|tiểu\s*đường).{0,30}(bằng\s*bùa|tâm\s*linh|gọi\s*hồn|cúng\s*bái)',
 'iu', 'normalized', 'Không hỗ trợ chữa bệnh bằng tâm linh thay thế y khoa.', 'VN: pseudo-medicine'),

-- ── Wildlife / endangered species trafficking ────────────────────
('VN_COMPLIANCE',
 '(mua|bán|săn|buôn|nuôi).{0,30}(tê\s*tê|hổ|gấu\s*ngựa|voi|ngà\s*voi|sừng\s*tê\s*giác|cao\s*hổ\s*cốt|mật\s*gấu|vảy\s*tê\s*tê)',
 'iu', 'normalized', 'Không hỗ trợ buôn bán động vật hoang dã thuộc danh mục cấm.', 'VN: wildlife trafficking'),

-- ── Fireworks / illegal explosives (NĐ 137/2020) ─────────────────
('VN_COMPLIANCE',
 '(tự\s*chế|chế\s*tạo|làm|cách\s*làm).{0,30}(pháo\s*nổ|pháo\s*tự\s*chế|pháo\s*hoa\s*nổ|pháo\s*đùng|pháo\s*chuột)',
 'iu', 'normalized', 'Tự chế pháo nổ vi phạm Nghị định 137/2020.', 'VN: homemade fireworks'),

('VN_COMPLIANCE',
 '(mua|bán|nhập\s*lậu).{0,20}(pháo\s*nổ|pháo\s*lậu).{0,30}(trung\s*quốc|biên\s*giới|online)',
 'iu', 'normalized', 'Mua bán pháo nổ trái phép vi phạm pháp luật.', 'VN: firework trafficking'),

-- ── Counterfeit currency / docs ──────────────────────────────────
('VN_COMPLIANCE',
 '(in|làm|chế\s*tạo|sản\s*xuất).{0,20}(tiền\s*giả|đồng\s*giả|vnd\s*giả|usd\s*giả|polymer\s*giả)',
 'iu', 'normalized', 'Làm tiền giả vi phạm nghiêm trọng pháp luật.', 'VN: counterfeit currency'),

-- ── Anti-revolution propaganda terms ─────────────────────────────
('VN_COMPLIANCE',
 '(tuyên\s*truyền|cổ\s*xuý).{0,30}(chống\s*phá|lật\s*đổ|chế\s*độ\s*tư\s*bản\s*thay\s*thế|diễn\s*biến\s*hoà\s*bình).{0,40}(việt\s*nam|nhà\s*nước|chính\s*quyền)',
 'iu', 'normalized', 'Nội dung tuyên truyền chống Nhà nước vi phạm pháp luật.', 'VN: anti-state propaganda'),

-- ── Illegal weapons (Luật quản lý vũ khí 2017) ───────────────────
('VN_COMPLIANCE',
 '(mua|bán|chế\s*tạo|tàng\s*trữ).{0,20}(súng\s*săn|súng\s*kíp|súng\s*tự\s*chế|súng\s*hơi\s*tự\s*chế|kiếm\s*nhật|dao\s*găm|côn\s*nhị\s*khúc)',
 'iu', 'normalized', 'Mua bán vũ khí trái phép vi phạm Luật quản lý vũ khí 2017.', 'VN: illegal weapons trade'),

-- ── Drug trafficking specific to VN context ──────────────────────
('VN_COMPLIANCE',
 '(mua|bán|vận\s*chuyển|tàng\s*trữ).{0,30}(ma\s*túy|heroin|đá|hồng\s*phiến|thuốc\s*lắc|cần\s*sa).{0,40}(số\s*lượng|kg|gam|gram|cọc)',
 'iu', 'normalized', 'Mua bán/vận chuyển ma túy vi phạm nghiêm trọng pháp luật.', 'VN: drug trafficking'),

-- ── State secrets ────────────────────────────────────────────────
('VN_COMPLIANCE',
 '(tiết\s*lộ|công\s*bố|leak).{0,30}(bí\s*mật\s*nhà\s*nước|tài\s*liệu\s*mật|tài\s*liệu\s*tuyệt\s*mật|tin\s*tình\s*báo)',
 'iu', 'normalized', 'Tiết lộ bí mật nhà nước vi phạm Luật bảo vệ bí mật nhà nước.', 'VN: state secrets'),

-- ── Banned content distribution ──────────────────────────────────
('VN_COMPLIANCE',
 '(phát\s*tán|chia\s*sẻ|share).{0,30}(video|hình|tài\s*liệu).{0,40}(phản\s*động|chống\s*đảng|chống\s*nhà\s*nước|bị\s*cấm)',
 'iu', 'normalized', 'Phát tán nội dung phản động vi phạm pháp luật.', 'VN: banned content sharing')

ON CONFLICT DO NOTHING;
