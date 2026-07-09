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
  app.set('trust proxy', 1);

  // TEMPORARY DIAGNOSTIC — TODO: remove after verifying real hop count from Render logs.
  // Logs the raw X-Forwarded-For header plus what Express resolves req.ip/req.ips to under
  // the current `trust proxy: 1` setting, so we can confirm the actual proxy chain length
  // before changing that setting (see BUG-003 rate-limit investigation).
  app.use((req, res, next) => {
    console.log('[XFF-DEBUG]', {
      'x-forwarded-for': req.headers['x-forwarded-for'],
      'resolved req.ip': req.ip,
      'req.ips (trust proxy chain)': req.ips,
    });
    next();
  });

  app.use(security.helmetMiddleware);
  app.use(security.globalRateLimit);
  app.use(security.csrfCheck);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(express.static(path.join(env.BASE, 'public')));
  // قدّم الملفات المرفوعة من القرص الدائم (إن وُجد) حتى تظهر الصور بعد الـ deploy.
  if (process.env.DATA_DIR) {
    app.use('/uploads', express.static(env.UPLOAD_DIR));
  }

  return app;
}

module.exports = createApp;
