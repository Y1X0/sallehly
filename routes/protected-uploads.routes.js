// routes/protected-uploads.routes.js — يخدم /uploads/avatars و/uploads/payments
// و/uploads/requests (صور الشات + صور المشكلة) وراء مصادقة حقيقية، بدل
// express.static العام (app.js). audios/ لسا غير مُغطّاة إطلاقاً (تحتاج تحقيقاً
// فنياً منفصلاً — راجع DECISIONS.md). أي طلب لا يطابق راوتاً هون يكمل
// لـexpress.static التالي بالسلسلة كما هو اليوم تماماً.
//
// [SEC-FIX-UPLOADS-01] راجع DECISIONS.md — كانت كل ملفات public/uploads تُقدَّم
// بلا أي تحقق صلاحية إطلاقاً، فقط اسم ملف يصعب تخمينه (crypto.randomBytes،
// راجع utils/helpers.js:safeUploadName). أي رابط مسرَّب (سجل متصفح، لقطة شاشة)
// يكشف الملف بشكل دائم.

const express = require('express');
const path = require('path');
const { UPLOAD_DIR } = require('../config/env');

const SAFE_FILENAME_RE = /^[A-Za-z0-9_.-]+$/;
function isSafeFilename(name) {
  return typeof name === 'string' && SAFE_FILENAME_RE.test(name) && !name.includes('..');
}

