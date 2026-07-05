// services/email.js
// إرسال إيميلات الـ OTP عبر Resend. أي تعديل على قالب الإيميل أو مزوّد الإرسال مكانه هون.

const { Resend } = require('resend');
const { RESEND_API_KEY, RESEND_FROM } = require('../config/env');

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// [SEC-FIX-14] Escape user-supplied name before interpolating into email HTML
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendOtpEmail(toEmail, otp, name) {
  if (!resend) {
    // Development fallback: print to console
    console.log(`\n📧 OTP for ${toEmail}: ${otp}\n`);
    return true;
  }
  try {
    await resend.emails.send({
      from: RESEND_FROM,
      to: toEmail,
      subject: 'كود التحقق — صلّحلي',
      html: `
        <div dir="rtl" style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0d0d1a;color:#fff;border-radius:16px;padding:32px;">
          <div style="text-align:center;margin-bottom:24px;">
            <h1 style="color:#7c3aed;font-size:28px;margin:0;">صلّحلي</h1>
            <p style="color:#aaa;font-size:13px;margin:4px 0 0;">منصة الصيانة في الأردن</p>
          </div>
          <p style="font-size:16px;">مرحباً <b>${escapeHtml(name)}</b>،</p>
          <p style="color:#ccc;">استخدم الكود أدناه لتأكيد تسجيلك. صالح لمدة <b>10 دقائق</b>.</p>
          <div style="text-align:center;margin:28px 0;">
            <div style="display:inline-block;background:#1a1050;border:2px solid #7c3aed;border-radius:12px;padding:18px 40px;">
              <span style="font-size:36px;font-weight:900;letter-spacing:10px;color:#fff;">${otp}</span>
            </div>
          </div>
          <p style="color:#888;font-size:12px;text-align:center;">إذا لم تطلب هذا الكود، تجاهل هذا الإيميل.</p>
        </div>
      `
    });
    return true;
  } catch (e) {
    console.error('Resend error:', e.message);
    return false;
  }
}

module.exports = { sendOtpEmail };
