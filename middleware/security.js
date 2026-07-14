// middleware/security.js
// هيلمت، الـ rate limiters، وفحص CSRF. أي تعديل على قواعد الحماية العامة مكانه هون.

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { IS_PROD, ALLOWED_ORIGINS, JWT_SECRET } = require('../config/env');

// [FIX-RATE-01] مفتاح تحديد هوية الطالب لأغراض الـ rate limiting.
// المشكلة القديمة: الاعتماد فقط على req.ip بيخلي كل المستخدمين المسجلين دخول اللي عم
// يشاركوا نفس IP (شبكات الموبايل 4G/5G بتستخدم CGNAT وبتشارك نفس IP العام بين كذا مستخدم
// بنفس الوقت) ينحسبوا كأنهم "طالب واحد" — فلما حمل كذا مستخدم يتجمع، الكل ينحظر مع بعض
// برسالة "Too many requests" حتى لو كل وحدة لحاله ما تجاوز الحد المعقول له.
// الحل: لو في توكن JWT صالح (مستخدم مسجل دخول) نستخدم معرف المستخدم نفسه كمفتاح، وهيك كل
// حساب إله سقفه المستقل بغض النظر عن الشبكة. لو ما في توكن (زائر/قبل تسجيل الدخول) نرجع
// لاعتماد الـ IP الحقيقي.
function identifyRequester(req) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : req.cookies?.token;
    if (token) {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded && decoded.id) return `user:${decoded.id}`;
    }
  } catch { /* توكن غير صالح/منتهي — نكمل ونعتمد على الـ IP بدل ما نفشل الطلب هون */ }
  // نفس منطق express-rate-limit الافتراضي (v7.5.1): الاعتماد المباشر على request.ip
  // (المحسوب أصلاً بشكل صحيح بفضل app.set('trust proxy', 1) بملف app.js).
  return `ip:${req.ip}`;
}

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
  // [FIX-RATE-LIMIT] رفعنا الحد من 1500 إلى 3000 كهامش أمان إضافي بجانب إصلاح الـ polling
  // بالفرونت اند (public/app.js). الحد القديم كان يُستهلك بسرعة بسبب نداءات v24RefreshBadges
  // المتكدسة كل 3 ثواني بدون انتظار الرد، خصوصاً وقت بطء/تأخر السيرفر (مثل Render spin-down).
  limit: IS_PROD ? 5000 : 100000,
  standardHeaders: true,
  legacyHeaders: false,
  // [FIX-RATE-01] مفتاح بالمستخدم بدل IP الخام — يمنع انهيار التطبيق لكل المستخدمين لما
  // كذا حساب يشتركوا بنفس IP (CGNAT بشبكات الموبايل).
  keyGenerator: identifyRequester,
  // [FIX-RATE-LIMIT] رسالة عربية مخصصة بدل الرسالة الإنجليزية الافتراضية
  // ("Too many requests, please try again later.") حتى تكون تجربة المستخدم متسقة مع بقية الليميترز.
  message: { error: 'عدد كبير من الطلبات، حاول بعد قليل' },
  skip: (req) => {
    const path = req.path || '';

    if (
      path.startsWith('/uploads') ||
      path.startsWith('/socket.io') ||
      path === '/' ||
      path.endsWith('.css') ||
      path.endsWith('.js')
    ) return true;

    // مسارات القراءة الحية لها pollingLimiter مستقل، لذلك لا نحسبها مرتين
    // ضمن الحد العام. هذا يمنع تعطّل المحفظة والباقات والدردشة معاً بسبب
    // تحديثات الواجهة الدورية أو أحداث Socket المتقاربة.
    if (req.method === 'GET') {
      return path === '/api/requests' ||
        path === '/api/chats' ||
        /^\/api\/requests\/\d+\/messages$/.test(path) ||
        path.startsWith('/api/wallet') ||
        path.startsWith('/api/topups') ||
        path.startsWith('/api/packages') ||
        path.startsWith('/api/notifications');
    }

    return false;
  }
});

// [FIX-RATE-02] limiter مستقل وسخي لمسارات "الاستعلام الدوري" (badges/طلباتي) — سقف عالي لكل
// مستخدم (وليس لكل الشبكة) لإنها قراءة عادية ومتوقّعة، لكن برضه محدود لمنع أي انفلات فعلي
// (تبويبات متعددة مفتوحة بنفس الوقت، أو أي حلقة لا نهائية بالواجهة مستقبلاً).
const pollingLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 600, // حد مستقل وسخي لطلبات القراءة الحية لكل مستخدم
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: identifyRequester,
  message: { error: 'طلبات تحديث كثيرة، حاول بعد لحظات' }
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
  loginLimiter, passwordLimiter, registerLimiter, requestsLimiter, messagesLimiter, otpLimiter,
  pollingLimiter
};
