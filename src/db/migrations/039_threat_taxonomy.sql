-- Tier 1: Threat taxonomy — single source of truth for all guardrail layers.
-- Every block (regex/embedding/llm-classifier/output-scan) references one of
-- these category codes so admin dashboard can slice by category.

CREATE TABLE IF NOT EXISTS threat_categories (
  id              SERIAL PRIMARY KEY,
  code            VARCHAR(40)  NOT NULL UNIQUE,
  name_vi         VARCHAR(120) NOT NULL,
  name_en         VARCHAR(120) NOT NULL,
  description     TEXT,
  severity        SMALLINT     NOT NULL CHECK (severity BETWEEN 1 AND 5),
  -- Default action when this category fires. Layers may override per-pattern.
  action_default  VARCHAR(20)  NOT NULL CHECK (action_default IN ('BLOCK_IMMEDIATE','BLOCK_AND_FLAG','WARN')),
  zero_tolerance  BOOLEAN      NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_threat_categories_active ON threat_categories(is_active) WHERE is_active = TRUE;

INSERT INTO threat_categories (code, name_vi, name_en, description, severity, action_default, zero_tolerance) VALUES
  ('CBRN',            'Vũ khí hóa-sinh-phóng xạ-hạt nhân', 'Chemical / Biological / Radiological / Nuclear', 'Thuốc nổ, chất độc thần kinh, vũ khí huỷ diệt hàng loạt.', 5, 'BLOCK_IMMEDIATE', TRUE),
  ('WEAPONS',         'Vũ khí thông thường',               'Conventional weapons',                         'Súng tự chế, ghost gun, vũ khí 3D-printed, dao găm độc.', 5, 'BLOCK_IMMEDIATE', TRUE),
  ('CSAM',            'Lạm dụng trẻ em',                   'Child sexual abuse material',                  'Bất kỳ nội dung khiêu dâm liên quan trẻ vị thành niên.', 5, 'BLOCK_IMMEDIATE', TRUE),
  ('SELF_HARM',       'Tự gây hại / tự tử',                'Self-harm / suicide methods',                  'Phương pháp tự tử, liều thuốc gây chết, cắt mạch.', 5, 'BLOCK_IMMEDIATE', TRUE),
  ('CYBERATTACK',     'Tấn công mạng',                     'Cyberattack',                                  'Malware, ransomware, exploit, hack tài khoản/wifi/hệ thống.', 5, 'BLOCK_AND_FLAG', FALSE),
  ('DRUG_SYNTHESIS',  'Tổng hợp ma tuý',                   'Drug synthesis',                               'Tổng hợp meth/heroin/MDMA, trồng cần sa quy mô.', 4, 'BLOCK_AND_FLAG', FALSE),
  ('FRAUD',           'Lừa đảo / tài chính phi pháp',      'Fraud / financial crime',                      'Lừa đảo ngân hàng, rửa tiền, giấy tờ giả, clone thẻ.', 4, 'BLOCK_AND_FLAG', FALSE),
  ('HARASSMENT',      'Quấy rối / theo dõi',               'Targeted harassment / doxxing',                'Doxxing, stalking, tìm địa chỉ người cụ thể.', 4, 'BLOCK_AND_FLAG', FALSE),
  ('VN_COMPLIANCE',   'Vi phạm pháp luật Việt Nam',        'Vietnam-specific banned content',              'Chống phá Nhà nước, xuyên tạc lịch sử, mê tín dị đoan, cờ bạc phi pháp.', 4, 'BLOCK_AND_FLAG', FALSE),
  ('MISINFO',         'Thông tin sai lệch nghiêm trọng',   'Serious misinformation',                       'Y tế giả, bầu cử giả, deepfake chính trị.', 3, 'BLOCK_AND_FLAG', FALSE),
  ('JAILBREAK',       'Cố tình bypass / jailbreak',        'Jailbreak / prompt injection',                 'DAN, AIM, role-play, fictional framing để lách rule.', 4, 'BLOCK_AND_FLAG', FALSE),
  ('OFFTOPIC',        'Lạc đề (không phải vi phạm)',       'Off-topic',                                    'Câu hỏi ngoài chuyên môn agent — handled bởi prompt, không block.', 1, 'WARN', FALSE)
ON CONFLICT (code) DO NOTHING;
