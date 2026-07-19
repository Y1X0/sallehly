// أداة تشخيصية مؤقتة لمقارنة "قبل/بعد" ترحيل bcryptjs -> bcrypt (native) —
// تعزل 3 مسارات فقط بطلب المستخدم: /health، تسجيل الدخول، ومسار مصادَق عليه
// (GET /api/technicians). سيرفر جديد نظيف، حساب واحد فقط، 300 اتصال متزامن.
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const autocannon = require('autocannon');

const PORT = 4059;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(__dirname, '..', '..', 'data-loadtest-bcrypt-after');
const DURATION = Number(process.env.LOADTEST_DURATION || 20);
const CONNECTIONS = Number(process.env.LOADTEST_CONNECTIONS || 300);

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

async function waitForServer(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const res = await fetch(url + '/health'); if (res.ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('timeout waiting for server');
}

function startServer() {
  rmrf(DATA_DIR);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATA_DIR, JWT_SECRET: 'bcrypt_after_secret_1234567890123456789012345' },
    stdio: 'ignore',
  });
}

async function registerAndVerify() {
  const email = `bcrypt-after-${Date.now()}@example.com`;
  const phone = `07${Math.floor(10000000 + Math.random() * 89999999)}`;
  const regRes = await fetch(`${BASE_URL}/api/auth/register`, { method: 'POST', body: new URLSearchParams({ role: 'customer', email, phone, password: 'LoadTest123', name: 'عميل قياس بعدي', city: 'عمان' }) });
  if (!regRes.ok) throw new Error(`register failed: ${regRes.status} ${await regRes.text()}`);
  const Database = require('better-sqlite3');
  const db = new Database(path.join(DATA_DIR, 'sallehly.sqlite'));
  const otp = db.prepare('SELECT otp FROM pending_users WHERE email=? ORDER BY id DESC LIMIT 1').get(email.toLowerCase()).otp;
  db.close();
  const verifyRes = await fetch(`${BASE_URL}/api/auth/verify-otp`, { method: 'POST', body: new URLSearchParams({ email, otp }) });
  const body = await verifyRes.json();
  return { email, token: body.token };
}

async function run(name, opts) {
  console.log(`\n=== ${name} — ${CONNECTIONS} اتصال متزامن / ${DURATION}ث ===`);
  const r = await autocannon({ url: BASE_URL, connections: CONNECTIONS, duration: DURATION, ...opts });
  console.log(`req/s=${r.requests.average.toFixed(1)}  p50=${r.latency.p50}ms  p95=${r.latency.p97_5 ?? r.latency.p95}ms  p99=${r.latency.p99}ms  max=${r.latency.max}ms  errors=${r.errors}  timeouts=${r.timeouts}  total=${r.requests.total}  non2xx=${r.non2xx || 0}`);
  return r;
}

async function main() {
  const child = startServer();
  try {
    await waitForServer(BASE_URL);
    const { email, token } = await registerAndVerify();
    console.log('seeded 1 account:', email);

    await run('[1] GET /health', { requests: [{ method: 'GET', path: '/health' }] });
    await run('[2] GET /api/technicians (مسار مصادَق عليه)', { requests: [{ method: 'GET', path: '/api/technicians', setupRequest: (req) => { req.headers = { Authorization: `Bearer ${token}` }; return req; } }] });
    await run('[3] POST /api/auth/login (bcrypt native)', { requests: [{ method: 'POST', path: '/api/auth/login', setupRequest: (req) => { req.headers = { 'content-type': 'application/x-www-form-urlencoded' }; req.body = `email=${encodeURIComponent(email)}&password=LoadTest123`; return req; } }] });
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    rmrf(DATA_DIR);
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