module.exports = function (deps) {
  const { db } = deps;
  const { auth } = deps.middleware;
  const { canAccessRequestChat } = deps.utils;
  const router = express.Router();

  // [SEC-FIX-UPLOADS-01] الصور الشخصية ليس لها حد وصول مقيّد بهذا التطبيق أصلاً —
  // GET /technicians/:id/profile (routes/technicians.routes.js) يعرض avatar_url
  // بالفعل لأي مستخدم مسجَّل دخوله، بلا أي علاقة/ملكية مطلوبة. الفحص هون يطابق
  // نفس الانفتاح تماماً: مصادقة (auth) تكفي وحدها، لا حاجة لفحص إضافي — نفس
  // القاعدة الموجودة أصلاً، لا قاعدة جديدة.
  router.get('/avatars/:filename', auth, (req, res) => {
    const { filename } = req.params;
    if (!isSafeFilename(filename)) return res.status(400).json({ error: 'اسم ملف غير صحيح', code: 'UPLOAD_INVALID_FILENAME' });
    // res.sendFile يرفض مساراً غير مطلق (يرمي "path must be absolute or
    // specify root") — UPLOAD_DIR قد يكون نسبياً (env.DATA_DIR بيئة الاختبار
    // مثلاً: './data-test')، بعكس express.static الذي كان يتحمّل مساراً
    // نسبياً بلا مشكلة داخلياً. path.resolve يضمن مساراً مطلقاً دائماً.
    res.sendFile(path.resolve(UPLOAD_DIR, 'avatars', filename), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'الملف غير موجود', code: 'UPLOAD_NOT_FOUND' });
    });
  });

  // [SEC-FIX-UPLOADS-01] نفس قاعدة صلاحية GET /topups بالضبط (routes/topups.routes.js):
  // الأدمن يشوف كل شيء، الفني يشوف إيصالاته هو فقط. لا قاعدة جديدة — نفس المنطق
  // المطبَّق أصلاً على القائمة، مطبَّق هون على ملف واحد.
  router.get('/payments/:filename', auth, (req, res) => {
    const { filename } = req.params;
    if (!isSafeFilename(filename)) return res.status(400).json({ error: 'اسم ملف غير صحيح', code: 'UPLOAD_INVALID_FILENAME' });
    const receiptUrl = '/uploads/payments/' + filename;
    const topup = db.prepare('SELECT technician_id FROM topups WHERE receipt_url=?').get(receiptUrl);
    if (!topup) return res.status(404).json({ error: 'الملف غير موجود', code: 'UPLOAD_NOT_FOUND' });
    if (req.user.role !== 'admin' && topup.technician_id !== req.user.id) {
      return res.status(403).json({ error: 'غير مصرح', code: 'FORBIDDEN_GENERIC' });
    }
    res.sendFile(path.resolve(UPLOAD_DIR, 'payments', filename), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'الملف غير موجود', code: 'UPLOAD_NOT_FOUND' });
    });
  });

  function sendRequestsFile(res, filename) {
    res.sendFile(path.resolve(UPLOAD_DIR, 'requests', filename), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'الملف غير موجود', code: 'UPLOAD_NOT_FOUND' });
    });
  }

  // [SEC-FIX-UPLOADS-01] راجع DECISIONS.md — problem_image_url ليس له نفس
  // قاعدة صلاحية صور الشات: فني يتصفّح فقط (لسا ما قدّم عرضاً) يحتاج يشوف
  // صورة المشكلة أصلاً ليقدر يقدّر سعر عرضه — بالضبط نفس شرط WHERE بفرع الفني
  // بـGET /requests (routes/requests.routes.js) الذي يقرّر أصلاً مين يشوف هذا
  // الطلب بقائمته. الفحص هون على صف واحد فقط (لا قائمة كاملة)، فلا ينطبق
  // عليه سبب PERF-01 (تفادي تحميل الجدول كاملاً بجافاسكربت) — يُقارَن بجافاسكربت
  // مباشرة، بنفس عمليات المقارنة الحرفية المستخدَمة هناك (city/areas/services)،
  // بدل صياغة SQL جديدة قد تنحرف بصمت عن الأصل بتفصيل دقيق (نفس فئة الخطر
  // الموثَّقة بـ[SEC-FIX-CHATSCOPE-*]).
  function canBrowseRequest(request, techId) {
    if (!['بانتظار العروض', 'وصلت عروض'].includes(request.status)) return false;
    const tech = db.prepare('SELECT services, city, areas FROM users WHERE id=?').get(techId);
    if (!tech) return false;
    const sv = (tech.services || '').split(',').filter(Boolean);
    if (!sv.includes(request.service)) return false;
    const areas = tech.areas || '';
    if (request.city === tech.city) return true;
    if (areas !== '' && areas.includes(request.city)) return true;
    if (request.area && areas !== '' && areas.includes(request.area)) return true;
    return false;
  }

  // يعترض صور الشات وصور المشكلة (problem_image_url) معاً ضمن requests/،
  // كلٌّ بقاعدة صلاحيته الخاصة. أي اسم ملف لا يطابق أياً منهما next() فوراً
  // بلا أي مصادقة مطلوبة هون — express.static بعده يخدمه كما كان قبل هذا
  // التعديل (لا يوجد نوع ثالث بهذا المجلد اليوم، لكن هذا يبقي السلوك آمناً
  // افتراضياً لو ظهر نوع جديد لاحقاً).
  router.get('/requests/:filename', (req, res, next) => {
    const { filename } = req.params;
    if (!isSafeFilename(filename)) return next();
    const imageUrl = '/uploads/requests/' + filename;

    // صورة شات؟ نفس قاعدة الشات بالضبط: canAccessRequestChat (utils/helpers.js)،
    // دالة موحَّدة مستخدَمة أصلاً بـREST (routes/chat.routes.js) وSocket.IO
    // (services/socket.js)، لا فحص جديد.
    const message = db.prepare("SELECT request_id FROM messages WHERE body=?").get('[image]' + imageUrl);
    if (message) {
      return auth(req, res, () => {
        const request = db.prepare('SELECT * FROM requests WHERE id=?').get(message.request_id);
        if (!request || !canAccessRequestChat(req.user, request)) {
          return res.status(403).json({ error: 'غير مصرح', code: 'FORBIDDEN_GENERIC' });
        }
        sendRequestsFile(res, filename);
      });
    }

    // صورة مشكلة (problem_image_url)؟
    const request = db.prepare('SELECT * FROM requests WHERE problem_image_url=?').get(imageUrl);
    if (!request) return next();

    auth(req, res, () => {
      const allowed = canAccessRequestChat(req.user, request) ||
        (req.user.role === 'technician' && canBrowseRequest(request, req.user.id));
      if (!allowed) return res.status(403).json({ error: 'غير مصرح', code: 'FORBIDDEN_GENERIC' });
      sendRequestsFile(res, filename);
    });
  });

  return router;
};
