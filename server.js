// server.js
// نقطة الدخول فقط: يبني الـ deps ويشغّل السيرفر. ما في middleware ولا routes ولا منطق
// أعمال هون — الـ Express نفسه بملف app.js، وكل route بملفه تحت routes/.

// [FIX-11] بيئة الاختبار الآلي (Playwright) يجب أن تكون معزولة بالكامل عن ملف .env الحقيقي —
// خصوصاً حساب الأدمن (ADMIN_EMAIL/ADMIN_PASSWORD) الذي تعتمد عليه اختبارات المحفظة.
// لا يُشغّل .env إطلاقاً إلا إذا NODE_ENV مختلف عن 'test' — لا يغيّر أي شيء بالتطوير أو الإنتاج.
if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config?.();
}

const path = require('path');
const fs = require('fs');

const env = require('./config/env');
const { db, createDbBackup } = require('./config/db');
const createApp = require('./app');
// [TEMP-PERF-TRACE] أداة قياس مؤقتة فقط لتشخيص رسالة "الخادم يستغرق وقتاً" —
// لا تغيّر أي منطق. انظر middleware/perf-trace.js للتفاصيل وطريقة الإزالة.
const { installPerfTrace, wrapDbForPerfTrace, clientLogRoute } = require('./middleware/perf-trace');
// [PERF-HARDEN-01] مراقبة أداء دائمة اختيارية، مُعطّلة افتراضياً — منفصلة
// عن أداة التشخيص المؤقتة أعلاه. انظر middleware/perf-monitor.js.
const { installPerfMonitor } = require('./middleware/perf-monitor');
const { auth, requireRole, requireSuperAdmin, sign } = require('./middleware/auth');
const utilsHelpers = require('./utils/helpers');
const { createDbHelpers } = require('./utils/db-helpers');
const { upload, uploadAudio } = require('./middleware/upload');
const security = require('./middleware/security');
const { sendOtpEmail } = require('./services/email');
const { sendPush } = require('./services/push');
const { createSocket } = require('./services/socket');

const app = createApp();

// [TEMP-PERF-TRACE] يجب تركيبها هنا (أول شيء بعد إنشاء app، قبل أي route)
// حتى تقيس المدة الكاملة لكل طلب /api/*. wrapDbForPerfTrace يلف db.prepare
// فقط لقياس مدة .get()/.all()/.run() — لا يغيّر القيم المُرجَعة ولا رمي الأخطاء.
installPerfTrace(app);
wrapDbForPerfTrace(db);
app.post('/api/_debug/client-log', clientLogRoute);

// [PERF-HARDEN-01] لا شيء يحدث هنا ما لم يُفعَّل PERF_LOG_ENABLED صراحةً
// بمتغيرات البيئة — انظر تعليق middleware/perf-monitor.js.
installPerfMonitor(app);

// Socket.IO يحتاج app جاهز (بيلف عليه بـ http.createServer)، فلازم ننشئه بعد app مباشرة
// وقبل ما نوصل الـ routes (الـ routes محتاجة io عشان ترسل تحديثات لحظية).
const { server, io, safeEmit } = createSocket(app);
const dbHelpers = createDbHelpers(db);

// كل شي محتاجه أي route — مجمّع بمجموعات واضحة، ما في أي require متبادل بين الملفات.
const deps = {
  db,
  realtime: { io, safeEmit },
  middleware: { auth, requireRole, requireSuperAdmin, upload, uploadAudio },
  services: { sendOtpEmail, sendPush, createDbBackup, sign },
  utils: { ...utilsHelpers, ...dbHelpers },
  limiters: {
    loginLimiter: security.loginLimiter,
    registerLimiter: security.registerLimiter,
    passwordResetLimiter: security.passwordResetLimiter,
    messageLimiter: security.messageLimiter,
    offerLimiter: security.offerLimiter
  },
  constants: { COOKIE_OPTS: env.COOKIE_OPTS, BASE: env.BASE },
  path, fs
};

app.use('/api', require('./routes')(deps));

// V21 friendly upload/API error handler
app.use(security.apiErrorHandler);

app.get('*', (req, res) => res.sendFile(path.join(env.BASE, 'public', 'index.html')));

server.listen(env.PORT, () => console.log(`صلّحلي يعمل على http://localhost:${env.PORT}`));

// [PERF-HARDEN-03] لم يكن هناك أي معالجة لإشارات إيقاف العملية (SIGTERM/
// SIGINT) — عند كل نشر جديد على Render (أو أي منصة تُرسل SIGTERM قبل قتل
// العملية بمهلة سماح)، كانت العملية تُقتَل فوراً بلا أي فرصة لإنهاء الطلبات
// الجارية أو إغلاق اتصال قاعدة البيانات بشكل نظيف — كل مستخدم بمنتصف طلب
// وقت النشر يفقد اتصاله فجأة (connection reset) بدل أن يكتمل طلبه بشكل طبيعي.
// إغلاق نظيف: توقف عن قبول اتصالات جديدة، أغلق الاتصالات الخاملة (keep-alive)
// فوراً، انتظر اكتمال الطلبات الجارية فعلياً، ثم أغلق قاعدة البيانات. مهلة
// أمان (10 ثوانٍ) تفرض خروجاً فورياً لو تعطّل الإغلاق النظيف لأي سبب — لا
// تترك العملية معلّقة إلى الأبد بانتظار اتصال لن يُغلق.
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[SHUTDOWN] ${signal} — إغلاق نظيف جارٍ...`);

  const forceExitTimer = setTimeout(() => {
    console.error('[SHUTDOWN] تجاوز الإغلاق النظيف المهلة المسموحة، خروج فوري.');
    process.exit(1);
  }, 10000);
  forceExitTimer.unref();

  try { if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections(); } catch (e) {}
  try { io.close(); } catch (e) {}

  server.close((err) => {
    if (err) console.error('[SHUTDOWN] خطأ أثناء إغلاق سيرفر HTTP:', err.message);
    try { db.close(); } catch (e) { console.error('[SHUTDOWN] خطأ أثناء إغلاق قاعدة البيانات:', e.message); }
    console.log('[SHUTDOWN] تم الإغلاق النظيف بنجاح.');
    clearTimeout(forceExitTimer);
    process.exit(0);
  });
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// [PERF-HARDEN-03] شبكة أمان أخيرة على مستوى العملية — كل راوتات async
// المعروفة أُصلحت فردياً بـtry/catch (انظر routes/auth.routes.js)، لكن هذا
// يبقى كخط دفاع أخير ضد أي استثناء غير متوقّع بمكان لم نغطّه بعد (مثلاً كود
// مستقبلي جديد، أو معالج حدث Socket.IO). unhandledRejection يُسجَّل فقط
// ويستمر التشغيل (فشل عملية واحدة معزولة، ليس فساداً بحالة العملية العامة).
// uncaughtException أخطر (قد يعني حالة عملية غير موثوقة) — يُسجَّل ثم يُنفَّذ
// نفس الإغلاق النظيف أعلاه بدل الاستمرار بحالة قد تكون فاسدة أو القتل الفوري
// الخام (منصة النشر تُعيد تشغيل العملية تلقائياً بعد خروج نظيف).
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED-REJECTION]', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT-EXCEPTION]', err.stack || err.message);
  gracefulShutdown('uncaughtException');
});
