// tests/request-lifecycle.spec.js
// يغطي دورة حياة الطلب الكاملة بسلسلة واحدة صريحة (بانتظار العروض → وصلت
// عروض → تم اختيار عرض → قيد التنفيذ → مكتمل)، وإلغاء العميل الذاتي قبل قبول
// أي عرض (DELETE /requests/:id) بمساريه: النجاح والمنع بعد قبول عرض — وكلاهما
// لم يكن مغطى مباشرة رغم وجود المنطق بالكود (routes/requests.routes.js).

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

test.describe.serial('[Lifecycle] دورة حياة الطلب الكاملة: pending → accepted → working → completed', () => {
  let customer, technician, requestId, offerId;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });
    customer = await registerAndVerify(request, 'customer', { name: 'عميل دورة الحياة', city: CITY });
    technician = await registerAndVerify(request, 'technician', {
      name: 'فني دورة الحياة', city: CITY, national_number: uniqueNationalNumber(), services: SERVICE, areas: 'القويسمة',
    });
  });

  test('1) الإنشاء: الطلب يبدأ بحالة "بانتظار العروض" (pending)', async ({ request }) => {
    const res = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      form: { service: SERVICE, description: 'وصف كافٍ لاختبار دورة حياة الطلب الكاملة', city: CITY, area: 'القويسمة' },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    requestId = body.request.id;
    expect(body.request.status).toBe('بانتظار العروض');
  });

  test('2) عرض فني: الحالة تتحول تلقائياً إلى "وصلت عروض" (pending، مرحلة متقدمة)', async ({ request }) => {
    const res = await request.post(`/api/requests/${requestId}/offer`, {
      headers: authHeader(technician.token),
      form: { offer_price: '12', duration: '30 دقيقة' },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.request.status).toBe('وصلت عروض');
    offerId = body.offers[0].id;
  });

  test('3) قبول العرض: الحالة تتحول إلى "تم اختيار عرض" (accepted)', async ({ request }) => {
    const res = await request.post(`/api/offers/${offerId}/decision`, {
      headers: authHeader(customer.token),
      form: { decision: 'accepted' },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.request.status).toBe('تم اختيار عرض');
    expect(body.request.technician_id).toBe(technician.user.id);
  });

  test('4) بدء التنفيذ: الفني يحدّث الحالة إلى "قيد التنفيذ" (working)', async ({ request }) => {
    const res = await request.post(`/api/requests/${requestId}/status`, {
      headers: authHeader(technician.token),
      form: { status: 'قيد التنفيذ' },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.request.status).toBe('قيد التنفيذ');
  });

  test('5) الإكمال: العميل يحدّث الحالة إلى "مكتمل" (completed)، والعمولة تُحتسب كطلب مجاني', async ({ request }) => {
    const res = await request.post(`/api/requests/${requestId}/status`, {
      headers: authHeader(customer.token),
      form: { status: 'مكتمل' },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.request.status).toBe('مكتمل');
    expect(body.request.commission_charged).toBe(0); // أول طلب مجاني للفني
  });

  test('6) الحالة النهائية: لا يمكن لأي طرف إعادتها لأي حالة نشطة بعد الآن', async ({ request }) => {
    const res = await request.post(`/api/requests/${requestId}/status`, {
      headers: authHeader(customer.token),
      form: { status: 'قيد التنفيذ' },
    });
    expect(res.status()).toBe(409);
  });
});

test.describe.serial('[Lifecycle] إلغاء العميل الذاتي (cancelled) — DELETE /requests/:id', () => {
  let customer, technician, pendingRequestId, acceptedRequestId, offerIdOnAccepted;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });
    customer = await registerAndVerify(request, 'customer', { name: 'عميل الإلغاء', city: CITY });
    technician = await registerAndVerify(request, 'technician', {
      name: 'فني الإلغاء', city: CITY, national_number: uniqueNationalNumber(), services: SERVICE, areas: 'القويسمة',
    });
  });

  test('طلب بلا أي عرض مقبول بعد: العميل يلغيه بنجاح، والحالة تصبح "ملغي"', async ({ request }) => {
    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      form: { service: SERVICE, description: 'طلب سيُلغى قبل قبول أي عرض', city: CITY, area: 'القويسمة' },
    });
    pendingRequestId = (await createRes.json()).request.id;

    const offerRes = await request.post(`/api/requests/${pendingRequestId}/offer`, {
      headers: authHeader(technician.token),
      form: { offer_price: '8', duration: '20 دقيقة' },
    });
    const pendingOfferId = (await offerRes.json()).offers[0].id;

    const cancelRes = await request.delete(`/api/requests/${pendingRequestId}`, { headers: authHeader(customer.token) });
    expect(cancelRes.ok()).toBeTruthy();
    const cancelBody = await cancelRes.json();
    expect(cancelBody.request.status).toBe('ملغي');

    // العرض المعلّق على الطلب المُلغى يُرفض تلقائياً معه
    const offersRes = await request.get(`/api/requests/${pendingRequestId}/offers`, { headers: authHeader(technician.token) });
    const offersBody = await offersRes.json();
    const affectedOffer = offersBody.offers.find((o) => o.id === pendingOfferId);
    expect(affectedOffer.status).toBe('rejected');
  });

  test('طلب مُلغى مسبقاً: إعادة محاولة الإلغاء لا تكسر شيئاً (idempotent) وتبقى الحالة "ملغي"', async ({ request }) => {
    // 'ملغي' ليست ضمن قائمتَي المنع بالراوت (مكتمل، أو الحالات النشطة بعد قبول
    // عرض) — إعادة الحذف على طلب مُلغى أصلاً تُعيد تنفيذ نفس التحديث بأمان
    // (WHERE status='pending' لا يطابق أي عرض فعلاً)، فتبقى النتيجة 200 دون أي أثر إضافي.
    const res = await request.delete(`/api/requests/${pendingRequestId}`, { headers: authHeader(customer.token) });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.request.status).toBe('ملغي');
  });

  test('طلب بعد قبول عرض فني: DELETE يُرفض بـ400 صراحة (لا يمكن التراجع بعد بدء الفني)', async ({ request }) => {
    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      form: { service: SERVICE, description: 'طلب سيُقبَل عرضه ثم يُحاول العميل إلغاءه', city: CITY, area: 'القويسمة' },
    });
    acceptedRequestId = (await createRes.json()).request.id;

    const offerRes = await request.post(`/api/requests/${acceptedRequestId}/offer`, {
      headers: authHeader(technician.token),
      form: { offer_price: '9', duration: '25 دقيقة' },
    });
    offerIdOnAccepted = (await offerRes.json()).offers[0].id;

    await request.post(`/api/offers/${offerIdOnAccepted}/decision`, {
      headers: authHeader(customer.token),
      form: { decision: 'accepted' },
    });

    const res = await request.delete(`/api/requests/${acceptedRequestId}`, { headers: authHeader(customer.token) });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('لا يمكن إلغاء الطلب بعد قبول عرض الفني');

    // الحالة تبقى كما هي تماماً — لم يتأثر شيء بمحاولة الحذف المرفوضة
    const offersRes = await request.get(`/api/requests/${acceptedRequestId}/offers`, { headers: authHeader(customer.token) });
    const request_ = (await offersRes.json()).request;
    expect(request_.status).toBe('تم اختيار عرض');
  });
});
