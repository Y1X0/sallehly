// routes/protected-uploads.routes.js — يخدم /uploads/avatars و/uploads/payments
// و(صور الشات تحديداً ضمن) /uploads/requests وراء مصادقة حقيقية، بدل
// express.static العام (app.js). صور المشكلة (problem_image_url) بنفس مجلد
// requests/ لسا غير مُغطّاة (خطوة لاحقة من نفس الإصلاح، قاعدة صلاحيتها مختلفة —
// راجع DECISIONS.md)؛ وaudios/ لسا غير مُغطّاة إطلاقاً. أي طلب لا يطابق راوتاً
// هون (بما فيها صور المشكلة وaudios/) يكمل لـexpress.static التالي بالسلسلة
// كما هو اليوم تماماً.
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

  // [SEC-FIX-UPLOADS-01] يعترض صور الشات فقط ضمن requests/ (يطابق filename
  // مع body رسالة '[image]...' موجودة فعلياً) — نفس قاعدة صلاحية الشات
  // بالضبط: canAccessRequestChat (utils/helpers.js)، دالة موحَّدة مستخدَمة
  // أصلاً بـREST (routes/chat.routes.js) وSocket.IO (services/socket.js)،
  // لا فحص جديد. لو الملف مش صورة شات معروفة (على الأغلب problem_image_url —
  // خطوة لاحقة من نفس الإصلاح لسا ما نُفِّذت)، next() فوراً بلا أي مصادقة
  // مطلوبة هون — express.static بعده يخدمه بالضبط كما كان قبل هذا التعديل،
  // بلا أي تغيير سلوكي على problem_image_url بهذه الخطوة تحديداً.
  router.get('/requests/:filename', (req, res, next) => {
    const { filename } = req.params;
    if (!isSafeFilename(filename)) return next();
    const imageUrl = '/uploads/requests/' + filename;
    const message = db.prepare("SELECT request_id FROM messages WHERE body=?").get('[image]' + imageUrl);
    if (!message) return next();

    auth(req, res, () => {
      const request = db.prepare('SELECT * FROM requests WHERE id=?').get(message.request_id);
      if (!request || !canAccessRequestChat(req.user, request)) {
        return res.status(403).json({ error: 'غير مصرح', code: 'FORBIDDEN_GENERIC' });
      }
      res.sendFile(path.resolve(UPLOAD_DIR, 'requests', filename), (err) => {
        if (err && !res.headersSent) res.status(404).json({ error: 'الملف غير موجود', code: 'UPLOAD_NOT_FOUND' });
      });
    });
  });

  return router;
};
