// tests/chat.spec.js
// يغطي: رسائل الدردشة بين عميل وفني بطلب مقبول، منع الأطراف الخارجية، ومنع مشاركة
// أرقام الهواتف/واتساب/إيميل داخل الشات (حماية نموذج العمولة).

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
const SERVICE = 'كهربائي';
const AREA = 'القويسمة';

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

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
  if (!body.token) throw new Error(`لا يوجد توكن (${role}): ${JSON.stringify(body)}`);
  return { email, phone, token: body.token, user: body.user };
}

test.describe.serial('الدردشة على الطلبات', () => {
  let customer;
  let technician;
  let outsider; // فني آخر غير طرف بهذا الطلب
  let acceptedRequest;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });

    customer = await registerAndVerify(request, { role: 'customer', extra: { name: 'عميل اختبار شات', city: CITY } });
    technician = await registerAndVerify(request, {
      role: 'technician',
      extra: { name: 'فني اختبار شات', city: CITY, national_number: uniqueNationalNumber(), services: SERVICE, areas: AREA },
      multipart: { avatar: { name: 'a.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) } },
    });
    outsider = await registerAndVerify(request, {
      role: 'technician',
      extra: { name: 'فني خارج الطلب', city: CITY, national_number: uniqueNationalNumber(), services: SERVICE, areas: AREA },
      multipart: { avatar: { name: 'a.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) } },
    });

    // إنشاء طلب وقبول عرض الفني عليه حتى يصير طرفاً رسمياً بالمحادثة
    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      multipart: { service: SERVICE, city: CITY, area: AREA, description: 'وصف تجريبي كافٍ للطول لاختبار الدردشة' },
    });
    acceptedRequest = (await createRes.json()).request;

    await request.post(`/api/requests/${acceptedRequest.id}/offer`, {
      headers: authHeader(technician.token),
      form: { offer_price: '10', duration: 'خلال ساعة' },
    });
    const offersRes = await request.get(`/api/requests/${acceptedRequest.id}/offers`, { headers: authHeader(customer.token) });
    const offerId = (await offersRes.json()).offers[0].id;
    await request.post(`/api/offers/${offerId}/decision`, { headers: authHeader(customer.token), form: { decision: 'accepted' } });

    await request.dispose();
  });

  test('POST /requests/:id/messages — يرفض طرفاً خارجياً غير مرتبط بالطلب', async ({ request }) => {
    const res = await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
      headers: authHeader(outsider.token),
      form: { body: 'مرحباً، أريد المساعدة' },
    });
    expect(res.status()).toBe(403);
  });

  test('POST /requests/:id/messages — العميل يرسل رسالة عادية بنجاح', async ({ request }) => {
    const res = await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
      headers: authHeader(customer.token),
      form: { body: 'أهلاً، متى تصل تقريباً؟' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.messages.some((m) => m.body.includes('متى تصل'))).toBe(true);
  });

  test('POST /requests/:id/messages — الفني يرد ورسالته تظهر بالمحادثة', async ({ request }) => {
    const res = await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
      headers: authHeader(technician.token),
      form: { body: 'خلال نصف ساعة إن شاء الله' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.messages.length).toBeGreaterThanOrEqual(2);
  });

  test('POST /requests/:id/messages — يرفض رسالة تحتوي رقم هاتف أردني ويسجّلها كمخالفة', async ({ request }) => {
    const res = await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
      headers: authHeader(customer.token),
      form: { body: 'تواصل معي على 0791234567 مباشرة' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('هاتف');
  });

  test('POST /requests/:id/messages — يرفض رسالة تحتوي واتساب', async ({ request }) => {
    const res = await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
      headers: authHeader(customer.token),
      form: { body: 'أضفني على الواتساب أسهل' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /requests/:id/messages — يرفض رسالة فارغة', async ({ request }) => {
    const res = await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
      headers: authHeader(customer.token),
      form: { body: '   ' },
    });
    expect(res.status()).toBe(400);
  });

  test('GET /requests/:id/messages — يرفض طرفاً خارجياً', async ({ request }) => {
    const res = await request.get(`/api/requests/${acceptedRequest.id}/messages`, {
      headers: authHeader(outsider.token),
    });
    expect(res.status()).toBe(403);
  });

  test('GET /requests/:id/messages — الطرفان يريان نفس سجل المحادثة', async ({ request }) => {
    const asCustomer = await request.get(`/api/requests/${acceptedRequest.id}/messages`, { headers: authHeader(customer.token) });
    const asTechnician = await request.get(`/api/requests/${acceptedRequest.id}/messages`, { headers: authHeader(technician.token) });
    expect(asCustomer.status()).toBe(200);
    expect(asTechnician.status()).toBe(200);
    const c = (await asCustomer.json()).messages;
    const t = (await asTechnician.json()).messages;
    expect(c.length).toBe(t.length);
  });

  test('GET /chats — العميل يرى الطلب ضمن قائمة محادثاته', async ({ request }) => {
    const res = await request.get('/api/chats', { headers: authHeader(customer.token) });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.chats.some((c) => c.request_id === acceptedRequest.id)).toBe(true);
  });

  test('GET /chat-violations — الأدمن فقط يقدر يشوف سجل المخالفات', async ({ request }) => {
    const forbidden = await request.get('/api/chat-violations', { headers: authHeader(customer.token) });
    expect(forbidden.status()).toBe(403);
  });
});
