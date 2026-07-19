// tests/crash-safety.spec.js
// [PERF-HARDEN-03] يثبت الإصلاح مباشرة: قبله، أي خطأ غير متوقّع (استثناء
// قاعدة بيانات نادر مثلاً) داخل راوت async بلا try/catch يُسقط عملية Node
// بأكملها فوراً — وليس فقط هذا الطلب — لأن Express 4 لا يلتقط تلقائياً
// استثناءات الدوال async (فرق جوهري عن الدوال المتزامنة، التي يلتقطها Express
// بنفسه). أُثبت هذا فعلياً بتجربة مباشرة أثناء التدقيق (2026-07-19) قبل هذا
// الإصلاح، وهو نفس السبب الجذري الذي ضرب DELETE /me سابقاً (FIX-DELETE-CRASH-01).
//
// هذا الاختبار لا يستخدم سيرفر الاختبارات المشترك — يبني تطبيق Express صغيراً
// منفصلاً بنفس عملية Playwright نفسها، بـdb مزيّفة تُفشِل أي استعلام عمداً،
// ويتأكد أن الطلب يرجع 500 بدل أن يُسقط عملية الاختبار بأكملها. لو رجعت
// try/catch الخارجية بأي راوت من الأربعة أدناه، هذا الاختبار سيُسقط ملف
// الاختبارات كله فوراً (unhandled rejection) — دليل غير قابل للتزييف.

const { test, expect } = require('@playwright/test');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');

const authRoutesFactory = require('../routes/auth.routes');

function throwingDb(message = 'استثناء قاعدة بيانات محاكى (اختبار)') {
  return {
    prepare: () => ({
      get: () => { throw new Error(message); },
      all: () => { throw new Error(message); },
      run: () => { throw new Error(message); },
    }),
  };
}

function buildMinimalAuthApp(db) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  const deps = {
    db,
    realtime: {
      io: { in: () => ({ disconnectSockets: () => {} }), emit: () => {} },
      safeEmit: () => {},
    },
    middleware: {
      auth: (req, res, next) => { req.user = { id: 1, role: 'customer', name: 'test' }; next(); },
      upload: { single: () => (req, res, next) => next() },
    },
    services: {
      sign: () => 'fake-token',
      sendOtpEmail: async () => true,
    },
    utils: {
      clean: (s) => String(s || '').trim(),
      userPublic: (u) => u,
      anonymizeUser: () => {},
    },
    constants: { COOKIE_OPTS: {}, BASE: __dirname },
    limiters: {
      registerLimiter: (req, res, next) => next(),
      loginLimiter: (req, res, next) => next(),
      passwordResetLimiter: (req, res, next) => next(),
    },
  };

  app.use('/api', authRoutesFactory(deps));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function post(server, path, form) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const body = new URLSearchParams(form).toString();
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

test.describe('[PERF-HARDEN-03] راوتات auth async لا تُسقط العملية عند خطأ غير متوقّع', () => {
  test('POST /auth/login — خطأ قاعدة بيانات غير متوقّع يرجع 500، ولا يُسقط العملية', async () => {
    const server = await listen(buildMinimalAuthApp(throwingDb()));
    try {
      const res = await post(server, '/api/auth/login', { email: 'x@example.com', password: 'whatever123' });
      expect(res.status).toBe(500);
      expect(res.body.error).toBeTruthy();
      // وصولنا لهذا السطر أصلاً دليل أن العملية لم تُسقَط — لو رجعت try/catch
      // الخارجية بـ/auth/login، هذا الطلب كان سيُسقط ملف الاختبارات كله.
    } finally {
      server.close();
    }
  });

  test('POST /auth/register — خطأ قاعدة بيانات غير متوقّع يرجع 500، ولا يُسقط العملية', async () => {
    const server = await listen(buildMinimalAuthApp(throwingDb()));
    try {
      const res = await post(server, '/api/auth/register', {
        role: 'customer', name: 'مستخدم اختبار', email: 'x2@example.com', phone: '0791234567', password: 'TestPass123', city: 'عمان',
      });
      expect(res.status).toBe(500);
      expect(res.body.error).toBeTruthy();
    } finally {
      server.close();
    }
  });

  test('POST /auth/forgot-password — خطأ قاعدة بيانات غير متوقّع يرجع 500، ولا يُسقط العملية', async () => {
    // خطأ يُرمى تحديداً بعد فحص وجود المستخدم (الفرع الذي لا يُنشئ enumeration
    // signal) — لذا نحتاج db تُرجع مستخدماً موجوداً أولاً ثم ترمي لاحقاً.
    const db = {
      prepare: (sql) => ({
        get: () => (String(sql).includes('SELECT') ? { id: 1, name: 'مستخدم', email: 'x3@example.com' } : null),
        run: () => { throw new Error('استثناء قاعدة بيانات محاكى (اختبار)'); },
        all: () => [],
      }),
    };
    const server = await listen(buildMinimalAuthApp(db));
    try {
      const res = await post(server, '/api/auth/forgot-password', { email: 'x3@example.com' });
      expect(res.status).toBe(500);
      expect(res.body.error).toBeTruthy();
    } finally {
      server.close();
    }
  });

  test('POST /me/password — خطأ قاعدة بيانات غير متوقّع يرجع 500، ولا يُسقط العملية', async () => {
    const server = await listen(buildMinimalAuthApp(throwingDb()));
    try {
      const res = await post(server, '/api/me/password', { current_password: 'x', new_password: 'newpassword123' });
      expect(res.status).toBe(500);
      expect(res.body.error).toBeTruthy();
    } finally {
      server.close();
    }
  });

  test('DELETE /me — خطأ قاعدة بيانات غير متوقّع (خارج نطاق FIX-DELETE-CRASH-01 الأصلي) يرجع 500، ولا يُسقط العملية', async () => {
    // db.prepare('SELECT * FROM users WHERE id=?') ترمي هنا — قبل نقطة
    // anonymizeUser المحمية أصلاً، لإثبات أن الحماية الجديدة تغطي ما قبلها أيضاً.
    const server = await listen(buildMinimalAuthApp(throwingDb()));
    try {
      const res = await new Promise((resolve, reject) => {
        const port = server.address().port;
        const body = new URLSearchParams({ password: 'whatever123' }).toString();
        const req = http.request(
          { host: '127.0.0.1', port, path: '/api/me', method: 'DELETE', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } },
          (r) => {
            let data = '';
            r.on('data', (c) => (data += c));
            r.on('end', () => resolve({ status: r.statusCode, body: data ? JSON.parse(data) : null }));
          }
        );
        req.on('error', reject);
        req.end(body);
      });
      expect(res.status).toBe(500);
      expect(res.body.error).toBeTruthy();
    } finally {
      server.close();
    }
  });
});
