-- L1 — Global hard regex blocklist.
--
-- Applied to EVERY agent (including future ones) BEFORE per-agent L2.
-- A hit here is treated as zero-tolerance for severity-5 categories
-- (CBRN/CSAM/WEAPONS/SELF_HARM) and BLOCK_AND_FLAG for the rest.
--
-- Patterns target BOTH the normalized (diacritic-preserved) and asciiFold
-- (diacritic-stripped) form. Use `target_form` to select which.

CREATE TABLE IF NOT EXISTS global_block_patterns (
  id            SERIAL PRIMARY KEY,
  category_code VARCHAR(40) NOT NULL REFERENCES threat_categories(code) ON UPDATE CASCADE,
  pattern       TEXT        NOT NULL,
  flags         VARCHAR(10) NOT NULL DEFAULT 'iu',
  -- 'normalized' = Vietnamese-aware (diacritics preserved)
  -- 'ascii'      = diacritic-stripped, lowercase, leet rolled back
  -- 'both'       = run against both forms (default; safest)
  target_form   VARCHAR(20) NOT NULL DEFAULT 'both'
                 CHECK (target_form IN ('normalized','ascii','both')),
  message       TEXT        NOT NULL DEFAULT 'Yêu cầu này vi phạm chính sách sử dụng.',
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_global_block_active ON global_block_patterns(is_active, category_code) WHERE is_active = TRUE;
-- Idempotent re-runs of seed: prevent duplicate (category, pattern) rows.
ALTER TABLE global_block_patterns
  DROP CONSTRAINT IF EXISTS uniq_global_pat,
  ADD CONSTRAINT uniq_global_pat UNIQUE (category_code, pattern);

-- Audit log: every block (any layer) writes a row here. Drives admin dashboard
-- and rate-limit decisions in L7.
CREATE TABLE IF NOT EXISTS guardrail_violations (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID,
  conversation_id UUID,
  agent_template_id UUID,
  layer           VARCHAR(20)  NOT NULL,  -- L0|L1|L2|L3|L4|L5|L6|L7
  category_code   VARCHAR(40)  REFERENCES threat_categories(code),
  pattern_id      INTEGER,                -- nullable: only for regex hits
  severity        SMALLINT,
  message_hash    CHAR(64),               -- sha256 of normalized input
  message_preview TEXT,                   -- first 200 chars, for admin review
  action_taken    VARCHAR(20) NOT NULL,   -- BLOCKED|FLAGGED|WARNED
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_violations_user      ON guardrail_violations(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_violations_category  ON guardrail_violations(category_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_violations_severity  ON guardrail_violations(severity, created_at DESC) WHERE severity >= 4;

-- ── Seed Tier-1 patterns ──────────────────────────────────────────
-- Each pattern is intentionally narrow + explicit. Broad patterns belong in
-- L3/L4 (embedding/classifier). Prefer false-negative here over false-positive
-- (a user's legit "I cooked rice with TNT-brand cooker" should not block).

INSERT INTO global_block_patterns (category_code, pattern, flags, target_form, message, notes) VALUES

-- CBRN — explosives, chemical/bio agents
('CBRN', '(làm|chế|chế\s*tạo|tự\s*chế|sản\s*xuất|cách\s*làm|công\s*thức|hướng\s*dẫn|recipe|how\s*to\s*make)\s*\w{0,20}\s*(bom|bomb|thuốc\s*nổ|chất\s*nổ|tnt|t\.n\.t|c[-\s]?4|semtex|anfo|napalm|grenade|lựu\s*đạn|mìn|tự\s*sát)',
 'iu', 'normalized', 'Yêu cầu liên quan đến chất nổ / vũ khí huỷ diệt không được hỗ trợ.', 'CBRN: explosives Vi+En'),
('CBRN', '(make|build|synthesize|create|produce|cook).{0,20}(tnt|c[-\s]?4|semtex|anfo|napalm|sarin|vx[\s-]?gas|nerve[\s-]?agent|mustard[\s-]?gas|ricin|anthrax|bioweapon|dirty[\s-]?bomb)',
 'iu', 'both', 'Yêu cầu liên quan đến CBRN không được hỗ trợ.', 'CBRN: synthesis English'),
('CBRN', '(sarin|vx\s*nerve|chất\s*độc\s*thần\s*kinh|mustard\s*gas|hơi\s*ngạt|ricin|anthrax|bệnh\s*than|vũ\s*khí\s*sinh\s*học|vũ\s*khí\s*hoá\s*học)',
 'iu', 'normalized', 'Nội dung vũ khí hoá-sinh không được hỗ trợ.', 'CBRN: keywords'),
('CBRN', '(che\s*tao|cach\s*lam|cong\s*thuc).{0,30}(bom|tnt|thuoc\s*no|chat\s*no)',
 'iu', 'ascii', 'Yêu cầu liên quan đến chất nổ không được hỗ trợ.', 'CBRN: ascii fallback'),

-- WEAPONS — firearms, 3D-printed, ghost guns
('WEAPONS', '(làm|chế\s*tạo|tự\s*chế|in\s*3d|3d\s*print)\s*\w{0,15}\s*(súng|pistol|rifle|firearm|ghost\s*gun|zip\s*gun|machine\s*gun|ak[\s-]?47|m16)',
 'iu', 'both', 'Yêu cầu liên quan đến vũ khí tự chế không được hỗ trợ.', 'WEAPONS: gunsmithing'),
('WEAPONS', '(silencer|suppressor|ống\s*giảm\s*thanh).{0,30}(tự\s*chế|homemade|diy|làm)',
 'iu', 'normalized', 'Yêu cầu liên quan đến phụ kiện súng trái phép không được hỗ trợ.', 'WEAPONS: accessories'),
('WEAPONS', '(convert|chuyển\s*đổi).{0,20}(semi[\s-]?auto|bán\s*tự\s*động).{0,20}(full[\s-]?auto|tự\s*động)',
 'iu', 'both', 'Yêu cầu liên quan đến chế tạo vũ khí không được hỗ trợ.', 'WEAPONS: auto-sear'),

-- CSAM — zero tolerance, deliberately strict
('CSAM', '(child|trẻ\s*em|trẻ\s*vị\s*thành\s*niên|under[\s-]?age|underage|minor|loli|shota).{0,30}(porn|pornography|sex|nude|naked|khiêu\s*dâm|nuy|sexual|erotic)',
 'iu', 'both', 'Nội dung này vi phạm nghiêm trọng chính sách. Đã ghi nhận.', 'CSAM zero-tolerance'),
('CSAM', '(cp\s*video|csam|child\s*sexual|child\s*abuse\s*material|jailbait)',
 'iu', 'both', 'Nội dung này vi phạm nghiêm trọng chính sách. Đã ghi nhận.', 'CSAM: explicit terms'),

-- SELF_HARM — methods, not awareness
('SELF_HARM', '(cách|how\s*to|method).{0,20}(tự\s*tử|tự\s*sát|kết\s*liễu|suicide|kill\s*myself|end\s*my\s*life|hang\s*myself)',
 'iu', 'normalized', 'Nếu bạn đang gặp khó khăn, vui lòng gọi 1800-599-920 (Ngày Mai - tư vấn tâm lý miễn phí).', 'SELF_HARM: methods'),
('SELF_HARM', '(liều\s*thuốc|overdose|lethal\s*dose|fatal\s*dose).{0,30}(chết|gây\s*chết|kill|fatal|tự\s*tử)',
 'iu', 'normalized', 'Nếu bạn đang gặp khó khăn, vui lòng gọi 1800-599-920 (Ngày Mai - tư vấn tâm lý miễn phí).', 'SELF_HARM: overdose'),
('SELF_HARM', '(cắt\s*mạch|cut\s*my\s*wrist|slit\s*wrist|hanging\s*knot|noose|treo\s*cổ)\s*(cách|how|làm|method)?',
 'iu', 'normalized', 'Nếu bạn đang gặp khó khăn, vui lòng gọi 1800-599-920 (Ngày Mai - tư vấn tâm lý miễn phí).', 'SELF_HARM: physical methods'),

-- CYBERATTACK — unauthorized access
('CYBERATTACK', '(hack|crack|bẻ\s*khoá|bẻ\s*khóa|xâm\s*nhập|truy\s*cập\s*trái\s*phép|chiếm\s*quyền|hijack|brute[\s-]?force).{0,40}(wifi|wi-?fi|mạng|tài\s*khoản|facebook|gmail|email|password|mật\s*khẩu|account|router|camera|server|hệ\s*thống|website|web|2fa|otp)',
 'iu', 'normalized', 'Không hỗ trợ tấn công an ninh mạng trái phép.', 'CYBERATTACK: VN unauthorized access'),
('CYBERATTACK', '(viết|tạo|write|create|code|develop|build|generate).{0,30}(malware|virus|ransomware|backdoor|rootkit|spyware|keylogger|trojan|botnet|worm|cryptolocker|stealer|rat\s+remote)',
 'iu', 'both', 'Không hỗ trợ viết phần mềm độc hại.', 'CYBERATTACK: malware'),
('CYBERATTACK', '(sql.?injection|xss.?payload|reverse[\s-]?shell|bind[\s-]?shell|web[\s-]?shell|csrf[\s-]?exploit|ssrf[\s-]?exploit|cve[\s-]?\d+).{0,30}(exploit|payload|tạo|viết|generate|weaponize)',
 'iu', 'both', 'Không hỗ trợ tạo payload tấn công.', 'CYBERATTACK: exploit payloads'),
('CYBERATTACK', '(ddos|dos\s*attack|flood\s*attack|amplification\s*attack|stresser|booter).{0,30}(script|tool|code|viết|tạo|build|hire|service)',
 'iu', 'both', 'Không hỗ trợ tấn công DoS/DDoS.', 'CYBERATTACK: DoS'),

-- DRUG_SYNTHESIS
('DRUG_SYNTHESIS', '(tổng\s*hợp|synthesize|cook|nấu|chế\s*tạo|sản\s*xuất|cách\s*làm|công\s*thức).{0,30}(meth|methamphetamine|ma\s*túy|heroin|cocaine|mdma|lsd|ketamine|crystal\s*meth|đá\s*ma\s*túy|hồng\s*phiến|thuốc\s*lắc)',
 'iu', 'both', 'Không hỗ trợ tổng hợp ma tuý.', 'DRUG: synthesis'),
('DRUG_SYNTHESIS', '(precursor|tiền\s*chất).{0,30}(meth|amphet|mdma|cocaine|heroin)',
 'iu', 'normalized', 'Không hỗ trợ tổng hợp ma tuý.', 'DRUG: precursors'),

-- FRAUD
('FRAUD', '(rửa\s*tiền|money\s*laundering|launder\s*money|smurfing\s*bank).{0,40}(cách|how|hướng\s*dẫn|method|guide|step)',
 'iu', 'normalized', 'Không hỗ trợ lừa đảo / tài chính phi pháp.', 'FRAUD: laundering'),
('FRAUD', '(làm|chế|in|forge|fake|giả).{0,20}(giấy\s*tờ\s*giả|cmnd\s*giả|hộ\s*chiếu\s*giả|bằng\s*giả|fake\s*id|fake\s*passport|fake\s*degree)',
 'iu', 'normalized', 'Không hỗ trợ làm giấy tờ giả.', 'FRAUD: document forgery'),
('FRAUD', '(clone|skim|carding).{0,30}(credit\s*card|thẻ\s*tín\s*dụng|atm\s*card|debit\s*card)',
 'iu', 'both', 'Không hỗ trợ gian lận thẻ tín dụng.', 'FRAUD: carding'),
('FRAUD', '(viết|tạo|soạn|write|generate).{0,30}(scam|phishing|kịch\s*bản\s*lừa\s*đảo|email\s*lừa\s*đảo|sms\s*lừa\s*đảo)',
 'iu', 'normalized', 'Không hỗ trợ nội dung lừa đảo.', 'FRAUD: scam scripts'),

-- HARASSMENT / DOXXING
('HARASSMENT', '(tìm|find|locate|track|theo\s*dõi|stalk).{0,30}(địa\s*chỉ|address|home\s*address|nơi\s*ở|phone\s*number|số\s*điện\s*thoại|cmnd|căn\s*cước|ssn).{0,30}(của|of)\s+\w+',
 'iu', 'normalized', 'Không hỗ trợ tìm thông tin cá nhân của người khác.', 'HARASSMENT: doxxing'),
('HARASSMENT', '(doxx|doxxing|swat|swatting|revenge\s*porn|tống\s*tình|tống\s*tiền)',
 'iu', 'both', 'Không hỗ trợ quấy rối / tống tiền.', 'HARASSMENT: terms'),

-- JAILBREAK — meta-attacks
('JAILBREAK', '(ignore|forget|disregard|override|bypass).{0,40}(previous|above|all|prior|original|earlier).{0,20}(instruction|prompt|rule|guideline|system)',
 'i', 'both', 'Yêu cầu bypass policy không được chấp nhận.', 'JAILBREAK: instruction override EN'),
('JAILBREAK', '(bỏ\s*qua|quên\s*đi|không\s*cần|gỡ\s*bỏ|phớt\s*lờ).{0,40}(hướng\s*dẫn|lệnh|prompt|chỉ\s*thị|quy\s*tắc|nguyên\s*tắc).{0,20}(trên|trước|gốc|ban\s*đầu)',
 'iu', 'normalized', 'Yêu cầu bypass policy không được chấp nhận.', 'JAILBREAK: instruction override VI'),
('JAILBREAK', '(pretend|act\s*as|role[\s-]?play|đóng\s*vai|giả\s*làm|giả\s*vờ\s*là).{0,40}(dan|aim|jailbroken|jailbreak|evil\s*ai|unfiltered|grandma\s*who|developer\s*mode)',
 'iu', 'both', 'Không tham gia roleplay để bypass policy.', 'JAILBREAK: DAN / persona attack'),
('JAILBREAK', '(in\s*a\s*fictional|in\s*a\s*story|in\s*a\s*novel|trong\s*tiểu\s*thuyết|trong\s*hư\s*cấu|giả\s*sử|hypothetically|theoretically).{0,80}(bomb|thuốc\s*nổ|tnt|hack|malware|kill|giết|chế\s*tạo|synthesize|công\s*thức)',
 'iu', 'normalized', 'Hư cấu không phải lý do hợp lệ để bypass policy.', 'JAILBREAK: fictional framing'),
('JAILBREAK', '(print|show|reveal|repeat|output|expose|leak|tiết\s*lộ|hiển\s*thị|in\s*ra|hé\s*lộ).{0,30}(system\s*prompt|initial\s*prompt|prompt\s*gốc|hướng\s*dẫn\s*hệ\s*thống|cấu\s*hình\s*ban\s*đầu)',
 'iu', 'normalized', 'Không thể tiết lộ system prompt.', 'JAILBREAK: prompt extraction'),

-- VN_COMPLIANCE — narrow first pass; full list comes in Tier 2
('VN_COMPLIANCE', '(chống\s*phá|lật\s*đổ|overthrow).{0,30}(nhà\s*nước|chính\s*quyền|đảng|chính\s*phủ\s*việt|government\s*of\s*vietnam)',
 'iu', 'normalized', 'Nội dung vi phạm pháp luật Việt Nam.', 'VN: anti-state'),
('VN_COMPLIANCE', '(bùa|ngải|phép\s*thuật|tà\s*thuật|trù\s*ếm).{0,40}(hại|giết|gây\s*bệnh|chết)',
 'iu', 'normalized', 'Nội dung mê tín dị đoan có hại không được hỗ trợ.', 'VN: harmful superstition'),
('VN_COMPLIANCE', '(cá\s*độ|đánh\s*lô|đề|gambling\s*vietnam).{0,30}(online|trực\s*tuyến|nhà\s*cái|app)',
 'iu', 'normalized', 'Không hỗ trợ cờ bạc phi pháp.', 'VN: illegal gambling')

ON CONFLICT DO NOTHING;
