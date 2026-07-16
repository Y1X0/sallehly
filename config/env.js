// config/env.js
// كل الإعدادات والمتغيرات الثابتة يلي بيحتاجها أكثر من ملف.
// أي تعديل على .env أو على الثوابت العامة (بورت، مسارات، مدة الكوكيز...) مكانه هون بس.

const path = require('path');
const fs = require('fs');

const BASE = path.join(__dirname, '..'); // جذر المشروع (فوق مجلد config)
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// [SEC-FIX-01] JWT_SECRET validation — must be ≥32 chars in production, ≥16 in dev
const JWT_SECRET = (() => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (IS_PROD) throw new Error('[FATAL] JWT_SECRET is required in production');
    console.warn('[WARN] JWT_SECRET not set — using insecure default for development only');
    return 'local_development_secret_CHANGE_ME_before_deploy';
  }
  if (IS_PROD && secret.length < 32) {
    throw new Error('[FATAL] JWT_SECRET must be at least 32 characters in production');
  }
  return secret;
})();

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM || 'onboarding@resend.dev';

const DATA_DIR = process.env.DATA_DIR || path.join(BASE, 'data');
const UPLOAD_DIR = process.env.DATA_DIR
  ? path.join(DATA_DIR, 'uploads')
  : path.join(BASE, 'public', 'uploads');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(path.join(UPLOAD_DIR, 'payments'), { recursive: true });
fs.mkdirSync(path.join(UPLOAD_DIR, 'avatars'), { recursive: true });
fs.mkdirSync(path.join(UPLOAD_DIR, 'audios'), { recursive: true });
fs.mkdirSync(path.join(UPLOAD_DIR, 'requests'), { recursive: true });

// [FIX-CHATIMG-02] بدون DATA_DIR مضبوطاً على قرص دائم فعلي، كل الصور/التسجيلات
// الصوتية/الإيصالات المرفوعة تُخزَّن داخل مجلد كود التطبيق نفسه (public/uploads)
// — على أي منصة نشر تُعيد بناء الحاوية من الصفر بكل deploy (مثل Render بدون
// Persistent Disk)، هذا المجلد يُمحى بالكامل عند كل نشر جديد أو إعادة تشغيل،
// فتفشل كل الصور القديمة بصمت (404) بلا أي أثر بالسجلات يوضّح السبب الحقيقي.
// هذا التحذير لا يمنع الإقلاع (البيئة قد تكون قصداً بلا قرص دائم أثناء التطوير)
// لكنه يجعل السبب واضحاً فوراً بسجلات الإنتاج بدل اكتشافه لاحقاً من شكاوى المستخدمين.
if (IS_PROD && !process.env.DATA_DIR) {
  console.warn(
    '[WARN] DATA_DIR غير مضبوط بالإنتاج — الملفات المرفوعة (صور/صوت/إيصالات) ' +
    'تُخزَّن بمسار غير دائم وستُفقد عند أي إعادة نشر أو إعادة تشغيل. ' +
    'اربط قرصاً دائماً (Persistent Disk) على منصة النشر واضبط DATA_DIR على مساره.'
  );
}

const COOKIE_OPTS = { httpOnly: true, sameSite: 'strict', secure: IS_PROD, maxAge: 7 * 24 * 60 * 60 * 1000 };

// [SEC-FIX-06] CSRF Protection — Origin/Referer validation for state-changing requests
const ALLOWED_ORIGINS = IS_PROD
  ? ['https://sallehly.com', 'https://www.sallehly.com', 'https://sallehly.onrender.com']
  : ['http://localhost:3000', 'http://127.0.0.1:3000'];

const IO_CORS_ORIGINS = IS_PROD
  ? ['https://sallehly.onrender.com', 'https://sallehly.com', 'https://www.sallehly.com']
  : ['http://localhost:3000'];

module.exports = {
  BASE, PORT, IS_PROD, JWT_SECRET, RESEND_API_KEY, RESEND_FROM,
  DATA_DIR, UPLOAD_DIR, COOKIE_OPTS, ALLOWED_ORIGINS, IO_CORS_ORIGINS
};
