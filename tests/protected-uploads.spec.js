// tests/protected-uploads.spec.js
// يغطي routes/protected-uploads.routes.js — أول ثلاث خطوات (avatars/,
// payments/, وصور الشات ضمن requests/) من [SEC-FIX-UPLOADS-01].
// problem_image_url (بنفس مجلد requests/) وaudios/ لسا غير مُغطَّاين — قاعدة
// صلاحية problem_image_url مختلفة عن صور الشات (راجع DECISIONS.md)، وaudios/
// خطوة منفصلة تحتاج تحقيقاً فنياً أولاً.

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

  test('GET /uploads/audios/ — لسا بلا مصادقة (خطوة متبقية من نفس الإصلاح، تحتاج تحقيقاً فنياً أولاً)', async ({ request }) => {
    // لا يمر بأي راوت محمي حالياً، فلا يوجد أي رفض 401 هون بغضّ النظر عن وجود
    // الملف من عدمه (ملف غير موجود يصل catch-all الـSPA بـserver.js فيرجع
    // index.html بحالة 200 — هذا سلوك عام للتطبيق كله، لا علاقة له بهذا الإصلاح).
    const res = await request.get('/uploads/audios/definitely-does-not-exist.wav');
    expect(res.status()).not.toBe(401);
  });
});

test.describe.serial('[SEC-FIX-UPLOADS-01] /uploads/requests — صور الشات وراء مصادقة، problem_image_url لسا لأ', () => {
  let customer, technicianA, technicianB, adminToken;
  let acceptedRequest, chatImageUrl, problemImageUrl;

  async function registerAndVerify(request, { role, extra = {}, multipart = null }) {
    const email = uniqueEmail(role);
    const phone = uniquePhone();
    const registerRes = multipart
      ? await request.post('/api/auth/register', { multipart: { role, email, phone, password: VALID_PASSWORD, ...extra, ...multipart } })
      : await request.post('/api/auth/register', { form: { role, email, phone, password: VALID_PASSWORD, ...extra } });
    if (!registerRes.ok()) throw new Error(`فشل تسجيل (${role}): ${registerRes.status()} ${await registerRes.text()}`);
    const otp = getPendingOtp(email);
    const res = await request.post('/api/auth/verify-otp', { form: { email, otp } });
    if (!res.ok()) throw new Error(`فشل verify-otp (${role}): ${res.status()} ${await res.text()}`);
    const body = await res.json();
    return { email, phone, token: body.token, user: body.user };
  }

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });

    customer = await registerAndVerify(request, { role: 'customer', extra: { name: 'عميل اختبار رفع', city: CITY } });
    technicianA = await registerAndVerifyTechnician(request, 'reqA');
    technicianB = await registerAndVerifyTechnician(request, 'reqB');
    adminToken = await loginAdmin(request);

    // طلب فيه صورة مشكلة (problem_image_url) — قاعدة صلاحيته لسا لأ مُطبَّقة
    // بهذه الخطوة (راجع DECISIONS.md)، فيجب أن يبقى بلا حاجة لمصادقة الآن.
    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      multipart: {
        service: 'كهربائي', city: CITY, area: 'القويسمة',
        description: 'وصف تجريبي كافٍ للطول لاختبار رفع الملفات المحمية',
        problem_image: { name: 'problem.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      },
    });
    acceptedRequest = (await createRes.json()).request;
    expect(acceptedRequest.problem_image_url).toBeTruthy();
    problemImageUrl = acceptedRequest.problem_image_url;

    // تأكيد الفني A كطرف رسمي بالمحادثة (نفس نمط tests/chat.spec.js)
    await request.post(`/api/requests/${acceptedRequest.id}/offer`, {
      headers: authHeader(technicianA.token),
      form: { offer_price: '10', duration: 'خلال ساعة' },
    });
    const offersRes = await request.get(`/api/requests/${acceptedRequest.id}/offers`, { headers: authHeader(customer.token) });
    const offerId = (await offersRes.json()).offers[0].id;
    await request.post(`/api/offers/${offerId}/decision`, { headers: authHeader(customer.token), form: { decision: 'accepted' } });

    const imageRes = await request.post(`/api/requests/${acceptedRequest.id}/images`, {
      headers: authHeader(customer.token),
      multipart: { image: { name: 'chat.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) } },
    });
    const messages = (await imageRes.json()).messages;
    const imageMessage = messages.find((m) => m.body.startsWith('[image]'));
    chatImageUrl = imageMessage.body.replace('[image]', '');

    await request.dispose();
  });

  test('صورة شات — يرفض بلا توكن', async ({ request }) => {
    const res = await request.get(chatImageUrl);
    expect(res.status()).toBe(401);
  });

  test('صورة شات — العميل صاحب الطلب يقدر يشوفها', async ({ request }) => {
    const res = await request.get(chatImageUrl, { headers: authHeader(customer.token) });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image');
  });

  test('صورة شات — الفني المؤكَّد بالطلب يقدر يشوفها', async ({ request }) => {
    const res = await request.get(chatImageUrl, { headers: authHeader(technicianA.token) });
    expect(res.status()).toBe(200);
  });

  test('صورة شات — فني آخر لا علاقة له بالطلب يُمنع (403)', async ({ request }) => {
    const res = await request.get(chatImageUrl, { headers: authHeader(technicianB.token) });
    expect(res.status()).toBe(403);
  });

  test('صورة شات — الأدمن يقدر يشوف أي صورة شات', async ({ request }) => {
    const res = await request.get(chatImageUrl, { headers: authHeader(adminToken) });
    expect(res.status()).toBe(200);
  });

  test('problem_image_url (صورة المشكلة، نفس مجلد requests/) — لسا بلا مصادقة (خطوة متبقية من نفس الإصلاح)', async ({ request }) => {
    // نفس المجلد فعلياً (requests/) لكن ليس صورة شات — يجب أن يستمر بالعمل
    // بلا أي توكن بالضبط كما كان قبل هذه الخطوة، حتى تُحسَم قاعدة صلاحيته
    // بخطوة لاحقة منفصلة (راجع DECISIONS.md).
    const res = await request.get(problemImageUrl);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image');
  });
});
