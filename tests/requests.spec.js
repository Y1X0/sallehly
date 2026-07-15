// tests/requests.spec.js
// يغطي: إنشاء طلب من عميل، فحوصات التحقق الأساسية، ورؤية الفني المطابق لخدمته/مدينته للطلب.

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
const SERVICE = 'كهربائي'; // موجودة أصلاً ضمن بيانات الـ seed الافتراضية بـ migrate.js
const CITY = 'عمان';

async function registerAndVerify(request, { role, extra = {}, multipart = null }) {
  const email = uniqueEmail(role);
  const phone = uniquePhone();

  let registerRes;
  if (multipart) {
    registerRes = await request.post('/api/auth/register', {
      multipart: { role, email, phone, password: VALID_PASSWORD, ...extra, ...multipart },
    });
  } else {
    registerRes = await request.post('/api/auth/register', {
      form: { role, email, phone, password: VALID_PASSWORD, ...extra },
    });
  }

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

test.describe.serial('إنشاء الطلبات وعرضها', () => {
  let customer;
  let technician;
  let createdRequestId;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });

    customer = await registerAndVerify(request, {
      role: 'customer',
      extra: { name: 'عميل اختبار', city: CITY },
    });

    technician = await registerAndVerify(request, {
      role: 'technician',
      extra: {
        name: 'فني اختبار',
        city: CITY,
        national_number: uniqueNationalNumber(),
        services: SERVICE,
        areas: 'القويسمة',
      },
      multipart: {
        avatar: {
          name: 'avatar.png',
          mimeType: 'image/png',
          buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        },
      },
    });

    await request.dispose();
  });

  test('POST /api/requests — يرفض الإنشاء بلا توكن', async ({ request }) => {
    const res = await request.post('/api/requests', {
      form: { service: SERVICE, city: CITY, area: 'القويسمة', description: 'وصف تجريبي كافٍ للطول' },
    });
    expect(res.status()).toBe(401);
  });

  test('POST /api/requests — يرفض وصفاً أقصر من 10 أحرف', async ({ request }) => {
    const res = await request.post('/api/requests', {
      headers: { Authorization: `Bearer ${customer.token}` },
      multipart: { service: SERVICE, city: CITY, area: 'القويسمة', description: 'قصير' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/requests — يرفض بلا اسم خدمة', async ({ request }) => {
    const res = await request.post('/api/requests', {
      headers: { Authorization: `Bearer ${customer.token}` },
      multipart: { service: '', city: CITY, area: 'القويسمة', description: 'وصف تجريبي كافٍ للطول' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/requests — ينجئ طلباً صحيحاً بالبيانات الكاملة', async ({ request }) => {
    const res = await request.post('/api/requests', {
      headers: { Authorization: `Bearer ${customer.token}` },
      multipart: {
        service: SERVICE,
        city: CITY,
        area: 'القويسمة',
        description: 'وصف تجريبي كافٍ للطول لإنشاء طلب صيانة كهربائية',
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.request.id).toBeTruthy();
    expect(body.request.status).toBe('بانتظار العروض');
    expect(body.request.customer_id).toBeTruthy();
    createdRequestId = body.request.id;
  });

  test('GET /api/requests — العميل يرى طلبه الخاص فقط', async ({ request }) => {
    const res = await request.get('/api/requests', {
      headers: { Authorization: `Bearer ${customer.token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const ids = body.requests.map((r) => r.id);
    expect(ids).toContain(createdRequestId);
  });

  test('GET /api/requests — الفني المطابق للخدمة والمنطقة يرى الطلب الجديد بقائمته', async ({ request }) => {
    const res = await request.get('/api/requests', {
      headers: { Authorization: `Bearer ${technician.token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const ids = body.requests.map((r) => r.id);
    expect(ids).toContain(createdRequestId);
  });

  test('GET /api/requests — بلا توكن يرجع 401', async ({ request }) => {
    const res = await request.get('/api/requests');
    expect(res.status()).toBe(401);
  });

  test('DELETE /api/requests/:id — عميل آخر لا يقدر يحذف طلب ليس له', async ({ request }) => {
    const otherCustomer = await registerAndVerify(request, {
      role: 'customer',
      extra: { name: 'عميل آخر', city: CITY },
    });
    const res = await request.delete(`/api/requests/${createdRequestId}`, {
      headers: { Authorization: `Bearer ${otherCustomer.token}` },
    });
    // الاستعلام بالراوت يبحث عن الطلب بشرط customer_id=عميل آخر فلن يجده أصلاً
    expect(res.status()).toBe(404);
  });
});

// [SEC-FIX-16] طلب "مكتمل" أو "ملغي" حالة نهائية — إعادته لحالة نشطة (مثل
// "قيد التنفيذ") كانت تُفعّل بالخطأ قيد "طلب نشط واحد فقط" وتمنع الفني من
// قبول أي عمل جديد، رغم إنه ما إله علاقة فعلية بأي عمل نشط حقيقي.
test.describe.serial('[SEC-FIX-16] منع إحياء طلب مكتمل/ملغي وتحويله لحالة نشطة', () => {
  let customer;
  let technician;
  let completedRequestId;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });
    customer = await registerAndVerify(request, { role: 'customer', extra: { name: 'عميل اختبار إحياء الطلبات', city: CITY } });
    technician = await registerAndVerify(request, {
      role: 'technician',
      extra: {
        name: 'فني اختبار إحياء الطلبات',
        city: CITY,
        national_number: uniqueNationalNumber(),
        services: SERVICE,
        areas: 'القويسمة',
      },
      multipart: {
        avatar: {
          name: 'avatar.png',
          mimeType: 'image/png',
          buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        },
      },
    });
    await request.dispose();
  });

  test('تجهيز: إنشاء طلب، قبول عرض، ثم إكماله', async ({ request }) => {
    const createRes = await request.post('/api/requests', {
      headers: { Authorization: `Bearer ${customer.token}` },
      multipart: { service: SERVICE, city: CITY, area: 'القويسمة', description: 'طلب لاختبار منع إحياء الطلبات المغلقة' },
    });
    expect(createRes.status()).toBe(200);
    completedRequestId = (await createRes.json()).request.id;

    const offerRes = await request.post(`/api/requests/${completedRequestId}/offer`, {
      headers: { Authorization: `Bearer ${technician.token}` },
      form: { offer_price: '10', duration: 'فوري' },
    });
    expect(offerRes.status()).toBe(200);
    const offerId = (await offerRes.json()).offers[0].id;

    const acceptRes = await request.post(`/api/offers/${offerId}/decision`, {
      headers: { Authorization: `Bearer ${customer.token}` },
      form: { decision: 'accepted' },
    });
    expect(acceptRes.status()).toBe(200);

    const completeRes = await request.post(`/api/requests/${completedRequestId}/status`, {
      headers: { Authorization: `Bearer ${customer.token}` },
      form: { status: 'مكتمل' },
    });
    expect(completeRes.status()).toBe(200);
    expect((await completeRes.json()).request.status).toBe('مكتمل');
  });

  test('[SEC-FIX-16] العميل لا يقدر يعيد طلباً مكتملاً لحالة "قيد التنفيذ"', async ({ request }) => {
    const res = await request.post(`/api/requests/${completedRequestId}/status`, {
      headers: { Authorization: `Bearer ${customer.token}` },
      form: { status: 'قيد التنفيذ' },
    });
    expect(res.status()).toBe(409);
  });

  test('[SEC-FIX-16] الفني يبقى قادراً على قبول عمل جديد (لم يُحجز بالخطأ بطلب قديم مغلق)', async ({ request }) => {
    const newRequestRes = await request.post('/api/requests', {
      headers: { Authorization: `Bearer ${customer.token}` },
      multipart: { service: SERVICE, city: CITY, area: 'القويسمة', description: 'طلب جديد للتأكد من عدم حجز الفني بالخطأ' },
    });
    expect(newRequestRes.status()).toBe(200);
    const newRequestId = (await newRequestRes.json()).request.id;

    const offerRes = await request.post(`/api/requests/${newRequestId}/offer`, {
      headers: { Authorization: `Bearer ${technician.token}` },
      form: { offer_price: '11', duration: 'فوري' },
    });
    expect(offerRes.status()).toBe(200);
  });
});
