// tests/topups.spec.js
// يغطي: طلب شحن رصيد من فني، حد الطلبات المعلّقة (2 كحد أقصى)، مراجعة الأدمن
// (موافقة تزيد الرصيد فعلياً + رفض لا يزيده)، ومنع مراجعة نفس الطلب مرتين.

const { test, expect } = require('@playwright/test');
const { getPendingOtp, getAdminDebugInfo } = require('./helpers/db');

function uniqueEmail(tag) {
  return `test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}

function uniquePhone() {
  const suffix = Math.floor(10000000 + Math.random() * 89999999);
  return `07${suffix}`;
}

function uniqueNationalNumber() {
  let n = '';
  for (let i = 0; i < 10; i++) n += Math.floor(Math.random() * 10);
  return n;
}

const VALID_PASSWORD = 'TestPass123';
const CITY = 'عمان';
// نفس بيانات الأدمن المضبوطة بـ playwright.config.js (بيئة اختبار فقط)
const ADMIN_EMAIL = 'admin-test@example.com';
const ADMIN_PASSWORD = 'AdminTestPass123';

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

async function registerAndVerifyTechnician(request) {
  const email = uniqueEmail('technician');
  const phone = uniquePhone();

  const registerRes = await request.post('/api/auth/register', {
    multipart: {
      role: 'technician',
      email,
      phone,
      password: VALID_PASSWORD,
      name: 'فني اختبار شحن',
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
  if (!registerRes.ok()) {
    throw new Error(`فشل تسجيل الفني — الحالة: ${registerRes.status()}, الرد: ${await registerRes.text()}`);
  }

  const otp = getPendingOtp(email);
  const verifyRes = await request.post('/api/auth/verify-otp', { form: { email, otp } });
  if (!verifyRes.ok()) {
    throw new Error(`فشل التحقق من الفني — الحالة: ${verifyRes.status()}, الرد: ${await verifyRes.text()}`);
  }
  const body = await verifyRes.json();
  if (!body.token) throw new Error(`لا يوجد توكن بعد التحقق: ${JSON.stringify(body)}`);
  return { email, phone, token: body.token, user: body.user };
}

async function loginAdmin(request) {
  const res = await request.post('/api/auth/login', {
    form: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (!res.ok()) {
    const actualAdmins = getAdminDebugInfo();
    throw new Error(
      `فشل تسجيل دخول الأدمن — الحالة: ${res.status()}, الرد: ${await res.text()}\n` +
        `حساب(ات) الأدمن الفعلية بقاعدة بيانات الاختبار الآن: ${JSON.stringify(actualAdmins)}\n` +
        `متوقَّع: email="${ADMIN_EMAIL}"`
    );
  }
  const body = await res.json();
  if (!body.token) throw new Error(`دخول الأدمن نجح لكن بلا توكن: ${JSON.stringify(body)}`);
  return { token: body.token, user: body.user };
}

async function getFirstPackageId(request, token) {
  const res = await request.get('/api/meta', { headers: authHeader(token) });
  const body = await res.json();
  expect(body.packages.length).toBeGreaterThan(0);
  return body.packages[0];
}

test.describe.serial('طلبات شحن الرصيد ومراجعة الأدمن', () => {
  let technician;
  let admin;
  let pkg;
  let firstTopupId;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });
    technician = await registerAndVerifyTechnician(request);
    admin = await loginAdmin(request);
    pkg = await getFirstPackageId(request, technician.token);
    await request.dispose();
  });

  test('POST /api/topups — يرفض بلا توكن', async ({ request }) => {
    const res = await request.post('/api/topups', {
      multipart: { package_id: String(pkg.id) },
    });
    expect(res.status()).toBe(401);
  });

  test('POST /api/topups — يرفض بلا إثبات دفع (receipt)', async ({ request }) => {
    const res = await request.post('/api/topups', {
      headers: authHeader(technician.token),
      multipart: { package_id: String(pkg.id) },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/topups — ينشئ طلب شحن صحيحاً بحالة pending', async ({ request }) => {
    const res = await request.post('/api/topups', {
      headers: authHeader(technician.token),
      multipart: {
        package_id: String(pkg.id),
        receipt: {
          name: 'receipt.png',
          mimeType: 'image/png',
          buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        },
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.topup.status).toBe('pending');
    expect(body.topup.package_id).toBe(pkg.id);
    firstTopupId = body.topup.id;
  });

  test('GET /api/topups — الفني يرى طلبه الخاص فقط', async ({ request }) => {
    const res = await request.get('/api/topups', { headers: authHeader(technician.token) });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.topups.some((t) => t.id === firstTopupId)).toBe(true);
  });

  test('حد الطلبات المعلّقة: طلب ثانٍ يُقبل، وطلب ثالث يُرفض بـ429', async ({ request }) => {
    const second = await request.post('/api/topups', {
      headers: authHeader(technician.token),
      multipart: {
        package_id: String(pkg.id),
        receipt: { name: 'r2.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      },
    });
    expect(second.status()).toBe(200);

    const third = await request.post('/api/topups', {
      headers: authHeader(technician.token),
      multipart: {
        package_id: String(pkg.id),
        receipt: { name: 'r3.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      },
    });
    expect(third.status()).toBe(429);
  });

  test('GET /api/topups — الأدمن يرى كل الطلبات مع اسم الفني', async ({ request }) => {
    const res = await request.get('/api/topups', { headers: authHeader(admin.token) });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const mine = body.topups.find((t) => t.id === firstTopupId);
    expect(mine).toBeTruthy();
    expect(mine.technician_name).toBeTruthy();
  });

  test('POST /admin/topups/:id/review — الموافقة تزيد رصيد الفني فعلياً بقيمة الباقة + البونص', async ({ request }) => {
    const beforeRes = await request.get('/api/me', { headers: authHeader(technician.token) });
    const before = (await beforeRes.json()).user;
    expect(before.balance).toBe(0);

    const res = await request.post(`/api/admin/topups/${firstTopupId}/review`, {
      headers: authHeader(admin.token),
      form: { status: 'approved' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.topup.status).toBe('approved');

    const afterRes = await request.get('/api/me', { headers: authHeader(technician.token) });
    const after = (await afterRes.json()).user;
    expect(after.balance).toBe(pkg.amount + (pkg.bonus || 0));
  });

  test('POST /admin/topups/:id/review — مراجعة نفس الطلب مرة ثانية تُرفض (لم يعد pending)', async ({ request }) => {
    const res = await request.post(`/api/admin/topups/${firstTopupId}/review`, {
      headers: authHeader(admin.token),
      form: { status: 'approved' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /admin/topups/:id/review — الرفض لا يغيّر رصيد الفني', async ({ request }) => {
    const listRes = await request.get('/api/topups', { headers: authHeader(technician.token) });
    const pendingTopup = (await listRes.json()).topups.find((t) => t.status === 'pending');
    expect(pendingTopup).toBeTruthy();

    const beforeRes = await request.get('/api/me', { headers: authHeader(technician.token) });
    const balanceBefore = (await beforeRes.json()).user.balance;

    const res = await request.post(`/api/admin/topups/${pendingTopup.id}/review`, {
      headers: authHeader(admin.token),
      form: { status: 'rejected', admin_note: 'إيصال غير واضح' },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).topup.status).toBe('rejected');

    const afterRes = await request.get('/api/me', { headers: authHeader(technician.token) });
    expect((await afterRes.json()).user.balance).toBe(balanceBefore);
  });

  test('GET /api/ledger — يعكس عملية الشحن المعتمدة فقط', async ({ request }) => {
    const res = await request.get('/api/ledger', { headers: authHeader(technician.token) });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ledger.some((l) => l.type === 'شحن رصيد')).toBe(true);
  });

  test('POST /api/topups — endpoint مقصور على الفنيين فقط (عميل يُرفض بـ403)', async ({ request }) => {
    const customer = await (async () => {
      const email = uniqueEmail('customer');
      const phone = uniquePhone();
      await request.post('/api/auth/register', {
        form: { role: 'customer', email, phone, password: VALID_PASSWORD, name: 'عميل اختبار شحن', city: CITY },
      });
      const otp = getPendingOtp(email);
      const res = await request.post('/api/auth/verify-otp', { form: { email, otp } });
      return (await res.json()).token;
    })();

    const res = await request.post('/api/topups', {
      headers: authHeader(customer),
      multipart: {
        package_id: String(pkg.id),
        receipt: { name: 'r.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      },
    });
    expect(res.status()).toBe(403);
  });
});
