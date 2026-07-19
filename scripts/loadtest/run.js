#!/usr/bin/env node
// scripts/loadtest/run.js
// أداة قياس أداء محلية بحتة — لا تلمس الإنتاج أو أي بيئة خارجية إطلاقاً.
// تشغّل نسخة معزولة تماماً من السيرفر (منفذ + مجلد بيانات مخصصان لهذه الأداة
// فقط)، تزرع حسابات اختبار حقيقية عبر واجهات /auth العادية (بلا اختصارات
// تتجاوز منطق التسجيل الفعلي)، ثم تُشغّل autocannon بثلاثة مستويات تزامن
// (100 / 500 / 1000) على مزيج واقعي من السيناريوهات: تسجيل دخول، تصفح فنيين،
// إنشاء طلبات، إرسال رسائل شات — وتقيس req/s، زمن استجابة p50/p95/p99،
// نسبة الأخطاء، واستهلاك الذاكرة (RSS) الفعلي لعملية Node أثناء كل مستوى.
//
// الاستخدام: node scripts/loadtest/run.js
// المخرجات: تقرير Markdown في scripts/loadtest/report.md + JSON خام بجانبه.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const autocannon = require('autocannon');

const PORT = 4055;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(__dirname, '..', '..', 'data-loadtest');
const NUM_CUSTOMERS = 80;
const CONCURRENCY_LEVELS = process.env.LOADTEST_LEVELS
  ? process.env.LOADTEST_LEVELS.split(',').map(Number)
  : [100, 500, 1000];
const DURATION_SECONDS = process.env.LOADTEST_DURATION ? Number(process.env.LOADTEST_DURATION) : 15; // لكل مستوى تزامن

function log(...args) { console.log('[loadtest]', ...args); }

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

async function waitForServer(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url + '/health');
      if (res.ok) return true;
    } catch (e) { /* لسا ما طلع */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`السيرفر لم يستجب خلال ${timeoutMs}ms على ${url}/health`);
}

function startServer() {
  rmrf(DATA_DIR);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const child = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test', // نفس بيئة الاختبارات الآلية: حدود Rate Limit سخية (1000) كي يقيس الاختبار سعة الخادم الحقيقية لا سياسة الحماية من إساءة الاستخدام (تلك مختبرة بشكل منفصل بـ tests/security-hardening.spec.js)
      PORT: String(PORT),
      DATA_DIR,
      JWT_SECRET: 'loadtest_only_secret_not_for_real_use_1234567890',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => { if (String(d).includes('Error')) console.error('[server]', String(d)); });
  return child;
}

function readVmRssKb(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
    return m ? Number(m[1]) : null;
  } catch (e) {
    return null; // العملية انتهت أو النظام لا يدعم /proc (غير لينكس)
  }
}

function openLoadTestDb() {
  const Database = require('better-sqlite3');
  return new Database(path.join(DATA_DIR, 'sallehly.sqlite'), { readonly: false, fileMustExist: true });
}

function uniquePhone(i) { return `07${String(70000000 + i).padStart(8, '0')}`; }

