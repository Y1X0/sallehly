// tests/complaints-support.spec.js
// يغطي: الشكاوى (اختبار مباشر للإصلاح الحرج الذي كان يسبب 500 دائم)، وتذاكر الدعم الفني
// (إنشاء، منع تذكرة ثانية مفتوحة، الرسائل، الإغلاق، fcm-token).

const { test, expect } = require('@playwright/test');
const { getPendingOtp } = require('./helpers/db');

function uniqueEmail(tag) {
  return `test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}
function uniquePhone() {
  const suffix = Math.floor(10000000 + Math.random() * 89999999);
  return `07${suffix}`;
}

const VALID_PASSWORD = 'TestPass123';
const CITY = 'عمان';
const ADMIN_EMAIL = 'admin-test@example.com';
const ADMIN_PASSWORD = 'AdminTestPass123';

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

async function registerAndVerify(request, role, extra = {}) {
  const email = uniqueEmail(role);
  const phone = uniquePhone();
  const registerRes = role === 'technician'
    ? await request.post('/api/auth/register', {
        multipart: {
          role, email, phone, password: VALID_PASSWORD, ...extra,
          avatar: { name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
        },
      })
    : await request.post('/api/auth/register', {
        form: { role, email, phone, password: VALID_PASSWORD, ...extra },
      });
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

test.describe.serial('الشكاوى', () => {
  let customer;
  let technician;
  let adminToken;
  let requestId;
  let complaintId;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });
    customer = await registerAndVerify(request, 'customer', { name: 'عميل اختبار شكاوى', city: CITY });
    technician = await registerAndVerify(request, 'technician', {
      name: 'فني اختبار شكاوى', city: CITY, national_number: '9988776655', services: 'كهربائي', areas: 'القويسمة',
    });
    adminToken = await loginAdmin(request);

    const reqRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      multipart: { service: 'كهربائي', city: CITY, area: 'القويسمة', description: 'طلب لاختبار تقديم شكوى عليه' },
    });
    requestId = (await reqRes.json()).request.id;
    await request.dispose();
  });

  test('POST /complaints — يرفض بلا نص', async ({ request }) => {
    const res = await request.post('/api/complaints', {
      headers: authHeader(customer.token),
      form: { request_id: String(requestId), body: '' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /complaints — يرفض الفني (العميل فقط يقدّم شكوى)', async ({ request }) => {
    const res = await request.post('/api/complaints', {
      headers: authHeader(technician.token),
      form: { request_id: String(requestId), body: 'شكوى من فني، يجب أن تُرفض' },
    });
    expect(res.status()).toBe(403);
  });

  test('POST /complaints — ينجح فعلياً (هذا كان يفشل 500 قبل الإصلاح)', async ({ request }) => {
    const res = await request.post('/api/complaints', {
      headers: authHeader(customer.token),
      form: { request_id: String(requestId), body: 'الفني تأخر كثيراً عن الموعد المتفق عليه' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.complaint.status).toBe('open');
    expect(body.complaint.subject).toContain('كهربائي');
    complaintId = body.complaint.id;
  });

  test('POST /complaints — يرفض نصاً أطول من 1000 حرف', async ({ request }) => {
    const res = await request.post('/api/complaints', {
      headers: authHeader(customer.token),
      form: { body: 'ش'.repeat(1001) },
    });
    expect(res.status()).toBe(400);
  });

  test('GET /complaints — الأدمن فقط، ويرى اسم العميل والفني', async ({ request }) => {
    const forbidden = await request.get('/api/complaints', { headers: authHeader(customer.token) });
    expect(forbidden.status()).toBe(403);

    const res = await request.get('/api/complaints', { headers: authHeader(adminToken) });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const mine = body.complaints.find((c) => c.id === complaintId);
    expect(mine).toBeTruthy();
    expect(mine.customer_name).toBeTruthy();
  });

  test('POST /complaints/:id/status — الأدمن يحدّث الحالة إلى resolved', async ({ request }) => {
    const res = await request.post(`/api/complaints/${complaintId}/status`, {
      headers: authHeader(adminToken),
      form: { status: 'resolved' },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).complaint.status).toBe('resolved');
  });

  test('POST /complaints/:id/status — يرفض حالة غير معروفة', async ({ request }) => {
    const res = await request.post(`/api/complaints/${complaintId}/status`, {
      headers: authHeader(adminToken),
      form: { status: 'not_a_real_status' },
    });
    expect(res.status()).toBe(400);
  });
});

test.describe.serial('تذاكر الدعم الفني', () => {
  let customer;
  let adminToken;
  let ticketId;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });
    customer = await registerAndVerify(request, 'customer', { name: 'عميل اختبار دعم', city: CITY });
    adminToken = await loginAdmin(request);
    await request.dispose();
  });

  test('POST /support — ينشئ تذكرة دعم صحيحة', async ({ request }) => {
    const res = await request.post('/api/support', {
      headers: authHeader(customer.token),
      form: { type: 'مشكلة حساب', title: 'مشكلة بتسجيل الدخول', body: 'لا أستطيع الدخول لحسابي منذ الصباح' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ticket.status).toBe('open');
    ticketId = body.ticket.id;
  });

  test('POST /support — يرفض تذكرة ثانية مفتوحة لنفس المستخدم', async ({ request }) => {
    const res = await request.post('/api/support', {
      headers: authHeader(customer.token),
      form: { type: 'عام', title: 'مشكلة تانية', body: 'عندي مشكلة تانية بنفس الوقت' },
    });
    expect(res.status()).toBe(409);
  });

  test('GET /support/my — العميل يرى تذكرته', async ({ request }) => {
    const res = await request.get('/api/support/my', { headers: authHeader(customer.token) });
    expect(res.status()).toBe(200);
    expect((await res.json()).tickets.some((t) => t.id === ticketId)).toBe(true);
  });

  test('GET /support — الأدمن فقط يرى كل التذاكر', async ({ request }) => {
    const forbidden = await request.get('/api/support', { headers: authHeader(customer.token) });
    expect(forbidden.status()).toBe(403);

    const res = await request.get('/api/support', { headers: authHeader(adminToken) });
    expect(res.status()).toBe(200);
    expect((await res.json()).tickets.some((t) => t.id === ticketId)).toBe(true);
  });

  test('POST /support/:id/messages — العميل يرسل رسالة إضافية', async ({ request }) => {
    const res = await request.post(`/api/support/${ticketId}/messages`, {
      headers: authHeader(customer.token),
      form: { body: 'هل من تحديث بخصوص مشكلتي؟' },
    });
    expect(res.status()).toBe(200);
  });

  test('GET /support/:id/messages — مستخدم آخر غير صاحب التذكرة يُرفض', async ({ request }) => {
    const otherCustomer = await registerAndVerify(request, 'customer', { name: 'عميل آخر', city: CITY });
    const res = await request.get(`/api/support/${ticketId}/messages`, { headers: authHeader(otherCustomer.token) });
    expect(res.status()).toBe(403);
  });

  test('POST /support/:id/messages — الأدمن يرد على التذكرة', async ({ request }) => {
    const res = await request.post(`/api/support/${ticketId}/messages`, {
      headers: authHeader(adminToken),
      form: { body: 'تم حل المشكلة، حاول تسجيل الدخول من جديد' },
    });
    expect(res.status()).toBe(200);

    const messagesRes = await request.get(`/api/support/${ticketId}/messages`, { headers: authHeader(customer.token) });
    const messages = (await messagesRes.json()).messages;
    expect(messages.length).toBeGreaterThanOrEqual(2);
  });

  test('POST /support/:id/status — الأدمن يغلق التذكرة', async ({ request }) => {
    const res = await request.post(`/api/support/${ticketId}/status`, {
      headers: authHeader(adminToken),
      form: { status: 'closed' },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).ticket.status).toBe('closed');
  });

  test('POST /support/:id/messages — لا يمكن الإرسال بعد إغلاق التذكرة', async ({ request }) => {
    const res = await request.post(`/api/support/${ticketId}/messages`, {
      headers: authHeader(customer.token),
      form: { body: 'رسالة بعد الإغلاق' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /support — يقدر ينشئ تذكرة جديدة بعد إغلاق القديمة', async ({ request }) => {
    const res = await request.post('/api/support', {
      headers: authHeader(customer.token),
      form: { type: 'استفسار', title: 'استفسار جديد', body: 'عندي سؤال جديد الآن بعد إغلاق القديمة' },
    });
    expect(res.status()).toBe(200);
  });
});

test.describe('fcm-token', () => {
  test('POST /fcm-token — يرفض بلا token', async ({ request }) => {
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل fcm', city: CITY });
    const res = await request.post('/api/fcm-token', { headers: authHeader(customer.token), form: {} });
    expect(res.status()).toBe(400);
  });

  test('POST /fcm-token — ينجح بتوكن نصي', async ({ request }) => {
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل fcm 2', city: CITY });
    const res = await request.post('/api/fcm-token', {
      headers: authHeader(customer.token),
      form: { token: 'dummy-fcm-token-for-testing' },
    });
    expect(res.status()).toBe(200);
  });
});
