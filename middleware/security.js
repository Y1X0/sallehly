// middleware/security.js
// الحماية العامة + Rate Limit لتسجيل الدخول وإنشاء الحساب وإعادة تعيين كلمة السر.

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { IS_PROD, ALLOWED_ORIGINS } = require('../config/env');
const { alertError } = require('../services/error-alert');

// [PERF-HARDEN-01] كان max=20 ثابتاً بلا استثناء بيئة الاختبار — الوحيد بين
// كل الحدود الخمسة بهذا الملف بلا نمط IS_PROD الموجود بباقيها. بما أن هذا
// الحد يُحسَب على مستوى IP واحد (127.0.0.1 لكل عمليات Playwright)، وتسجيلات
// دخول الأدمن تتكرر عبر عشرات الاختبارات المختلفة بنفس تشغيلة الاختبارات،
// أي إضافة اختبار جديد يسجّل دخول الأدمن كانت قادرة فعلياً (وأثبتت ذلك) على
// تجاوز الحد فتُفشل اختبارات لاحقة بـ429 لا علاقة لها بما تختبره فعلياً.
// الإنتاج (IS_PROD=true) يبقى بلا أي تغيير: الحد الحقيقي يبقى 20 تماماً.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: IS_PROD ? 20 : 1000,
  message: { error: 'محاولات تسجيل دخول كثيرة، حاول بعد 15 دقيقة', code: 'RATE_LIMIT_LOGIN' },
  standardHeaders: true,
  legacyHeaders: false
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: IS_PROD ? 10 : 1000,
  message: { error: 'تم تجاوز حد إنشاء الحسابات، حاول بعد ساعة', code: 'RATE_LIMIT_REGISTER' },
  standardHeaders: true,
  legacyHeaders: false
});

// [SEC-FIX-17] /auth/forgot-password و /auth/reset-password كانا بدون أي حد
// طلبات — بعكس login/register. forgot-password يبعث إيميل حقيقي عبر Resend
// بكل نداء ناجح، فبدون هذا الحد كان أي طرف يقدر يرسل عدد غير محدود إيميلات
// إعادة التعيين لنفس البريد (إزعاج/Harassment) ويستهلك حصة Resend المجانية أو
// المدفوعة بلا أي كلفة عليه. الحماية من تخمين الـOTP نفسه موجودة أصلاً بشكل
// منفصل (5 محاولات لكل طلب معلّق قبل حذفه — routes/auth.routes.js) وتبقى كما
// هي دون تغيير؛ هذا الحد إضافي على مستوى معدل الطلبات نفسه.
const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: IS_PROD ? 5 : 1000,
  message: { error: 'محاولات كثيرة جداً لإعادة تعيين كلمة السر، حاول بعد 15 دقيقة', code: 'RATE_LIMIT_PASSWORD_RESET' },
  standardHeaders: true,
  legacyHeaders: false
});

// [SEC-FIX-18] /requests/:id/messages و /requests/:id/offer كانا بدون أي حد
// طلبات — بعكس auth/*. أُثبت عملياً أن 25 رسالة متتالية دون أي تأخير تُقبل
// جميعها بلا أي عرقلة (كل رسالة تُفعّل Socket.IO event + محاولة Push، وكل عرض
// يُنشئ صفاً بقاعدة البيانات ويُرسل إشعارات). الحدود أدناه سخية بما يكفي لأي
// استخدام طبيعي (محادثة حقيقية بين طرفين، أو فني يستعرض ويقدّم على عدة طلبات)
// لكنها تمنع نمط spam الواضح. نفس نمط IS_PROD الموجود أعلاه لباقي الحدود —
// حتى لا تتأثر اختبارات Playwright الآلية بالحد الحقيقي.
const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: IS_PROD ? 30 : 1000,
  message: { error: 'رسائل كثيرة جداً خلال وقت قصير، حاول بعد قليل', code: 'RATE_LIMIT_MESSAGE' },
  standardHeaders: true,
  legacyHeaders: false
});

const offerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: IS_PROD ? 20 : 1000,
  message: { error: 'عروض كثيرة جداً خلال وقت قصير، حاول بعد قليل', code: 'RATE_LIMIT_OFFER' },
  standardHeaders: true,
  legacyHeaders: false
});

// [SEC-FIX-REQSPAM-01] راجع DECISIONS.md — POST /requests كان بلا أي حد
// طلبات إطلاقاً، الوحيد بين كل نقاط الإنشاء الحقيقية بهذا الملف. كل نداء
// ناجح يُدرج صفاً بقاعدة البيانات ويُنشئ إشعاراً دائماً لكل فني على المنصة
// (routes/requests.routes.js:getTechnicianIds/notifyBatch) — عملية متزامنة
// تتناسب تكلفتها مع عدد الفنيين، لا مع أي شيء يخصّ العميل نفسه. حد أضيق
// بكثير من offerLimiter عمداً: عميل حقيقي نادراً ما ينشئ أكثر من طلب أو
// طلبين بالساعة، بينما 10/ساعة كافية جداً لأي استخدام طبيعي وتمنع تماماً
// نمط الإغراق (كل نداء يُكلِّف كل مستخدم آخر على المنصة أثناء تنفيذه).
const requestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: IS_PROD ? 10 : 1000,
  message: { error: 'طلبات كثيرة جداً خلال وقت قصير، حاول بعد قليل', code: 'RATE_LIMIT_REQUEST' },
  standardHeaders: true,
  legacyHeaders: false
});