async function registerAndVerify(role, i, extra = {}) {
  const email = `loadtest-${role}-${i}-${Date.now()}@example.com`;
  const phone = uniquePhone(i);
  const form = new URLSearchParams({ role, email, phone, password: 'LoadTest123', ...extra });
  const registerRes = await fetch(`${BASE_URL}/api/auth/register`, { method: 'POST', body: form });
  if (!registerRes.ok) throw new Error(`فشل تسجيل ${role} #${i}: ${registerRes.status} ${await registerRes.text()}`);

  const db = openLoadTestDb();
  let otp;
  try {
    const row = db.prepare('SELECT otp FROM pending_users WHERE email=? ORDER BY id DESC LIMIT 1').get(email.toLowerCase());
    if (!row) throw new Error(`لا يوجد OTP معلّق لـ ${email}`);
    otp = row.otp;
  } finally { db.close(); }

  const verifyRes = await fetch(`${BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    body: new URLSearchParams({ email, otp }),
  });
  if (!verifyRes.ok) throw new Error(`فشل verify-otp ${role} #${i}: ${verifyRes.status} ${await verifyRes.text()}`);
  const body = await verifyRes.json();
  return { email, token: body.token, user: body.user };
}

const NUM_TECHNICIANS = 15;

async function registerTechnician(i) {
  const email = `loadtest-technician-${i}-${Date.now()}@example.com`;
  const phone = `07${String(80000000 + i).padStart(8, '0')}`;
  const fd = new FormData();
  fd.append('role', 'technician');
  fd.append('email', email);
  fd.append('phone', phone);
  fd.append('password', 'LoadTest123');
  fd.append('name', `فني تحميل ${i}`);
  fd.append('city', 'عمان');
  fd.append('national_number', String(2000000000 + i));
  fd.append('services', 'كهربائي');
  fd.append('areas', 'القويسمة');
  fd.append('avatar', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'avatar.png');
  const registerRes = await fetch(`${BASE_URL}/api/auth/register`, { method: 'POST', body: fd });
  if (!registerRes.ok) throw new Error(`فشل تسجيل فني #${i}: ${registerRes.status} ${await registerRes.text()}`);
  const db = openLoadTestDb();
  let otp;
  try { otp = db.prepare('SELECT otp FROM pending_users WHERE email=? ORDER BY id DESC LIMIT 1').get(email.toLowerCase()).otp; } finally { db.close(); }
  const verifyRes = await fetch(`${BASE_URL}/api/auth/verify-otp`, { method: 'POST', body: new URLSearchParams({ email, otp }) });
  if (!verifyRes.ok) throw new Error(`فشل verify-otp فني #${i}: ${verifyRes.status} ${await verifyRes.text()}`);
  const body = await verifyRes.json();
  return { email, token: body.token };
}

async function seed() {
  log(`زرع ${NUM_CUSTOMERS} عميلاً عبر /auth الحقيقية...`);
  const customers = [];
  for (let i = 0; i < NUM_CUSTOMERS; i++) {
    customers.push(await registerAndVerify('customer', i, { name: `عميل تحميل ${i}`, city: 'عمان' }));
  }

  log('إنشاء طلب واحد لكل عميل (لاستخدامه لاحقاً بسيناريو إرسال الرسائل)...');
  const customerPool = [];
  for (const c of customers) {
    const res = await fetch(`${BASE_URL}/api/requests`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.token}` },
      body: new URLSearchParams({ service: 'كهربائي', description: 'طلب أداة قياس الأداء المحلية — بيانات اختبار فقط', city: 'عمان', area: 'القويسمة' }),
    });
    if (!res.ok) throw new Error(`فشل إنشاء طلب للعميل ${c.email}: ${res.status} ${await res.text()}`);
    const body = await res.json();
    customerPool.push({ token: c.token, requestId: body.request.id, email: c.email, password: 'LoadTest123' });
  }
  log(`تم الزرع: ${customerPool.length} عميلاً بحساب+طلب جاهزَين.`);

  log(`زرع ${NUM_TECHNICIANS} فنياً (لسيناريو عمليات المحفظة — طلبات شحن رصيد)...`);
  const technicianPool = [];
  for (let i = 0; i < NUM_TECHNICIANS; i++) {
    const t = await registerTechnician(i);
    technicianPool.push({ token: t.token, email: t.email });
  }
  log(`تم الزرع: ${technicianPool.length} فنياً.`);

  return { customerPool, technicianPool };
}

// جسم multipart/form-data ثابت (نفس المحتوى لكل طلب — فقط Authorization
// يتغيّر لكل نداء عبر pick()) لسيناريو "إنشاء طلب شحن رصيد" — لا حاجة لإعادة
// بنائه بكل مرة، فقط الفني المُرسِل يتغيّر.
function buildTopupMultipartBody() {
  const boundary = '----loadtestboundary1234567890';
  const receiptBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header بسيط كافٍ لفحوصات النوع
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="package_id"\r\n\r\n1\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="receipt"; filename="receipt.png"\r\nContent-Type: image/png\r\n\r\n`,
  ];
  const tail = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(parts[0] + parts[1]), receiptBytes, Buffer.from(tail)]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function buildRequests(customerPool, technicianPool) {
  const pickCustomer = () => customerPool[Math.floor(Math.random() * customerPool.length)];
  const pickTechnician = () => technicianPool[Math.floor(Math.random() * technicianPool.length)];
  const topup = buildTopupMultipartBody();
  // مزيج وزنه يقارب: 30% تصفح، 15% دخول، 15% إنشاء طلب، 25% رسائل شات، 15% عمليات محفظة (شحن رصيد)
  return [
    { method: 'GET', path: '/api/technicians', setupRequest: (req) => { req.headers = { Authorization: `Bearer ${pickCustomer().token}` }; return req; } },
    { method: 'GET', path: '/api/technicians', setupRequest: (req) => { req.headers = { Authorization: `Bearer ${pickCustomer().token}` }; return req; } },
    { method: 'GET', path: '/api/technicians', setupRequest: (req) => { req.headers = { Authorization: `Bearer ${pickCustomer().token}` }; return req; } },
    { method: 'POST', path: '/api/auth/login', setupRequest: (req) => { const u = pickCustomer(); req.body = `email=${encodeURIComponent(u.email)}&password=${u.password}`; req.headers = { 'content-type': 'application/x-www-form-urlencoded' }; return req; } },
    { method: 'POST', path: '/api/requests', setupRequest: (req) => { const u = pickCustomer(); req.headers = { Authorization: `Bearer ${u.token}`, 'content-type': 'application/x-www-form-urlencoded' }; req.body = 'service=كهربائي&description=طلب+حمل+أداء+متكرر+أثناء+القياس&city=عمان&area=القويسمة'; return req; } },
    { method: 'GET', path: '/api/requests', setupRequest: (req) => { req.headers = { Authorization: `Bearer ${pickCustomer().token}` }; return req; } },
    { method: 'POST', path: '/api/requests/0/messages', setupRequest: (req) => { const u = pickCustomer(); req.path = `/api/requests/${u.requestId}/messages`; req.headers = { Authorization: `Bearer ${u.token}`, 'content-type': 'application/x-www-form-urlencoded' }; req.body = 'body=رسالة+اختبار+حمل+آلية'; return req; } },
    { method: 'POST', path: '/api/requests/0/messages', setupRequest: (req) => { const u = pickCustomer(); req.path = `/api/requests/${u.requestId}/messages`; req.headers = { Authorization: `Bearer ${u.token}`, 'content-type': 'application/x-www-form-urlencoded' }; req.body = 'body=رسالة+اختبار+حمل+آلية'; return req; } },
    { method: 'POST', path: '/api/topups', setupRequest: (req) => { req.headers = { Authorization: `Bearer ${pickTechnician().token}`, 'content-type': topup.contentType }; req.body = topup.body; return req; } },
  ];
}

async function runLevel(connections, customerPool, technicianPool, serverPid) {
  log(`\n=== تشغيل بمستوى ${connections} اتصال متزامن لمدة ${DURATION_SECONDS}ث ===`);
  const memSamples = [];
  const memInterval = setInterval(() => {
    const kb = readVmRssKb(serverPid);
    if (kb) memSamples.push(kb);
  }, 1000);

  const result = await autocannon({
    url: BASE_URL,
    connections,
    duration: DURATION_SECONDS,
    pipelining: 1,
    requests: buildRequests(customerPool, technicianPool),
  });

  clearInterval(memInterval);
  const memMB = memSamples.map((kb) => kb / 1024);
  return {
    connections,
    requestsPerSec: result.requests.average,
    latencyMs: { p50: result.latency.p50, p95: result.latency.p97_5 ?? result.latency.p95, p99: result.latency.p99, max: result.latency.max },
    errors: result.errors,
    timeouts: result.timeouts,
    non2xx: (result.non2xx || 0),
    totalRequests: result.requests.total,
    memoryMB: memMB.length ? { min: Math.min(...memMB).toFixed(1), max: Math.max(...memMB).toFixed(1), avg: (memMB.reduce((a, b) => a + b, 0) / memMB.length).toFixed(1) } : null,
  };
}

function writeReport(results) {
  const lines = [];
  lines.push('# تقرير اختبار الحمل المحلي (Local Load Test Report)');
  lines.push('');
  lines.push(`تاريخ التشغيل: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('**بيئة القياس**: نسخة سيرفر معزولة تماماً محلياً (منفذ 4055، قاعدة بيانات مخصصة `data-loadtest/`)، ');
  lines.push('**وليس** الإنتاج ولا أي بيئة خارجية. حدود Rate Limit بوضع `NODE_ENV=test` (سخية) لقياس السعة الحقيقية للخادم لا سياسة الحماية من إساءة الاستخدام — تلك مختبرة بشكل منفصل ومباشر بـ `tests/security-hardening.spec.js`.');
  lines.push('');
  lines.push('| الاتصالات المتزامنة | req/s | p50 (ms) | p95 (ms) | p99 (ms) | أقصى زمن (ms) | أخطاء اتصال | ردود غير 2xx | ذاكرة السيرفر MB (أدنى/أعلى/متوسط) |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const mem = r.memoryMB ? `${r.memoryMB.min} / ${r.memoryMB.max} / ${r.memoryMB.avg}` : 'غير متاح';
    lines.push(`| ${r.connections} | ${r.requestsPerSec.toFixed(1)} | ${r.latencyMs.p50} | ${r.latencyMs.p95} | ${r.latencyMs.p99} | ${r.latencyMs.max} | ${r.errors} | ${r.non2xx} | ${mem} |`);
  }
  lines.push('');
  lines.push('## السيناريو المُقاس بكل طلب (مزيج ثابت يتكرر لكل اتصال)');
  lines.push('- 30% تصفح الفنيين (`GET /api/technicians`)');
  lines.push('- 15% تسجيل دخول (`POST /api/auth/login`)');
  lines.push('- 15% إنشاء طلب خدمة جديد (`POST /api/requests`)');
  lines.push('- 25% رسائل شات (`GET`+`POST /api/requests/:id/messages`)');
  lines.push('- 15% عمليات محفظة — إنشاء طلب شحن رصيد (`POST /api/topups`, multipart)');
  lines.push('');
  fs.writeFileSync(path.join(__dirname, 'report.md'), lines.join('\n'));
  fs.writeFileSync(path.join(__dirname, 'report.json'), JSON.stringify(results, null, 2));
  log('كُتب التقرير: scripts/loadtest/report.md و report.json');
}

async function main() {
  const child = startServer();
  try {
    await waitForServer(BASE_URL);
    log('السيرفر جاهز. جاري الزرع...');
    const { customerPool, technicianPool } = await seed();

    const results = [];
    for (const connections of CONCURRENCY_LEVELS) {
      const r = await runLevel(connections, customerPool, technicianPool, child.pid);
      results.push(r);
      log(`النتيجة: ${r.requestsPerSec.toFixed(1)} req/s، p95=${r.latencyMs.p95}ms، أخطاء=${r.errors}، غير-2xx=${r.non2xx}`);
    }

    writeReport(results);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    rmrf(DATA_DIR);
  }
}

main().catch((e) => { console.error('[loadtest] فشل:', e); process.exit(1); });
