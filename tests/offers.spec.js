// tests/offers.spec.js
// يغطي: إرسال عرض، قبوله، قيد "طلب نشط واحد فقط للفني"، ومنطق العمولة المالي
// (أول طلبين مجانيين ثم منع تقديم عرض جديد إذا الرصيد غير كافٍ).
// هذا أهم منطق مالي بالمشروع (يمس أرصدة حقيقية) ولم يكن مغطى بأي اختبار سابقاً.

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
const SERVICE = 'كهربائي';
const CITY = 'عمان';
const AREA = 'القويسمة';

async function registerAndVerify(request, { role, extra = {}, multipart = null }) {
  const email = uniqueEmail(role);
  const phone = uniquePhone();

  const registerRes = multipart
    ? await request.post('/api/auth/register', {
        multipart: { role, email, phone, password: VALID_PASSWORD, ...extra, ...multipart },
      })
    : await request.post('/api/auth/register', {
        form: { role, email, phone, password: VALID_PASSWORD, ...extra },
      });

  if (!registerRes.ok()) {
    const body = await registerRes.text();
    throw new Error(`فشل /auth/register أثناء تجهيز الاختبار (${role}) — الحالة: ${registerRes.status()}, الرد: ${body}`);
  }

  const otp = getPendingOtp(email);
  const res = await request.post('/api/auth/verify-otp', { form: { email, otp } });

  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`فشل /auth/verify-otp أثناء تجهيز الاختبار (${role}) — الحالة: ${res.status()}, الرد: ${body}`);
  }

  const body = await res.json();

  if (!body.token) {
    throw new Error(`نجح /auth/verify-otp لكن بلا توكن بالرد (${role}) — الرد الكامل: ${JSON.stringify(body)}`);
  }

  return { email, phone, token: body.token, user: body.user };
}

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

async function createRequest(request, token, { description = 'وصف تجريبي كافٍ للطول لإنشاء طلب جديد' } = {}) {
  const res = await request.post('/api/requests', {
    headers: authHeader(token),
    multipart: { service: SERVICE, city: CITY, area: AREA, description },
  });
  expect(res.status()).toBe(200);
  return (await res.json()).request;
}

async function completeRequest(request, customerToken, requestId) {
  const res = await request.post(`/api/requests/${requestId}/status`, {
    headers: authHeader(customerToken),
    form: { status: 'مكتمل' },
  });
  expect(res.status()).toBe(200);
  return (await res.json()).request;
}

const technicianRegisterExtra = {
  name: 'فني اختبار عروض',
  city: CITY,
  national_number: uniqueNationalNumber(),
  services: SERVICE,
  areas: AREA,
};
const technicianAvatar = {
  avatar: {
    name: 'avatar.png',
    mimeType: 'image/png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
};

test.describe.serial('دورة العروض ومنطق العمولة المالي', () => {
  let customer;
  let technician;
  let requestOne;
  let requestTwo;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });
    customer = await registerAndVerify(request, { role: 'customer', extra: { name: 'عميل اختبار عروض', city: CITY } });
    technician = await registerAndVerify(request, {
      role: 'technician',
      extra: technicianRegisterExtra,
      multipart: technicianAvatar,
    });
    await request.dispose();
  });

  test('POST /api/requests/:id/offer — الفني يرسل عرضاً بنجاح والطلب يتحول لحالة "وصلت عروض"', async ({ request }) => {
    requestOne = await createRequest(request, customer.token, { description: 'طلب أول لاختبار العروض والعمولة' });

    const res = await request.post(`/api/requests/${requestOne.id}/offer`, {
      headers: authHeader(technician.token),
      form: { offer_price: '15', duration: 'خلال ساعة' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.request.status).toBe('وصلت عروض');
    expect(body.offers.length).toBeGreaterThan(0);
    expect(body.offers[0].status).toBe('pending');
  });

  test('GET /api/requests/:id/offers — العميل يرى عرض الفني', async ({ request }) => {
    const res = await request.get(`/api/requests/${requestOne.id}/offers`, {
      headers: authHeader(customer.token),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.offers.some((o) => o.technician_id)).toBe(true);
  });

  test('POST /api/offers/:id/decision — القبول ينجح ويغيّر حالة الطلب لـ"تم اختيار عرض"', async ({ request }) => {
    const offersRes = await request.get(`/api/requests/${requestOne.id}/offers`, {
      headers: authHeader(customer.token),
    });
    const offerId = (await offersRes.json()).offers[0].id;

    const res = await request.post(`/api/offers/${offerId}/decision`, {
      headers: authHeader(customer.token),
      form: { decision: 'accepted' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.request.status).toBe('تم اختيار عرض');
    expect(body.request.technician_id).toBeTruthy();
  });

  test('قيد "طلب نشط واحد فقط": الفني لا يقدر يرسل عرضاً جديداً وعنده طلب نشط', async ({ request }) => {
    requestTwo = await createRequest(request, customer.token, { description: 'طلب ثانٍ أثناء انشغال الفني بطلب نشط' });

    const res = await request.post(`/api/requests/${requestTwo.id}/offer`, {
      headers: authHeader(technician.token),
      form: { offer_price: '10', duration: 'خلال نصف ساعة' },
    });
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.error).toContain(String(requestOne.id));
  });

  test('إنهاء الطلب الأول (فرصة مجانية 1/2): يكتمل بلا خصم عمولة', async ({ request }) => {
    const completed = await completeRequest(request, customer.token, requestOne.id);
    expect(completed.status).toBe('مكتمل');
    expect(completed.commission_charged).toBe(0);

    const meRes = await request.get('/api/me', { headers: authHeader(technician.token) });
    const me = (await meRes.json()).user;
    expect(me.balance).toBe(0); // ما انخصم شي — كانت فرصة مجانية
    expect(me.free_orders_used).toBe(1);
  });

  test('الآن الفني صار متاحاً: يقدر يرسل عرضاً على الطلب الثاني (فرصة مجانية 2/2)', async ({ request }) => {
    const res = await request.post(`/api/requests/${requestTwo.id}/offer`, {
      headers: authHeader(technician.token),
      form: { offer_price: '12', duration: 'خلال ساعة' },
    });
    expect(res.status()).toBe(200);

    const offersRes = await request.get(`/api/requests/${requestTwo.id}/offers`, {
      headers: authHeader(customer.token),
    });
    const offerId = (await offersRes.json()).offers[0].id;
    await request.post(`/api/offers/${offerId}/decision`, {
      headers: authHeader(customer.token),
      form: { decision: 'accepted' },
    });

    const completed = await completeRequest(request, customer.token, requestTwo.id);
    expect(completed.commission_charged).toBe(0); // ثاني فرصة مجانية أيضاً

    const meRes = await request.get('/api/me', { headers: authHeader(technician.token) });
    const me = (await meRes.json()).user;
    expect(me.balance).toBe(0);
    expect(me.free_orders_used).toBe(2);
  });

  test('استُهلكت الفرصتان المجانيتان: تقديم عرض ثالث بلا رصيد يُرفض بـ 402', async ({ request }) => {
    const requestThree = await createRequest(request, customer.token, {
      description: 'طلب ثالث بعد استهلاك الفرصتين المجانيتين للفني',
    });

    const res = await request.post(`/api/requests/${requestThree.id}/offer`, {
      headers: authHeader(technician.token),
      form: { offer_price: '20', duration: 'خلال ساعتين' },
    });
    expect(res.status()).toBe(402);
    const body = await res.json();
    expect(body.code).toBe('INSUFFICIENT_BALANCE');
    expect(body.free_quota_used).toBeGreaterThanOrEqual(2);
  });
});
