// piiMasker — redact common PII from text shown to non-super-admin reviewers.
//
// Scope (intentionally conservative — false positives < false negatives):
//   • Email           → keep first letter + domain TLD; e.g. j***@gmail.com
//   • Phone (VN/intl) → keep last 3 digits
//   • Credit card     → mask all but last 4
//   • CMND/CCCD (VN)  → 9–12 digit number runs → mask middle
//   • Bearer tokens   → mask entire value
//
// We DO NOT mask names/addresses — too many false positives in technical content.

const RX = {
  email: /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
  phone: /(?:^|[^\d])(\+?\d{1,3}[\s.-]?)?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?=$|[^\d])/g,
  cc:    /\b(?:\d[ -]?){13,19}\b/g,
  idnum: /(?:^|[^\d])(\d{9,12})(?=$|[^\d])/g,
  token: /\b(Bearer|sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9._-]{20,})\b/g,
};

function maskMiddle(s, keepStart = 1, keepEnd = 3) {
  if (!s || s.length <= keepStart + keepEnd) return '*'.repeat(s.length);
  return s.slice(0, keepStart) + '*'.repeat(Math.max(3, s.length - keepStart - keepEnd)) + s.slice(-keepEnd);
}

export function maskEmail(email) {
  if (!email || typeof email !== 'string') return email;
  return email.replace(RX.email, (_, first, domain) => `${first}***${domain}`);
}

export function maskText(text) {
  if (!text || typeof text !== 'string') return text;
  let out = text;
  out = out.replace(RX.email, (_, first, domain) => `${first}***${domain}`);
  out = out.replace(RX.token, '[REDACTED_TOKEN]');
  out = out.replace(RX.cc,    (m) => maskMiddle(m.replace(/\D/g, ''), 0, 4));
  out = out.replace(RX.phone, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 8) return m;       // probably not a phone
    return m.replace(digits, maskMiddle(digits, 0, 3));
  });
  out = out.replace(RX.idnum, (m, num) => m.replace(num, maskMiddle(num, 2, 2)));
  return out;
}

/**
 * Detect PII categories present in text. Returns { found: [...], count }.
 * Used to auto-flag QA reviews and warn on input.
 */
export function detectPII(text) {
  if (!text || typeof text !== 'string') return { found: [], count: 0 };
  const found = [];
  let count = 0;

  const probe = (re, label) => {
    re.lastIndex = 0;
    const matches = text.match(re);
    if (matches) { found.push(label); count += matches.length; }
  };
  // Use fresh regex copies (global state pitfall)
  probe(new RegExp(RX.email.source, 'g'),  'email');
  probe(new RegExp(RX.token.source, 'g'),  'token');
  probe(new RegExp(RX.cc.source,    'g'),  'credit_card');
  probe(new RegExp(RX.phone.source, 'g'),  'phone');
  probe(new RegExp(RX.idnum.source, 'g'),  'id_number');

  return { found: [...new Set(found)], count };
}

/**
 * Apply masking to a Q&A audit row based on the requesting admin's role.
 * Super admin sees raw; others see masked.
 */
export function maskRow(row, { isSuperAdmin }) {
  if (isSuperAdmin) return row;
  return {
    ...row,
    email:     maskEmail(row.email),
    content:   maskText(row.content),
    full_name: row.full_name ? maskMiddle(row.full_name, 1, 1) : row.full_name,
  };
}
