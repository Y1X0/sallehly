// tests/offers.spec.js
// يغطي: إرسال عرض، قبوله، قيد "طلب نشط واحد فقط للفني"، ومنطق العمولة المالي
// (أول طلبين مجانيين ثم منع تقديم عرض جديد إذا الرصيد غير كافٍ).
// هذا أهم منطق مالي بالمشروع (يمس أرصدة حقيقية) ولم يكن مغطى بأي اختبار سابقاً.

const { test, expect } = require('@playwright/test');
const { getPendingOtp, openTestDb } = require('./helpers/db');

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

// [SEC-FIX-15] بعد قبول عرض على طلب، لا يجوز اتخاذ قرار "قبول" جديد على عرض
// آخر لنفس الطلب (سواء كان مرفوضاً تلقائياً أو غير ذلك) — هذا كان يعيد تعيين
// الطلب لفني مختلف بصمت ويسحب التعيين من الفني الأول بدون أي تنبيه له.
test.describe.serial('[SEC-FIX-15] منع إعادة اتخاذ قرار على عرض بعد حسمه', () => {
  let customer;
  let techA;
  let techB;
  let requestId;
  let offerAId;
  let offerBId;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });
    customer = await registerAndVerify(request, { role: 'customer', extra: { name: 'عميل اختبار حسم العروض', city: CITY } });
    techA = await registerAndVerify(request, {
      role: 'technician',
      extra: { ...technicianRegisterExtra, name: 'فني أ - اختبار حسم العروض', national_number: uniqueNationalNumber() },
      multipart: technicianAvatar,
    });
    techB = await registerAndVerify(request, {
      role: 'technician',
      extra: { ...technicianRegisterExtra, name: 'فني ب - اختبار حسم العروض', national_number: uniqueNationalNumber() },
      multipart: technicianAvatar,
    });
    await request.dispose();
  });

  test('تجهيز: فنيان يرسلان عرضاً، والعميل يقبل عرض الفني الأول', async ({ request }) => {
    requestId = (await createRequest(request, customer.token, { description: 'طلب لاختبار منع إعادة قبول عرض محسوم مسبقاً' })).id;

    const offerARes = await request.post(`/api/requests/${requestId}/offer`, {
      headers: authHeader(techA.token),
      form: { offer_price: '20', duration: 'فوري' },
    });
    expect(offerARes.status()).toBe(200);

    const offerBRes = await request.post(`/api/requests/${requestId}/offer`, {
      headers: authHeader(techB.token),
      form: { offer_price: '15', duration: 'فوري' },
    });
    expect(offerBRes.status()).toBe(200);

    const offersRes = await request.get(`/api/requests/${requestId}/offers`, { headers: authHeader(customer.token) });
    const offers = (await offersRes.json()).offers;
    offerAId = offers.find((o) => o.price === 20).id;
    offerBId = offers.find((o) => o.price === 15).id;

    const acceptRes = await request.post(`/api/offers/${offerAId}/decision`, {
      headers: authHeader(customer.token),
      form: { decision: 'accepted' },
    });
    expect(acceptRes.status()).toBe(200);
    expect((await acceptRes.json()).request.technician_id).toBe(techA.user.id);
  });

  test('[SEC-FIX-15] قبول العرض الثاني (المرفوض تلقائياً) يُرفض ولا يُعيد تعيين الطلب', async ({ request }) => {
    const res = await request.post(`/api/offers/${offerBId}/decision`, {
      headers: authHeader(customer.token),
      form: { decision: 'accepted' },
    });
    expect(res.status()).toBe(400);

    const checkRes = await request.get(`/api/requests/${requestId}/offers`, { headers: authHeader(customer.token) });
    const checkBody = await checkRes.json();
    expect(checkBody.request.technician_id).toBe(techA.user.id);
    expect(checkBody.request.offer_price).toBe(20);
  });
});

