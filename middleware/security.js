// middleware/security.js
// الحماية العامة + Rate Limit لتسجيل الدخول وإنشاء الحساب وإعادة تعيين كلمة السر.

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

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: IS_PROD ? 10 : 1000,
  message: { error: 'تم تجاوز حد إنشاء الحسابات، حاول بعد ساعة' },
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
  message: { error: 'محاولات كثيرة جداً لإعادة تعيين كلمة السر، حاول بعد 15 دقيقة' },
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
  helmetMiddleware,
  csrfCheck,
  apiErrorHandler,
  loginLimiter,
  registerLimiter,
  passwordResetLimiter
};
