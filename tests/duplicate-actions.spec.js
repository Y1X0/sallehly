// tests/duplicate-actions.spec.js
// يغطي "الضغط المزدوج على الزر" (Duplicate button presses) و"القبول المزدوج"
// (Double acceptance) صراحة — كلاهما مذكور بمتطلبات QA لكن غير مختبَر مباشرة:
// tests/offers.spec.js يغطي قبول عرض *ثانٍ* مختلف بعد قبول الأول ([SEC-FIX-15])،
// وليس نفس العرض بالضبط مرتين — لا تسلسلياً ولا كضغطتين متزامنتين حقيقيتين.

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
const SERVICE = 'سباك';
const CITY = 'عمان';

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
    : await request.post('/api/auth/register', { form: { role, email, phone, password: VALID_PASSWORD, ...extra } });
  if (!registerRes.ok()) throw new Error(`فشل تسجيل (${role}): ${registerRes.status()} ${await registerRes.text()}`);
  const otp = getPendingOtp(email);
  const res = await request.post('/api/auth/verify-otp', { form: { email, otp } });
  if (!res.ok()) throw new Error(`فشل verify-otp (${role}): ${res.status()} ${await res.text()}`);
  const body = await res.json();
  return { email, phone, token: body.token, user: body.user };
}

async function setupRequestWithOffer(request) {
  const customer = await registerAndVerify(request, 'customer', { name: 'عميل ضغط مزدوج', city: CITY });
  const technician = await registerAndVerify(request, 'technician', {
    name: 'فني ضغط مزدوج', city: CITY, national_number: uniqueNationalNumber(), services: SERVICE, areas: 'القويسمة',
  });
  const createRes = await request.post('/api/requests', {
    headers: authHeader(customer.token),
    form: { service: SERVICE, description: 'طلب لاختبار الضغط المزدوج على قبول العرض', city: CITY, area: 'القويسمة' },
  });
  const requestId = (await createRes.json()).request.id;
  const offerRes = await request.post(`/api/requests/${requestId}/offer`, {
    headers: authHeader(technician.token),
    form: { offer_price: '18', duration: '30 دقيقة' },
  });
  const offerId = (await offerRes.json()).offers[0].id;
  return { customer, technician, requestId, offerId };
}

test.describe('[Duplicate] قبول نفس العرض مرتين — تسلسلياً', () => {
  test('القبول الثاني لنفس العرض (بعد نجاح الأول) يُرفض بـ400 ولا يغيّر شيئاً', async ({ request }) => {
    const { customer, requestId, offerId } = await setupRequestWithOffer(request);

    const first = await request.post(`/api/offers/${offerId}/decision`, {
      headers: authHeader(customer.token),
      form: { decision: 'accepted' },
    });
    expect(first.ok()).toBeTruthy();
    const firstBody = await first.json();
    expect(firstBody.request.status).toBe('تم اختيار عرض');

    const second = await request.post(`/api/offers/${offerId}/decision`, {
      headers: authHeader(customer.token),
      form: { decision: 'accepted' },
    });
    expect(second.status()).toBe(400);

    // الحالة تبقى بلا أي تغيير إضافي بعد المحاولة الثانية
    const offersRes = await request.get(`/api/requests/${requestId}/offers`, { headers: authHeader(customer.token) });
    expect((await offersRes.json()).request.status).toBe('تم اختيار عرض');
  });
});

test.describe('[Duplicate] ضغطتان متزامنتان فعلياً على قبول نفس العرض', () => {
  test('طلبان متزامنان (Promise.all، بلا await بينهما) على نفس العرض: نجاح واحد فقط بالضبط، لا تلف حالة', async ({ request }) => {
    const { customer, requestId, offerId } = await setupRequestWithOffer(request);

    const [resA, resB] = await Promise.all([
      request.post(`/api/offers/${offerId}/decision`, { headers: authHeader(customer.token), form: { decision: 'accepted' } }),
      request.post(`/api/offers/${offerId}/decision`, { headers: authHeader(customer.token), form: { decision: 'accepted' } }),
    ]);

    const statuses = [resA.status(), resB.status()].sort();
    // بالضبط نجاح واحد (200) وفشل واحد (400) — ليس نجاحين، وليس فشلين
    expect(statuses).toEqual([200, 400]);

    const offersRes = await request.get(`/api/requests/${requestId}/offers`, { headers: authHeader(customer.token) });
    const finalBody = await offersRes.json();
    expect(finalBody.request.status).toBe('تم اختيار عرض');
    // عرض واحد فقط مقبول ضمن عروض هذا الطلب — لا حالة متضاربة
    const acceptedOffers = finalBody.offers.filter((o) => o.status === 'accepted');
    expect(acceptedOffers).toHaveLength(1);
    expect(acceptedOffers[0].id).toBe(offerId);
  });
});