// [FIX-OFFERQUOTA-01] عدّاد free_offers_used دائم ومنفصل تماماً عن free_orders_used
// (الذي يبقى بلا أي تعديل ويحكم فقط "أول طلبين مكتملين بلا عمولة"). كان الحساب
// القديم يعتمد على COUNT(DISTINCT request_id) الحي من جدول offers، فيتناقص فور
// سحب عرض (DELETE /offers/:id) ويسمح بتجاوز حد الفرصتين المجانيتين بلا نهاية.
test.describe.serial('[FIX-OFFERQUOTA-01] عدّاد فرص العروض المجانية الدائم', () => {
  let customer;
  let tech;
  let firstOfferId;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });
    customer = await registerAndVerify(request, { role: 'customer', extra: { name: 'عميل اختبار حصة العروض', city: CITY } });
    tech = await registerAndVerify(request, {
      role: 'technician',
      extra: { ...technicianRegisterExtra, name: 'فني اختبار حصة العروض', national_number: uniqueNationalNumber() },
      multipart: technicianAvatar,
    });
    await request.dispose();
  });

  test('[1] فرصتان مجانيتان فقط: العرض الثالث بلا رصيد يُرفض بـ402', async ({ request }) => {
    const r1 = await createRequest(request, customer.token, { description: 'طلب أول لاختبار حصة العروض المجانية' });
    const offer1Res = await request.post(`/api/requests/${r1.id}/offer`, { headers: authHeader(tech.token), form: { offer_price: '10', duration: 'فوري' } });
    expect(offer1Res.status()).toBe(200);
    const offer1Body = await offer1Res.json();
    firstOfferId = offer1Body.offers.find((o) => o.request_id === r1.id).id;

    const r2 = await createRequest(request, customer.token, { description: 'طلب ثانٍ لاختبار حصة العروض المجانية' });
    const offer2Res = await request.post(`/api/requests/${r2.id}/offer`, { headers: authHeader(tech.token), form: { offer_price: '10', duration: 'فوري' } });
    expect(offer2Res.status()).toBe(200);

    const meRes = await request.get('/api/me', { headers: authHeader(tech.token) });
    const me = (await meRes.json()).user;
    expect(me.free_offers_used).toBe(2);
    expect(me.free_offers_remaining).toBe(0);

    const r3 = await createRequest(request, customer.token, { description: 'طلب ثالث بعد استهلاك الفرصتين المجانيتين مباشرة' });
    const offer3Res = await request.post(`/api/requests/${r3.id}/offer`, { headers: authHeader(tech.token), form: { offer_price: '10', duration: 'فوري' } });
    expect(offer3Res.status()).toBe(402);
    const body = await offer3Res.json();
    expect(body.code).toBe('INSUFFICIENT_BALANCE');
  });

  test('[2] سحب عرض سابق لا يُعيد أي فرصة مجانية', async ({ request }) => {
    // نسحب أول عرض قدّمه الفني بالاختبار السابق بالكامل — هذا يُنقص العدد الحي
    // بجدول offers (COUNT(DISTINCT request_id) يهبط من 2 إلى 1)، لكن يجب ألا
    // يُعيد أي فرصة مجانية طالما free_offers_used دائم ولا يتراجع.
    const withdrawRes = await request.delete(`/api/offers/${firstOfferId}`, { headers: authHeader(tech.token) });
    expect(withdrawRes.status()).toBe(200);

    const meRes = await request.get('/api/me', { headers: authHeader(tech.token) });
    const me = (await meRes.json()).user;
    expect(me.free_offers_used).toBe(2); // لم يتغيّر رغم سحب العرض
    expect(me.free_offers_remaining).toBe(0);

    const r4 = await createRequest(request, customer.token, { description: 'طلب رابع بعد سحب عرض سابق — يجب أن يبقى مرفوضاً' });
    const offer4Res = await request.post(`/api/requests/${r4.id}/offer`, { headers: authHeader(tech.token), form: { offer_price: '10', duration: 'فوري' } });
    expect(offer4Res.status()).toBe(402);
  });

  test('[3] إعادة تقديم/تعديل عرض على نفس الطلب لا يستهلك أكثر من فرصة واحدة', async ({ request }) => {
    const freshTech = await registerAndVerify(request, {
      role: 'technician',
      extra: { ...technicianRegisterExtra, name: 'فني اختبار تكرار نفس الطلب', national_number: uniqueNationalNumber() },
      multipart: technicianAvatar,
    });
    const r = await createRequest(request, customer.token, { description: 'طلب لاختبار عدم احتساب تعديل السعر كمحاولة ثانية' });

    // نفس الفني يرسل عرضاً على نفس الطلب 3 مرات متتالية (تعديل السعر في كل مرة).
    for (const price of ['10', '12', '15']) {
      const res = await request.post(`/api/requests/${r.id}/offer`, { headers: authHeader(freshTech.token), form: { offer_price: price, duration: 'فوري' } });
      expect(res.status()).toBe(200);
    }

    const meRes = await request.get('/api/me', { headers: authHeader(freshTech.token) });
    const me = (await meRes.json()).user;
    expect(me.free_offers_used).toBe(1); // ليس 3 — نفس الطلب في كل مرة
    expect(me.free_offers_remaining).toBe(1);

    // إثبات إضافي: فرصة ثانية حقيقية (على طلب مختلف) لازالت متاحة فعلاً.
    const r2 = await createRequest(request, customer.token, { description: 'طلب ثانٍ حقيقي — يجب أن تبقى الفرصة الثانية متاحة' });
    const secondRealOfferRes = await request.post(`/api/requests/${r2.id}/offer`, { headers: authHeader(freshTech.token), form: { offer_price: '10', duration: 'فوري' } });
    expect(secondRealOfferRes.status()).toBe(200);
  });

  test('[4] الترحيل: فني موجود مسبقاً بتاريخ عروض حقيقي يُرحَّل بشكل صحيح', async ({ request }) => {
    // "tech" استهلك بالفعل فرصتين حقيقيتين بالاختبار [1] أعلاه. نحاكي هنا حالة
    // "قبل الترحيل" بتصفير free_offers_used مباشرة بقاعدة البيانات (كما لو أن
    // عمود free_offers_used أُضيف للتو ولم يُهيَّأ بعد لهذا الفني تحديداً)، ثم
    // نُعيد تنفيذ نفس صيغة SQL الخاصة بالترحيل (config/migrate.js) ونتأكد أنها
    // تُعيد حساب القيمة الصحيحة اعتماداً على تاريخ العروض الحقيقي المخزَّن فعلاً.
    const db = openTestDb();
    try {
      db.prepare('UPDATE users SET free_offers_used = 0 WHERE id = ?').run(tech.user.id);
      const before = db.prepare('SELECT free_offers_used FROM users WHERE id=?').get(tech.user.id);
      expect(before.free_offers_used).toBe(0);

      db.prepare(`
        UPDATE users SET free_offers_used = (
          SELECT COUNT(DISTINCT request_id) FROM offers WHERE offers.technician_id = users.id
        ) WHERE role = 'technician' AND id = ?
      `).run(tech.user.id);

      const after = db.prepare('SELECT free_offers_used FROM users WHERE id=?').get(tech.user.id);
      // الفني قدّم عروضاً على طلبين مختلفين بالاختبار [1] (أحدهما سُحب لاحقاً
      // بالاختبار [2]، لكن صف العرض المسحوب حُذف من الجدول — يبقى طلب واحد
      // فقط بجدول offers حالياً). القيمة الصحيحة المُرحَّلة تعكس هذا الواقع.
      expect(after.free_offers_used).toBe(1);
    } finally {
      db.close();
    }
  });
});
