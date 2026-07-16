// app.js
// بناء Express فقط: middleware + الملفات الثابتة. ما في server.listen ولا socket.io هون —
// هيك بيصير سهل تستورد app.js لوحده بالاختبارات (tests) بدون ما تشغل سيرفر فعلي أو DB اتصال حقيقي.

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const env = require('./config/env');
const security = require('./middleware/security');

function createApp() {
  const app = express();

  // Render/Proxy fix: trust the first reverse proxy so express-rate-limit
  // can read X-Forwarded-For safely without throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
  // [FIX-XFF] كان مضبوط على 1، بس XFF-DEBUG logs أثبتت إنه في هوبين فعلياً قبل ما الطلب يوصل
  // للتطبيق: Cloudflare edge (172.69.x/172.71.x) ثم بروكسي Render الداخلي (10.x.x.x).
  // بـ trust proxy=1 كان req.ip بيتوقف عند عنوان Render الداخلي (10.x.x.x) بدل الـ IP الحقيقي
  // للمستخدم — وبما إنه عناوين Render الداخلية محدودة العدد وبتتوزع (round-robin) بين كل
  // المستخدمين، كان express-rate-limit (اللي بيحسب الحد حسب req.ip) عم يحط عشرات المستخدمين
  // المختلفين بنفس "صندوق" الحد الأقصى بالغلط، وهاد السبب الجذري وراء ظهور 429 بشكل متكرر
  // وغير منطقي حتى لمستخدم واحد.
  app.set('trust proxy', 2);

  app.use(security.helmetMiddleware);
  app.use(cookieParser());
  app.use(security.csrfCheck);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(env.BASE, 'public')));
  // [FIX-CHATIMG-02] قدّم الملفات المرفوعة دائماً وبدون شرط — سواء كانت
  // env.UPLOAD_DIR تشير لقرص دائم (DATA_DIR مضبوط) أو لمجلد داخل كود
  // التطبيق نفسه (DATA_DIR غير مضبوط، وقتها UPLOAD_DIR = public/uploads
  // أصلاً حسب config/env.js فتُغطّى بالسطر أعلاه أيضاً بلا تعارض). قبل هذا
  // التعديل، تسجيل هذا المسار بأكمله كان مشروطاً بوجود DATA_DIR فقط — لو
  // البيئة لم تُعرِّفه لأي سبب (خطأ إعداد على Render مثلاً)، /uploads/* كان
  // سيرجع 404 دائماً بلا أي تحذير أو أثر بالسجلات يوضّح السبب.
  app.use('/uploads', express.static(env.UPLOAD_DIR));

  return app;
}

module.exports = createApp;
