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

// [DR-FIX-01] راجع DECISIONS.md — النسخ الاحتياطي المحلي (أعلاه بـconfig/db.js)
// يُكتَب على نفس القرص الذي يحمي القاعدة الحية أصلاً؛ لو القرص نفسه تعطّل أو
// فُقد، تُفقَد القاعدة وكل نسخها الاحتياطية بنفس اللحظة. هذه المتغيرات اختيارية
// تماماً (نفس نمط RESEND_API_KEY أعلاه) — بدونها، رفع النسخة لمكان خارجي
// (services/offsite-backup.js) يُتخطّى بصمت مع رسالة تحذير واحدة، بلا أي تأثير
// على النسخ الاحتياطي المحلي نفسه ولا على إقلاع السيرفر.
const BACKUP_GITHUB_TOKEN = process.env.BACKUP_GITHUB_TOKEN || '';
const BACKUP_GITHUB_OWNER = process.env.BACKUP_GITHUB_OWNER || '';
const BACKUP_GITHUB_REPO = process.env.BACKUP_GITHUB_REPO || '';

// [MON-FIX-01] راجع DECISIONS.md وservices/error-alert.js — بريد استقبال
// تنبيهات الأخطاء غير المتوقعة. اختياري تماماً: لو غاب، يُستخدَم ADMIN_EMAIL
// نفسه بدل إضافة إعداد إجباري جديد (نفس فلسفة الإعدادات الاختيارية أعلاه).
const ALERT_EMAIL = process.env.ALERT_EMAIL || process.env.ADMIN_EMAIL || '';

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

// [FEAT-DEDUP-01] راجع DECISIONS.md — حالات الطلب "النشطة/الحاجزة" (العميل
// أو الفني ما زال مرتبطاً بطلب لم يُغلَق بعد — لم يُكتمَل ولم يُلغَ) كانت
// مكرَّرة حرفياً 4 مرات مستقلة (admin.routes.js×3، auth.routes.js×1). أي
// حالة جديدة تُضاف لدورة حياة الطلب مستقبلاً كانت تحتاج تذكّر تحديث كل
// موضع يدوياً بلا آلية تفرض التزامن. القيمة الجاهزة لـSQL مُحسَبة هنا مرة
// واحدة (الحالات أسماء ثابتة بالكود لا مدخلات مستخدم، فلا خطر حقن
// باستخدامها مباشرة داخل نص IN(...)).
const BLOCKING_REQUEST_STATUSES = ['بانتظار العروض', 'وصلت عروض', 'تم اختيار عرض', 'قيد التنفيذ', 'بانتظار تأكيد الدفع'];
const BLOCKING_REQUEST_STATUSES_SQL = BLOCKING_REQUEST_STATUSES.map(s => `'${s}'`).join(',');

// [FEAT-DEDUP-01] راجع DECISIONS.md — قائمة فرعية: حالات "الفني مرتبط
// بعمل نشط بالفعل" (بعد قبول عرض، حتى إنهاء/إلغاء الطلب) — لا تشمل
// 'بانتظار العروض'/'وصلت عروض' لأن technician_id يبقى NULL طوال هاتين
// الحالتين أصلاً (لا عرض قُبل بعد)، فلا معنى لإدراجهما بأي استعلام
// technician_id=?. كانت مكرَّرة حرفياً 3 مرات (admin.routes.js×1،
// offers.routes.js×2) بنفس المعنى تحديداً: "هل هذا الفني ملتزم أصلاً بعمل
// آخر؟" — قبل السماح له بتقديم عرض جديد أو قبل قبول عرض له.
const TECHNICIAN_ACTIVE_JOB_STATUSES = ['تم اختيار عرض', 'قيد التنفيذ', 'بانتظار تأكيد الدفع'];
const TECHNICIAN_ACTIVE_JOB_STATUSES_SQL = TECHNICIAN_ACTIVE_JOB_STATUSES.map(s => `'${s}'`).join(',');

// [FEAT-DEDUP-01] راجع DECISIONS.md — عدد الفرص المجانية (طلبات مكتملة أو
// عروض مُقدَّمة، عدّادان منفصلان تماماً — راجع FIX-OFFERQUOTA-01) قبل بدء
// خصم العمولة الفعلية من رصيد الفني. كان الرقم "2" مكتوباً حرفياً بثلاث
// مواضع مستقلة بمنطق العمل الفعلي (auth.routes.js، offers.routes.js،
// requests.routes.js) — لا علاقة له بـpublic/app.js (ملف ثابت منفصل كلياً،
// بلا نظام وحدات مشترك مع الخادم؛ يحمل ثابتاً مطابقاً خاصاً به لنفس السبب).
const FREE_TIER_QUOTA = 2;

// [FEAT-DEDUP-01] راجع DECISIONS.md — الحد الأقصى لمحاولات إدخال كود OTP
// الخاطئ قبل حذف طلب التسجيل/إعادة التعيين المعلَّق بالكامل — كان الرقم
// "5" مكرَّراً حرفياً 4 مرات مستقلة بـauth.routes.js (فحص الحد الأقصى
// وحساب "المحاولات المتبقية"، بمساري تسجيل العضوية وإعادة تعيين كلمة السر
// كلٌّ على حدة).
const OTP_MAX_ATTEMPTS = 5;

// [SEC-FIX-06] CSRF Protection — Origin/Referer validation for state-changing requests
// [SEC-FIX-TRUSTPROXY-CLOSED-01] راجع DECISIONS.md — sallehly.onrender.com
// أُزيل من كلا القائمتين أدناه: تحقَّق ميدانياً أن أصل Render الافتراضي غير
// قابل للوصول مباشرة (يرجع "not found")، فلا مسار عبره أصلاً؛ ولا أي عميل
// حقيقي أو كود آخر بالمستودعين يشير إليه. أصل مسموح مُدرَج صراحة لكنه ميت
// فعلياً يوحي بصلاحية مسار لا يعمل — إن أُعيد فتح الوصول المباشر لأي سبب
// مستقبلاً، يجب إعادة إضافته هنا صراحة عندها، لا تركه مُدرَجاً "احتياطاً".
const ALLOWED_ORIGINS = IS_PROD
  ? ['https://sallehly.com', 'https://www.sallehly.com']
  : ['http://localhost:3000', 'http://127.0.0.1:3000'];

const IO_CORS_ORIGINS = IS_PROD
  ? ['https://sallehly.com', 'https://www.sallehly.com']
  : ['http://localhost:3000'];

module.exports = {
  BASE, PORT, IS_PROD, JWT_SECRET, RESEND_API_KEY, RESEND_FROM,
  DATA_DIR, UPLOAD_DIR, COOKIE_OPTS, ALLOWED_ORIGINS, IO_CORS_ORIGINS,
  BACKUP_GITHUB_TOKEN, BACKUP_GITHUB_OWNER, BACKUP_GITHUB_REPO, ALERT_EMAIL,
  BLOCKING_REQUEST_STATUSES, BLOCKING_REQUEST_STATUSES_SQL,
  TECHNICIAN_ACTIVE_JOB_STATUSES, TECHNICIAN_ACTIVE_JOB_STATUSES_SQL,
  FREE_TIER_QUOTA, OTP_MAX_ATTEMPTS
};
