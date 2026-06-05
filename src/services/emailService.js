// emailService — thin nodemailer wrapper for transactional email (OTP login).
//
// SMTP config comes from env (set in .env.development / .env.production):
//   EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS
// The transport is created lazily on first use and reused.

import nodemailer from 'nodemailer';

let _transport = null;

function getTransport() {
  if (_transport) return _transport;
  const host = process.env.EMAIL_HOST;
  const port = Number(process.env.EMAIL_PORT) || 587;
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  if (!host || !user || !pass) {
    console.warn('[email] SMTP not fully configured (EMAIL_HOST/USER/PASS) — emails will be skipped');
    return null;
  }
  _transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,   // 465 = implicit TLS; 587 = STARTTLS
    auth: { user, pass },
  });
  return _transport;
}

const BRAND = process.env.EMAIL_BRAND || 'Suppabase';

function otpHtml(code) {
  const spaced = String(code).split('').join('&nbsp;&nbsp;');
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#eef0f4;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f4;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(15,23,42,0.08);">
        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#2f5fe0 0%,#2546c7 100%);padding:28px 36px;">
          <div style="color:#ffffff;font-size:22px;font-weight:700;">${BRAND}</div>
          <div style="color:rgba(255,255,255,0.78);font-size:12px;letter-spacing:0.14em;margin-top:4px;">MÃ XÁC THỰC OTP</div>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:36px;">
          <h1 style="margin:0 0 14px;font-size:26px;font-weight:800;color:#0f172a;letter-spacing:0.01em;">MÃ XÁC THỰC</h1>
          <p style="margin:0 0 28px;font-size:15px;line-height:1.6;color:#475569;">
            Nhập mã 6 chữ số sau để đăng nhập. Mã có hiệu lực <b>5 phút</b>.
          </p>
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;padding:28px;text-align:center;">
            <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:40px;font-weight:700;letter-spacing:6px;color:#2f5fe0;">${spaced}</div>
          </div>
          <p style="margin:24px 0 0;font-size:13px;font-style:italic;color:#94a3b8;line-height:1.6;">
            Nếu bạn không yêu cầu mã này, hãy bỏ qua email.
          </p>
        </td></tr>
        <!-- Footer -->
        <tr><td style="border-top:1px solid #eef0f4;padding:20px 36px;text-align:center;">
          <div style="font-size:12px;color:#94a3b8;">© ${new Date().getFullYear()} ${BRAND}</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Send a 6-digit OTP to `to`. Best-effort: returns true on success, false on
 * failure (caller must NOT leak this to the client — see authController.sendOtp).
 */
export async function sendOtpEmail(to, code) {
  const transport = getTransport();
  if (!transport) return false;
  try {
    await transport.sendMail({
      from: process.env.EMAIL_FROM || `${BRAND} <${process.env.EMAIL_USER}>`,
      to,
      subject: `${code} là mã xác thực ${BRAND} của bạn`,
      text: `Mã xác thực của bạn là ${code}. Mã có hiệu lực trong 5 phút.`,
      html: otpHtml(code),
    });
    return true;
  } catch (err) {
    console.error('[email] sendOtpEmail failed:', err.message);
    return false;
  }
}
