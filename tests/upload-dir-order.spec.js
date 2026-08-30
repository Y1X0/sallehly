// tests/upload-dir-order.spec.js
// [SEC-FIX-UPLOADDIR-ORDER-01] راجع DECISIONS.md وapp.js. هذا الاختبار يُشغّل
// نسخة سيرفر معزولة تماماً **بلا DATA_DIR مضبوطاً إطلاقاً** (بعكس كل ملفات
// الاختبار الأخرى التي تضبطه دائماً عبر playwright.config.js، ولهذا بالضبط
// لم تكتشف هذه الثغرة أي منها) — في هذه الحالة تحديداً يحسب config/env.js
// أن UPLOAD_DIR = public/uploads (داخل مجلد public نفسه)، وهذا هو الشرط
// الذي يُفعّل الثغرة: express.static('public') لو سُجِّل قبل راوت المصادقة
// يجد الملف المرفوع موجوداً فعلاً بالقرص ويقدّمه مباشرة بلا أي auth إطلاقاً.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const REPO_ROOT = path.join(__dirname, '..');
const PORT = 4056;
const BASE_URL = `http://127.0.0.1:${PORT}`;
// [SEC-FIX-UPLOADDIR-ORDER-01] بلا DATA_DIR، config/env.js يحسب هذا المسار
// بالضبط (path.join(BASE, 'public', 'uploads')) — راجع config/env.js.
const AUDIOS_DIR = path.join(REPO_ROOT, 'public', 'uploads', 'audios');

function waitForHttpReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = async () => {
      try {
        const res = await fetch(url + '/api/meta');
        if (res.ok) return resolve();
      } catch (_) {}
      if (Date.now() > deadline) return reject(new Error('انتهت مهلة انتظار جاهزية السيرفر المعزول'));
      setTimeout(tryOnce, 200);
    };
    tryOnce();
  });
}

test.describe.serial('[SEC-FIX-UPLOADDIR-ORDER-01] بلا DATA_DIR: express.static العام لا يتجاوز مصادقة /uploads', () => {
  let serverProcess;

  test.beforeAll(async () => {
    // env نظيفة تماماً بلا أي DATA_DIR موروث عمداً — هذا هو بالضبط السيناريو
    // المُختبَر (بيئة إنتاج/تطوير لم تضبط قرصاً دائماً، حالة موثَّقة كمقبولة
    // بـconfig/env.js نفسه، لا حالة نظرية).
    const cleanEnv = { ...process.env };
    delete cleanEnv.DATA_DIR;
    serverProcess = spawn('node', ['server.js'], {
      cwd: REPO_ROOT,
      env: {
        ...cleanEnv,
        NODE_ENV: 'test',
        PORT: String(PORT),
        JWT_SECRET: 'upload_dir_order_test_secret_isolated_instance_1234567890',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForHttpReady(BASE_URL, 20_000);
  });

  test.afterAll(async () => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGKILL');
    }
  });

  test('ملف مرفوع بمسار public/uploads/audios: طلب بلا Authorization لا يُرجع محتواه إطلاقاً', async () => {
    const filename = `test-orderbug-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.txt`;
    const filePath = path.join(AUDIOS_DIR, filename);
    fs.mkdirSync(AUDIOS_DIR, { recursive: true });
    fs.writeFileSync(filePath, 'SECRET-AUDIO-BYTES-SHOULD-NOT-LEAK');
    try {
      const res = await fetch(`${BASE_URL}/uploads/audios/${filename}`); // بلا أي هيدر Authorization
      expect(res.status).not.toBe(200);
      const body = await res.text();
      expect(body).not.toContain('SECRET-AUDIO-BYTES-SHOULD-NOT-LEAK');
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });
});
