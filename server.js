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
