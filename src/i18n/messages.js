// Error / status message dictionary.
// Each entry maps a stable `code` → translated text per locale.
// Controllers should respond with: { error: '<English fallback>', code: 'ERR_XYZ' }
// FE matches on `code` and looks up its own translation, BE message is fallback.

export const MESSAGES = {
  // ── Auth ─────────────────────────────────────────────
  ERR_AUTH_REQUIRED:        { en: 'Authentication required',                vi: 'Cần đăng nhập' },
  ERR_INVALID_CREDENTIALS:  { en: 'Username or password is incorrect',      vi: 'Tên đăng nhập hoặc mật khẩu không đúng' },
  ERR_ACCOUNT_LOCKED:       { en: 'Account is temporarily locked',          vi: 'Tài khoản bị khóa tạm thời' },
  ERR_ACCOUNT_DISABLED:     { en: 'Account is disabled',                    vi: 'Tài khoản đã bị vô hiệu hóa' },
  ERR_TOKEN_INVALID:        { en: 'Token is invalid or expired',            vi: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn' },
  ERR_TOKEN_MISSING:        { en: 'Missing authentication token',           vi: 'Thiếu token xác thực' },
  ERR_STALE_PERMISSIONS:    { en: 'Permissions have changed. Please sign in again.', vi: 'Quyền đã thay đổi. Vui lòng đăng nhập lại.' },

  // ── Permissions ──────────────────────────────────────
  ERR_FORBIDDEN:            { en: 'Permission denied',                      vi: 'Không có quyền truy cập' },
  ERR_PERMISSION_DENIED:    { en: "You don't have permission to perform this action", vi: 'Bạn không có quyền thực hiện thao tác này' },
  ERR_ADMIN_REQUIRED:       { en: 'Admin permission required',              vi: 'Yêu cầu quyền Admin trở lên' },
  ERR_SUPER_ADMIN_REQUIRED: { en: 'Super Admin permission required',        vi: 'Yêu cầu quyền Super Admin' },
  ERR_SCOPE_DENIED:         { en: 'This node or user is outside your permitted scope', vi: 'Node hoặc người dùng này nằm ngoài phạm vi được phép của bạn' },
  ERR_ROLE_ESCALATION:      { en: 'You cannot assign a role higher than your own', vi: 'Bạn không thể gán quyền cao hơn quyền của bạn' },

  // ── Validation ───────────────────────────────────────
  ERR_VALIDATION:           { en: 'Validation failed',                      vi: 'Dữ liệu không hợp lệ' },
  ERR_MESSAGES_REQUIRED:    { en: 'messages[] is required',                 vi: 'Cần ít nhất một tin nhắn' },
  ERR_FIELD_REQUIRED:       { en: 'Required field missing',                 vi: 'Thiếu trường bắt buộc' },
  ERR_DUPLICATE:            { en: 'Already exists',                         vi: 'Đã tồn tại' },

  // ── Resources ────────────────────────────────────────
  ERR_NOT_FOUND:            { en: 'Resource not found',                     vi: 'Không tìm thấy' },
  ERR_CONVERSATION_NOT_FOUND: { en: 'Conversation not found',               vi: 'Không tìm thấy cuộc hội thoại' },
  ERR_USER_NOT_FOUND:       { en: 'User not found',                         vi: 'Không tìm thấy người dùng' },
  ERR_MODULE_NOT_FOUND:     { en: 'Module not found',                       vi: 'Không tìm thấy module' },
  ERR_DOCUMENT_NOT_FOUND:   { en: 'Document not found',                     vi: 'Không tìm thấy tài liệu' },

  // ── System ───────────────────────────────────────────
  ERR_DB:                   { en: 'Database error',                         vi: 'Lỗi cơ sở dữ liệu' },
  ERR_UPSTREAM:             { en: 'Upstream service error',                 vi: 'Lỗi dịch vụ phụ thuộc' },
  ERR_PEB_NOT_CONFIGURED:   { en: 'PEB API key is not configured',          vi: 'Chưa cấu hình PEB API key' },
  ERR_STREAM:               { en: 'Streaming error',                        vi: 'Lỗi truyền dữ liệu' },
  ERR_RATE_LIMIT:           { en: 'Too many requests, please try again later', vi: 'Quá nhiều yêu cầu, vui lòng thử lại sau' },
  ERR_INTERNAL:             { en: 'Internal server error',                  vi: 'Lỗi máy chủ' },
};

/** Translate a code into the target locale; fallback to English. */
export function t(code, locale = 'en') {
  const lang = (locale || 'en').toLowerCase().split('-')[0];
  const entry = MESSAGES[code];
  if (!entry) return code;                  // unknown code → return as-is
  return entry[lang] || entry.en || code;
}

/** Express helper to send a localized error response. */
export function sendError(res, status, code, opts = {}) {
  const locale = opts.locale || res.req?.user?.language || res.req?.locale || 'en';
  return res.status(status).json({
    error: t(code, locale),
    code,
    ...(opts.detail ? { detail: opts.detail } : {}),
  });
}
