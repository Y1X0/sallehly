// app.js
// بناء Express فقط: middleware + الملفات الثابتة. ما في server.listen ولا socket.io هون —
// هيك بيصير سهل تستورد app.js لوحده بالاختبارات (tests) بدون ما تشغل سيرفر فعلي أو DB اتصال حقيقي.

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const env = require('./config/env');
const security = require('./middleware/security');

function createApp(deps) {
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

  // [SEC-FIX-UPLOADS-01] / [SEC-FIX-AUDIOAUTH-01] راجع DECISIONS.md —
  // avatars/payments/requests/audios (كل مجلدات public/uploads الأربعة
  // المستخدَمة فعلياً بالتطبيق) صارت جميعها وراء مصادقة حقيقية عبر
  // routes/protected-uploads.routes.js. express.static العام لـ/uploads
  // (كان fallback منفصل يخدم أي مجلد لا يطابق راوتاً محمياً بعد) حُذف نهائياً.
  //
  // [SEC-FIX-UPLOADDIR-ORDER-01] راجع DECISIONS.md — هذا الراوت **يجب** يُسجَّل
  // قبل express.static('public') أدناه، لا بعده. بدون DATA_DIR مضبوطاً
  // (config/env.js: UPLOAD_DIR = public/uploads بهذه الحالة تحديداً)، أي ملف
  // مرفوع يقع فعلياً داخل مجلد public نفسه — لو سُجِّل express.static('public')
  // أولاً، هو يجد الملف موجوداً فعلاً بالقرص ويقدّمه مباشرة بلا أي مرور على
  // auth middleware إطلاقاً، متجاوزاً كل حماية protected-uploads.routes.js
  // بصمت (كان هذا الترتيب الخاطئ موجوداً منذ SEC-FIX-UPLOADS-01 الأصلي، ولم
  // يُكتشَف لأن كل بيئات الاختبار تضبط DATA_DIR دائماً فتتفادى المسار المُعطوب).
  // deps اختياري عمداً (استيراد app.js وحده لاختبار خفيف بلا قاعدة بيانات
  // حقيقية، راجع تعليق أعلى هذا الملف)؛ بدونه /uploads/* يرجع 404 ببساطة
  // (express.static أدناه لا يزال يخدمه لو الملف موجود فعلياً بـpublic — لا
  // استخدام حقيقي، اختبار أو إنتاج، يستدعي createApp بدون deps اليوم، راجع server.js).
  if (deps) {
    app.use('/uploads', require('./routes/protected-uploads.routes')(deps));
  }
  app.use(express.static(path.join(env.BASE, 'public')));

  return app;
}

module.exports = createApp;
