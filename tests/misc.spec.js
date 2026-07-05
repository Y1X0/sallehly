// tests/misc.spec.js
// يغطي: تدفق نسيان كلمة السر الكامل، منع تعداد المستخدمين، تعديل البروفايل، تغيير كلمة
// السر، وبحث الفنيين + بروفايلهم العام (بما فيها إخفاء رقم الهاتف عن غير الأدمن).

const { test, expect } = require('@playwright/test');
const { getPendingOtp } = require('./helpers/db');

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
const ADMIN_EMAIL = 'admin-test@example.com';
const ADMIN_PASSWORD = 'AdminTestPass123';

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

async function registerAndVerify(request, role, extra = {}, multipart = null) {
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

async function loginAdmin(request) {
  const res = await request.post('/api/auth/login', { form: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  if (!res.ok()) throw new Error(`فشل دخول الأدمن: ${res.status()} ${await res.text()}`);
  return (await res.json()).token;
}

test.describe.serial('نسيان وإعادة تعيين كلمة السر', () => {
  let customer;
  const NEW_PASSWORD = 'NewPass456';

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });
    customer = await registerAndVerify(request, 'customer', { name: 'عميل اختبار كلمة سر', city: CITY });
    await request.dispose();
  });

  test('POST /auth/forgot-password — بريد غير موجود يرجع نفس رسالة النجاح (منع Enumeration)', async ({ request }) => {
    const res = await request.post('/api/auth/forgot-password', { form: { email: uniqueEmail('missing') } });
    expect(res.status()).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  test('POST /auth/forgot-password — بريد موجود يرسل كود ويرجع 200', async ({ request }) => {
    const res = await request.post('/api/auth/forgot-password', { form: { email: customer.email } });
    expect(res.status()).toBe(200);
  });

  test('POST /auth/reset-password — يرفض كود خاطئ', async ({ request }) => {
    const res = await request.post('/api/auth/reset-password', {
      form: { email: customer.email, otp: '000000', new_password: NEW_PASSWORD },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /auth/reset-password — ينجح بالكود الصحيح، وكلمة السر القديمة تتوقف عن العمل', async ({ request }) => {
    const otp = getPendingOtp(customer.email);
    const res = await request.post('/api/auth/reset-password', {
      form: { email: customer.email, otp, new_password: NEW_PASSWORD },
    });
    expect(res.status()).toBe(200);

    const oldLogin = await request.post('/api/auth/login', { form: { email: customer.email, password: VALID_PASSWORD } });
    expect(oldLogin.status()).toBe(401);

    const newLogin = await request.post('/api/auth/login', { form: { email: customer.email, password: NEW_PASSWORD } });
    expect(newLogin.status()).toBe(200);
  });
});

test.describe.serial('تعديل البروفايل وتغيير كلمة السر', () => {
  let customer;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });
    customer = await registerAndVerify(request, 'customer', { name: 'عميل بروفايل', city: CITY });
    await request.dispose();
  });

  test('POST /me/profile — يرفض اسماً قصيراً', async ({ request }) => {
    const res = await request.post('/api/me/profile', {
      headers: authHeader(customer.token),
      multipart: { name: 'ا', phone: customer.phone, city: CITY, areas: 'القويسمة' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /me/profile — يحدّث الاسم والمدينة بنجاح', async ({ request }) => {
    const res = await request.post('/api/me/profile', {
      headers: authHeader(customer.token),
      multipart: { name: 'اسم محدَّث', phone: customer.phone, city: 'إربد', areas: '' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.user.name).toBe('اسم محدَّث');
    expect(body.user.city).toBe('إربد');
  });

  test('POST /me/password — يرفض كلمة سر حالية خاطئة', async ({ request }) => {
    const res = await request.post('/api/me/password', {
      headers: authHeader(customer.token),
      form: { current_password: 'WrongCurrent123', new_password: 'AnotherPass456' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /me/password — ينجح بكلمة السر الحالية الصحيحة', async ({ request }) => {
    const res = await request.post('/api/me/password', {
      headers: authHeader(customer.token),
      form: { current_password: VALID_PASSWORD, new_password: 'AnotherPass456' },
    });
    expect(res.status()).toBe(200);

    const loginRes = await request.post('/api/auth/login', {
      form: { email: customer.email, password: 'AnotherPass456' },
    });
    expect(loginRes.status()).toBe(200);
  });
});

test.describe.serial('بحث الفنيين وبروفايلهم العام', () => {
  let customer;
  let adminToken;
  let technician;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });
    customer = await registerAndVerify(request, 'customer', { name: 'عميل بحث فنيين', city: CITY });
    adminToken = await loginAdmin(request);
    technician = await registerAndVerify(
      request,
      'technician',
      { name: 'فني للبحث عنه', city: CITY, national_number: uniqueNationalNumber(), services: 'سباك', areas: 'خلدا' },
      { avatar: { name: 'a.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) } }
    );
    await request.dispose();
  });

  test('GET /technicians — العميل يرى الفني المطابق للخدمة والمدينة بلا رقم هاتف', async ({ request }) => {
    const res = await request.get('/api/technicians', {
      headers: authHeader(customer.token),
      params: { service: 'سباك', city: CITY },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const found = body.technicians.find((t) => t.id === technician.user.id);
    expect(found).toBeTruthy();
    expect(found.phone).toBeUndefined();
  });

  test('GET /technicians — الأدمن يرى رقم هاتف الفني', async ({ request }) => {
    const res = await request.get('/api/technicians', {
      headers: authHeader(adminToken),
      params: { service: 'سباك', city: CITY },
    });
    const body = await res.json();
    const found = body.technicians.find((t) => t.id === technician.user.id);
    expect(found.phone).toBeTruthy();
  });

  test('GET /technicians/:id/profile — يرجع بروفايل عام صحيح', async ({ request }) => {
    const res = await request.get(`/api/technicians/${technician.user.id}/profile`, {
      headers: authHeader(customer.token),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.tech.id).toBe(technician.user.id);
    expect(Array.isArray(body.reviews)).toBe(true);
  });

  test('GET /technicians/:id/profile — معرّف غير موجود يرجع 404', async ({ request }) => {
    const res = await request.get('/api/technicians/999999/profile', { headers: authHeader(customer.token) });
    expect(res.status()).toBe(404);
  });
});
