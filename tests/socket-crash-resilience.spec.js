// tests/socket-crash-resilience.spec.js
// [SEC-FIX-SOCKETCRASH-01] راجع DECISIONS.md وservices/socket.js. هذا الاختبار
// يُشغّل نسخة سيرفر معزولة تماماً بمنفذ/DATA_DIR مستقلَّين (لا علاقة لها بسيرفر
// الاختبارات المشترك على المنفذ 4001 الذي تعتمد عليه كل ملفات الاختبار الأخرى) —
// عمداً، لأن الثغرة المُختبَرة هنا **تُسقط العملية بأكملها**؛ تشغيلها ضد السيرفر
// المشترك كان سيُفشل كل اختبار آخر بالمجموعة بصمت بدل إثبات هذه الثغرة تحديداً.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { test, expect } = require('@playwright/test');
const { io: ioClient } = require('socket.io-client');

const REPO_ROOT = path.join(__dirname, '..');
const PORT = 4055;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(REPO_ROOT, 'data-test-socket-crash');
const DB_PATH = path.join(DATA_DIR, 'sallehly.sqlite');

function uniqueEmail() {
  return `test-socketcrash-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}
function uniquePhone() {
  return `07${Math.floor(10000000 + Math.random() * 89999999)}`;
}

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

function readPendingOtp(email) {
  const db = new Database(DB_PATH, { readonly: false, fileMustExist: true });
  try {
    const row = db.prepare('SELECT otp FROM pending_users WHERE email=? ORDER BY id DESC LIMIT 1').get(email.toLowerCase());
    if (!row) throw new Error('لا يوجد OTP معلَّق لهذا الإيميل بالسيرفر المعزول');
    return row.otp;
  } finally {
    db.close();
  }
}

test.describe.serial('[SEC-FIX-SOCKETCRASH-01] رسالة سوكت مشوَّهة لا تُسقط السيرفر', () => {
  let serverProcess;

  test.beforeAll(async () => {
    if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });
    serverProcess = spawn('node', ['server.js'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(PORT),
        DATA_DIR,
        JWT_SECRET: 'socket_crash_test_secret_isolated_instance_1234567890',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForHttpReady(BASE_URL, 20_000);
  });

  test.afterAll(async () => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGKILL');
    }
    if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  test('emit("join-request", {كائن مشوَّه}) لا يُسقط عملية Node — السيرفر يبقى يرد على طلبات أخرى بعدها', async () => {
    // تسجيل عميل حقيقي والحصول على توكن صالح
    const email = uniqueEmail();
    const phone = uniquePhone();
    const registerRes = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ role: 'customer', email, phone, password: 'TestPass123', name: 'عميل اختبار الانهيار', city: 'عمان' }),
    });
    expect(registerRes.ok).toBeTruthy();
    const otp = readPendingOtp(email);
    const verifyRes = await fetch(`${BASE_URL}/api/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email, otp }),
    });
    expect(verifyRes.ok).toBeTruthy();
    const { token } = await verifyRes.json();
    expect(token).toBeTruthy();

    // اتصال سوكت حقيقي، ثم إرسال حمولة مشوَّهة (كائن بدل رقم/نص) لحدث join-request —
    // هذا بالضبط الشكل الذي كان يُسقط better-sqlite3 بـRangeError غير مُلتقَط،
    // يصل بلا حماية حتى process.on('uncaughtException') فيُنهي العملية بأكملها.
    const socket = ioClient(BASE_URL, { auth: { token }, transports: ['websocket'], reconnection: false });
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
      setTimeout(() => reject(new Error('انتهت مهلة اتصال السوكت')), 8000);
    });

    socket.emit('join-request', { malformed: true, nested: [1, 2, 3] });
    socket.emit('join-request', [1, 2]);

    // مهلة قصيرة تكفي لأي throw غير محمي ليصل process.on('uncaughtException')
    // وينهي العملية فعلياً (لو الثغرة موجودة) قبل أن نتحقق من حالتها.
    await new Promise((r) => setTimeout(r, 1500));

    // التحقق الحاسم: السيرفر لا يزال حياً ويرد على طلب HTTP عادي تماماً —
    // لو انهارت العملية، هذا الطلب سيفشل بـ"connection refused"، لا بخطأ HTTP نظيف.
    const healthRes = await fetch(`${BASE_URL}/api/meta`);
    expect(healthRes.ok).toBeTruthy();

    // والاتصال نفسه لا يزال شغّالاً أيضاً — إجراء طبيعي بعده ينجح كالمعتاد
    socket.emit('join-request', 999999);
    socket.disconnect();
  });
});
