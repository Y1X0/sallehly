// services/email.js
// إرسال إيميلات الـ OTP عبر Resend. أي تعديل على قالب الإيميل أو مزوّد الإرسال مكانه هون.

const { Resend } = require('resend');
const { RESEND_API_KEY, RESEND_FROM, IS_PROD } = require('../config/env');

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

// [SEC-FIX-EMAILTIMEOUT-01] راجع DECISIONS.md — resend.emails.send() يعتمد
// داخلياً على fetch المدمَج بـNode (undici)، الذي بلا أي مهلة افتراضية
// إطلاقاً. انقطاع أو تعليق بطرف Resend (لا رد، لا إغلاق اتصال) كان يعلّق
// await resend.emails.send() للأبد — وبالتالي /auth/forgot-password و
// /auth/register بأكملهما (كلاهما ينتظر sendOtpEmail قبل أي رد) — يبقى
// العميل بانتظار رد لن يصل إطلاقاً، بلا حتى 500 واضح يقدر يعيد المحاولة
// بعده. مصدّرة بشكل مستقل لأنها القابلة للاختبار فعلياً هنا (محاكاة Resend
// حيّ معلَّق بلا استجابة تتطلّب خادم وهمي حقيقي، خارج نطاق هذا الإصلاح).
function withTimeout(promise, ms, timeoutMessage) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage || `timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function sendOtpEmail(toEmail, otp, name) {
  if (!resend) {
    // [PERF-HARDEN-03] هذا البديل (طباعة الكود على console بدل إرسال إيميل
    // حقيقي) مقصود فقط للتطوير المحلي (لا RESEND_API_KEY مضبوطاً عمداً).
    // كان يعمل بلا شرط IS_PROD — لو غاب RESEND_API_KEY بالإنتاج فعلياً بالخطأ
    // (مفتاح منتهي الصلاحية، خطأ إعداد على منصة النشر...)، كل تسجيل/إعادة
    // تعيين كلمة سر كان سيُعتبَر "ناجحاً" (return true) بصمت بينما المستخدم لن
    // يستلم أي إيميل حقيقي إطلاقاً — عطل كامل بصلاحية "نجاح" مضلِّلة بالسجلات،
    // بدل ظهوره فوراً وبوضوح كخطأ 500 قابل للتشخيص (نفس فلسفة تحقق JWT_SECRET
    // بـconfig/env.js: فشل واضح أفضل من نجاح وهمي بالإنتاج تحديداً).
    if (!IS_PROD) {
      console.log(`\n📧 OTP for ${toEmail}: ${otp}\n`);
      return true;
    }
    console.error('[FATAL] RESEND_API_KEY غير مضبوط بالإنتاج — تعذّر إرسال إيميل التحقق فعلياً.');
    return false;
  }
  try {
    // [SEC-FIX-EMAILTIMEOUT-01] راجع DECISIONS.md وتعليق withTimeout أعلاه.
    await withTimeout(resend.emails.send({
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
    }), 15000, 'resend send timeout');
    return true;
  } catch (e) {
    console.error('Resend error:', e.message);
    return false;
  }
}

module.exports = { sendOtpEmail, withTimeout };
