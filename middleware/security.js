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
  max: 10,
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
  max: 3,
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
      "script-src": ["'self'", "'unsafe-inline'", "https://unpkg.com"],
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
  limit: IS_PROD ? 1500 : 100000,
  standardHeaders: true,
  legacyHeaders: false,
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
