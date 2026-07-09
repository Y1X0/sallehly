// middleware/security.js
// هيلمت، الـ rate limiters، وفحص CSRF. أي تعديل على قواعد الحماية العامة مكانه هون.

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { IS_PROD, ALLOWED_ORIGINS } = require('../config/env');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'محاولات تسجيل دخول كثيرة، حاول بعد 15 دقيقة' },
  standardHeaders: true,
  legacyHeaders: false
});
const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'محاولات تغيير كلمة السر كثيرة، حاول بعد 15 دقيقة' },
  standardHeaders: true,
  legacyHeaders: false
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  // [FIX-10] نفس نمط globalRateLimit: حد صارم بالإنتاج، مرتفع بالتطوير/الاختبار حتى لا تصطدم
  // اختبارات Playwright الآلية بالحد الحقيقي أثناء تسجيل عدة حسابات اختبار متتالية.
  max: IS_PROD ? 10 : 1000,
  message: { error: 'تم تجاوز حد إنشاء الحسابات، حاول بعد ساعة' },
  standardHeaders: true,
  legacyHeaders: false
});
const requestsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'تم تجاوز حد إنشاء الطلبات، حاول بعد ساعة' },
  standardHeaders: true,
  legacyHeaders: false
});
const messagesLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'أرسلت رسائل كثيرة جداً، انتظر دقيقة' },
  standardHeaders: true,
  legacyHeaders: false
});
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  // [FIX-10] نفس السبب أعلاه — otpLimiter يشارك /auth/register وأي تسجيل اختباري متكرر يصطدم به بسرعة
  max: IS_PROD ? 3 : 1000,
  message: { error: 'طلبت كوداً كثيراً، انتظر 10 دقائق' },
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
      // ستكسر شكل الواجهة بالكامل؛ تحتاج إعادة هيكلة منفصلة مؤجّلة بثقة حاليًا.
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

const globalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  // [FIX-RATE-LIMIT] رُفع الحد من 1500 إلى 3000 كهامش أمان إضافي بجانب إصلاح الـ polling
  // بالفرونت اند (public/app.js). الحد القديم كان يُستهلك بسرعة بسبب نداءات v24RefreshBadges
  // المتكدسة كل 3 ثواني بدون انتظار الرد، خصوصاً وقت بطء/تأخر السيرفر (مثل Render spin-down).
  limit: IS_PROD ? 3000 : 100000,
  standardHeaders: true,
  legacyHeaders: false,
  // [FIX-RATE-LIMIT] أضيفت رسالة عربية مخصصة بدل الرسالة الإنجليزية الافتراضية
  // ("Too many requests, please try again later.") حتى تكون تجربة المستخدم متسقة مع بقية الليميترز.
  message: { error: 'عدد كبير من الطلبات، حاول بعد قليل' },
  skip: (req) => req.path.startsWith('/uploads') || req.path.startsWith('/socket.io') || req.path === '/' || req.path.endsWith('.css') || req.path.endsWith('.js')
});

// [SEC-FIX-06] CSRF Protection — Origin/Referer validation for state-changing requests
function csrfCheck(req, res, next) {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.path.startsWith('/api/')) {
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    // Allow requests with no origin (same-origin fetch, server-to-server)
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return res.status(403).json({ error: 'طلب غير مصرح به (CSRF)' });
    }
    if (!origin && referer) {
      try {
        const refOrigin = new URL(referer).origin;
        if (!ALLOWED_ORIGINS.includes(refOrigin)) {
          return res.status(403).json({ error: 'طلب غير مصرح به (CSRF)' });
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
    if (String(msg).includes('File too large')) return res.status(400).json({ error: 'حجم الصورة كبير، الحد الأقصى 3MB' });
    if (String(msg).includes('نوع الملف') || String(msg).includes('نوع التسجيل')) return res.status(400).json({ error: msg });
    // In production, don't leak internal error details
    if (IS_PROD) return res.status(400).json({ error: 'حدث خطأ في الطلب' });
    return res.status(400).json({ error: msg });
  }
  next();
}

module.exports = {
  helmetMiddleware, globalRateLimit, csrfCheck, apiErrorHandler,
  loginLimiter, passwordLimiter, registerLimiter, requestsLimiter, messagesLimiter, otpLimiter
};
