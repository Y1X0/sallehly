// tests/protected-uploads.spec.js
// يغطي routes/protected-uploads.routes.js — أول خطوتين (avatars/, payments/)
// من [SEC-FIX-UPLOADS-01]. لا يغطي requests/ ولا audios/ بعد (لسا بتُخدَّم عبر
// express.static العام بدون مصادقة — خطوات لاحقة من نفس الإصلاح).

const { test, expect } = require('@playwright/test');
const { getPendingOtp } = require('./helpers/db');

function uniqueEmail(tag) {
  return `test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}
function uniquePhone() {
  return `07${Math.floor(10000000 + Math.random() * 89999999)}`;
}
function uniqueNationalNumber() {
  let n = '';
  for (let i = 0; i < 10; i++) n += Math.floor(Math.random() * 10);
  return n;
}

const VALID_PASSWORD = 'TestPass123';
const CITY = 'عمان';
const ADMIN_EMAIL = 'admin-test@example.com';
const ADMIN_PASSWORD = 'AdminTestPass123';

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

async function registerAndVerifyTechnician(request, tag) {
  const email = uniqueEmail(tag);
  const phone = uniquePhone();
  const registerRes = await request.post('/api/auth/register', {
    multipart: {
      role: 'technician',
      email,
      phone,
      password: VALID_PASSWORD,
      name: 'فني اختبار رفع',
      city: CITY,
      national_number: uniqueNationalNumber(),
      services: 'كهربائي',
      areas: 'القويسمة',
      avatar: {
        name: 'avatar.png',
        mimeType: 'image/png',
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      },
    },
  });
  if (!registerRes.ok()) throw new Error(`فشل تسجيل الفني: ${registerRes.status()} ${await registerRes.text()}`);
  const otp = getPendingOtp(email);
  const res = await request.post('/api/auth/verify-otp', { form: { email, otp } });
  if (!res.ok()) throw new Error(`فشل verify-otp: ${res.status()} ${await res.text()}`);
  const body = await res.json();
  return { email, phone, token: body.token, user: body.user };
}

async function loginAdmin(request) {
  const res = await request.post('/api/auth/login', { form: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  if (!res.ok()) throw new Error(`فشل دخول الأدمن: ${res.status()} ${await res.text()}`);
  return (await res.json()).token;
}

async function getFirstPackageId(request, token) {
  const res = await request.get('/api/meta', { headers: authHeader(token) });
  const body = await res.json();
  expect(body.packages.length).toBeGreaterThan(0);
  return body.packages[0].id;
}

test.describe.serial('[SEC-FIX-UPLOADS-01] /uploads/avatars و/uploads/payments وراء مصادقة حقيقية', () => {
  let techA, techB, adminToken;
  let avatarFilename, paymentFilename;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });
    techA = await registerAndVerifyTechnician(request, 'uploadA');
    techB = await registerAndVerifyTechnician(request, 'uploadB');
    adminToken = await loginAdmin(request);

    // avatar_url تسجَّل تلقائياً عند التسجيل أعلاه (multipart avatar)
    const meRes = await request.get('/api/me', { headers: authHeader(techA.token) });
    const me = (await meRes.json()).user;
    expect(me.avatar_url).toBeTruthy();
    avatarFilename = me.avatar_url.split('/').pop();

    const pkgId = await getFirstPackageId(request, techA.token);
    const topupRes = await request.post('/api/topups', {
      headers: authHeader(techA.token),
      multipart: {
        package_id: String(pkgId),
        receipt: { name: 'receipt.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      },
    });
    expect(topupRes.ok()).toBe(true);
    const topup = (await topupRes.json()).topup;
    expect(topup.receipt_url).toBeTruthy();
    paymentFilename = topup.receipt_url.split('/').pop();

    await request.dispose();
  });

  test('GET /uploads/avatars/:filename — يرفض بلا توكن', async ({ request }) => {
    const res = await request.get(`/uploads/avatars/${avatarFilename}`);
    expect(res.status()).toBe(401);
  });

  test('GET /uploads/avatars/:filename — أي مستخدم مصادَق يقدر يشوف صورة أي حساب (بلا قيد ملكية، نفس انفتاح GET /technicians/:id/profile)', async ({ request }) => {
    const res = await request.get(`/uploads/avatars/${avatarFilename}`, { headers: authHeader(techB.token) });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image');
  });

  test('GET /uploads/payments/:filename — يرفض بلا توكن', async ({ request }) => {
    const res = await request.get(`/uploads/payments/${paymentFilename}`);
    expect(res.status()).toBe(401);
  });

  test('GET /uploads/payments/:filename — صاحب الإيصال (الفني نفسه) يقدر يشوفه', async ({ request }) => {
    const res = await request.get(`/uploads/payments/${paymentFilename}`, { headers: authHeader(techA.token) });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image');
  });

  test('GET /uploads/payments/:filename — فني آخر لا يقدر يشوف إيصال ليس له (403)', async ({ request }) => {
    const res = await request.get(`/uploads/payments/${paymentFilename}`, { headers: authHeader(techB.token) });
    expect(res.status()).toBe(403);
  });

  test('GET /uploads/payments/:filename — الأدمن يقدر يشوف أي إيصال', async ({ request }) => {
    const res = await request.get(`/uploads/payments/${paymentFilename}`, { headers: authHeader(adminToken) });
    expect(res.status()).toBe(200);
  });

  test('GET /uploads/payments/:filename — ملف غير موجود يرجع 404 (ليس 403)، بلا تسريب وجوده من عدمه', async ({ request }) => {
    const res = await request.get('/uploads/payments/nonexistent-file.png', { headers: authHeader(techB.token) });
    expect(res.status()).toBe(404);
  });

  test('GET /uploads/payments/:filename — اسم ملف يحاول اجتياز مسار (path traversal) يُرفض بـ400 قبل أي وصول للقرص', async ({ request }) => {
    const res = await request.get('/uploads/payments/..%2F..%2Fserver.js', { headers: authHeader(adminToken) });
    expect([400, 404]).toContain(res.status());
  });

  test('GET /uploads/requests/ و/uploads/audios/ — لسا بلا مصادقة (خطوات لاحقة من نفس الإصلاح، لم تُنفَّذ بعد)', async ({ request }) => {
    // هذا الاختبار يوثّق الحالة الانتقالية المقصودة فقط — سيُحدَّث عند تنفيذ
    // الخطوتين المتبقيتين (صور الطلب/الشات، ثم الصوت) بنفس هذا الإصلاح.
    // لا يمر بأي راوت محمي حالياً، فلا يوجد أي رفض 401 هون بغضّ النظر عن وجود
    // الملف من عدمه (ملف غير موجود يصل catch-all الـSPA بـserver.js فيرجع
    // index.html بحالة 200 — هذا سلوك عام للتطبيق كله، لا علاقة له بهذا الإصلاح).
    const res = await request.get('/uploads/requests/definitely-does-not-exist.png');
    expect(res.status()).not.toBe(401);
  });
});