// [SEC-FIX-SUPPORTSPAM-01] راجع DECISIONS.md — POST /support، POST
// /support/:id/messages، POST /complaints، وPOST /requests/:id/report-message
// كانت الوحيدة بين نقاط الإنشاء الحقيقية بهذا المشروع بلا أي حد طلبات
// إطلاقاً (بعكس requestLimiter/offerLimiter/messageLimiter أعلاه). مستخدم
// مسجَّل دخوله (كل هذه المسارات تتطلب auth) يقدر نظرياً يُغرق لوحة الأدمن
// برسائل/بلاغات متكررة. حد واحد مشترك لكل الأربعة (لا حاجة لتمييزها — نفس
// فئة التهديد بالضبط: إزعاج تشغيلي بحساب حقيقي، لا وصول مجهول).
const supportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: IS_PROD ? 15 : 1000,
  message: { error: 'طلبات كثيرة جداً خلال وقت قصير، حاول بعد قليل', code: 'RATE_LIMIT_SUPPORT' },
  standardHeaders: true,
  legacyHeaders: false
});

// [SEC-FIX-13] Helmet with explicit frameguard DENY + CSP hardened
const helmetMiddleware = helmet({
  frameguard: { action: 'deny' },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      // [SEC-FIX-13b] أُزيلت 'unsafe-inline' من script-src فقط، بعد نقل السكربت الوحيد الـinline
      // بـindex.html لملف خارجي (public/init.js). style-src أبقيناها كما هي عمداً — app.js فيه
      // ~118 خاصية style="" مباشرة (تنسيق ديناميكي حقيقي بمولّد الواجهة)، وإزالتها بهالمرحلة
      // ستكسر شكل الواجهة بالكامل؛ تحتاج إعادة هيكلة منفصلة مؤجّلة بثقة حالياً.
      // script-src-attr أبقيناها كذلك — app.js فيه ~107 onclick="" (نفس السبب، مؤجّلة بثقة).
      "script-src": ["'self'", "https://unpkg.com"],
      "script-src-attr": ["'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://unpkg.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
      "img-src": ["'self'", "data:", "blob:", "https://*.tile.openstreetmap.org", "https://tile.openstreetmap.org", "https://unpkg.com"],
      "connect-src": ["'self'", "wss:", "https://*.tile.openstreetmap.org", "https://tile.openstreetmap.org", "https://unpkg.com"],
      "media-src": ["'self'", "blob:"],
      "frame-src": ["'self'", "https://www.openstreetmap.org", "https://maps.google.com", "https://www.google.com"]
    }
  }
});

// [SEC-FIX-06] CSRF Protection — Origin/Referer validation for state-changing requests
function csrfCheck(req, res, next) {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.path.startsWith('/api/')) {
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    // Allow requests with no origin (same-origin fetch, server-to-server)
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return res.status(403).json({ error: 'طلب غير مصرح به (CSRF)', code: 'CSRF_REJECTED' });
    }
    if (!origin && referer) {
      try {
        const refOrigin = new URL(referer).origin;
        if (!ALLOWED_ORIGINS.includes(refOrigin)) {
          return res.status(403).json({ error: 'طلب غير مصرح به (CSRF)', code: 'CSRF_REJECTED' });
        }
      } catch { /* invalid referer — let it pass, rate-limiting handles abuse */ }
    }
  }
  next();
}

// V21 friendly upload/API error handler
function apiErrorHandler(err, req, res, next) {
  if (err) {
    const msg = err.message || 'حدث خطأ في الخادم';
    if (String(msg).includes('File too large')) return res.status(400).json({ error: 'حجم الصورة كبير، الحد الأقصى 3MB', code: 'FILE_TOO_LARGE' });
    if (String(msg).includes('نوع الملف') || String(msg).includes('نوع التسجيل')) {
      const code = String(msg).includes('نوع الملف') ? 'FILE_TYPE_NOT_ALLOWED' : 'AUDIO_TYPE_NOT_ALLOWED';
      return res.status(400).json({ error: msg, code });
    }
    // [MON-FIX-01] الحالات أعلاه أخطاء تحقق متوقَّعة (حجم/نوع ملف) ولا تستحق
    // تنبيهاً. ما يصل هون فعلياً غير متوقَّع — لم يكن يُسجَّل بالسجلّات إطلاقاً
    // قبل هذا التعديل (كان يتحوّل مباشرة لاستجابة 400 بصمت تام، بلا أي أثر
    // بالسجلّات يوضّح أن خطأ حقيقياً حدث أصلاً). الآن يُسجَّل ويُنبَّه — بلا
    // انتظار (fire-and-forget)، بنفس فلسفة uploadBackupOffsite.
    console.error('[API-ERROR]', err.stack || msg);
    alertError('API error', err).catch(() => {});

    // In production, don't leak internal error details
    if (IS_PROD) return res.status(400).json({ error: 'حدث خطأ في الطلب' });
    return res.status(400).json({ error: msg });
  }
  next();
}

module.exports = {
  helmetMiddleware,
  csrfCheck,
  apiErrorHandler,
  loginLimiter,
  registerLimiter,
  passwordResetLimiter,
  messageLimiter,
  offerLimiter,
  requestLimiter,
  supportLimiter
};
