// tests/admin-request-detail.spec.js
// [FEAT-ADMINREQUESTDETAIL-01] راجع DECISIONS.md — GET /admin/requests/:id
// جديد يجمع صف الطلب كاملاً (يشمل cancel_reason/cancelled_by/cancelled_at
// المُسجَّلة أصلاً لكن لم تكن تُعرَض بأي مكان)، كل العروض المُقدَّمة عليه،
// والمحادثة الكاملة (عبر getMessages المشتركة — نفس الدالة المستخدَمة
// بـGET /requests/:id/messages) — أول endpoint يجمع الثلاثة معاً لطلب واحد.

const { test, expect } = require('@playwright/test');
const { getPendingOtp, openTestDb } = require('./helpers/db');

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
const SERVICE = 'كهربائي';
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
          avatar: { name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
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

async function loginAdmin(request) {
  const res = await request.post('/api/auth/login', { form: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  if (!res.ok()) throw new Error(`فشل دخول الأدمن: ${res.status()} ${await res.text()}`);
  return (await res.json()).token;
}

/// يبني طلباً كاملاً: عميل ينشئ، فني يقدّم عرضاً، العميل يقبله (technician_id
/// يُضبَط، status='تم اختيار عرض')، ثم كلا الطرفين يتبادلان رسالة.
async function buildFullRequestFlow(request) {
  const customer = await registerAndVerify(request, 'customer', { name: 'عميل تفاصيل النزاع', city: CITY });
  const technician = await registerAndVerify(request, 'technician', {
    name: 'فني تفاصيل النزاع', city: CITY, national_number: uniqueNationalNumber(), services: SERVICE, areas: 'القويسمة',
  });

  const createRes = await request.post('/api/requests', {
    headers: authHeader(customer.token),
    form: { service: SERVICE, city: CITY, area: 'القويسمة', description: 'وصف مشكلة لاختبار تفاصيل النزاع' },
  });
  expect(createRes.ok()).toBeTruthy();
  const requestId = (await createRes.json()).request.id;

  const offerRes = await request.post(`/api/requests/${requestId}/offer`, {
    headers: authHeader(technician.token),
    form: { offer_price: '25', duration: 'خلال ساعة', note: 'عرض اختبار' },
  });
  expect(offerRes.ok()).toBeTruthy();
  const offerId = (await offerRes.json()).offers[0].id;

  const decisionRes = await request.post(`/api/offers/${offerId}/decision`, {
    headers: authHeader(customer.token),
    form: { decision: 'accepted' },
  });
  expect(decisionRes.ok()).toBeTruthy();

  const custMsgRes = await request.post(`/api/requests/${requestId}/messages`, {
    headers: authHeader(customer.token),
    form: { body: 'متى تصل؟' },
  });
  expect(custMsgRes.ok()).toBeTruthy();

  const techMsgRes = await request.post(`/api/requests/${requestId}/messages`, {
    headers: authHeader(technician.token),
    form: { body: 'بعد 20 دقيقة' },
  });
  expect(techMsgRes.ok()).toBeTruthy();

  return { customer, technician, requestId, offerId };
}

test.describe('[FEAT-ADMINREQUESTDETAIL-01] GET /admin/requests/:id — صورة كاملة لطلب واحد', () => {
  test('يُرجع صف الطلب + اسم العميل/الفني + كل العروض + المحادثة الكاملة', async ({ request }) => {
    const { customer, technician, requestId, offerId } = await buildFullRequestFlow(request);
    const adminToken = await loginAdmin(request);

    const res = await request.get(`/api/admin/requests/${requestId}`, { headers: authHeader(adminToken) });
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body.request.id).toBe(requestId);
    expect(body.request.customer_name).toBe(customer.user.name);
    expect(body.request.technician_name).toBe(technician.user.name);
    expect(body.request.status).toBe('تم اختيار عرض');

    expect(body.offers).toHaveLength(1);
    expect(body.offers[0].id).toBe(offerId);
    expect(body.offers[0].technician_name).toBe(technician.user.name);
    expect(body.offers[0].status).toBe('accepted');

    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].body).toBe('متى تصل؟');
    expect(body.messages[0].sender_name).toBe(customer.user.name);
    expect(body.messages[1].body).toBe('بعد 20 دقيقة');
    expect(body.messages[1].sender_name).toBe(technician.user.name);
  });

  // [FEAT-ADMINREQUESTDETAIL-01] الهدف الصريح المطلوب: cancel_reason/
  // cancelled_by/cancelled_at مُسجَّلة أصلاً بقاعدة البيانات منذ
  // POST /admin/requests/:id/cancel لكن لم تكن تُعرَض بأي مكان — هذا الاختبار
  // يثبت أنها تصل فعلياً باستجابة GET /admin/requests/:id الجديدة.
  test('بعد إلغاء الأدمن للطلب: cancel_reason وcancelled_by وcancelled_at وcancelled_by_name تظهر كلها بالتفاصيل', async ({ request }) => {
    const { requestId } = await buildFullRequestFlow(request);
    const adminToken = await loginAdmin(request);

    const cancelRes = await request.post(`/api/admin/requests/${requestId}/cancel`, {
      headers: authHeader(adminToken),
      data: { reason: 'العميل والفني لم يتفقا على السعر النهائي' },
    });
    expect(cancelRes.ok()).toBeTruthy();

    const res = await request.get(`/api/admin/requests/${requestId}`, { headers: authHeader(adminToken) });
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body.request.status).toBe('ملغي');
    expect(body.request.cancel_reason).toBe('العميل والفني لم يتفقا على السعر النهائي');
    expect(body.request.cancelled_by).not.toBeNull();
    expect(body.request.cancelled_at).not.toBeNull();
    expect(body.request.cancelled_by_name).toBeTruthy();
  });

  test('طلب بلا فني مُعيَّن بعد (لا عرض مقبول): technician_name فارغة، لا خطأ', async ({ request }) => {
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل بلا فني بعد', city: CITY });
    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      form: { service: SERVICE, city: CITY, area: 'القويسمة', description: 'طلب بلا عرض مقبول بعد' },
    });
    const requestId = (await createRes.json()).request.id;
    const adminToken = await loginAdmin(request);

    const res = await request.get(`/api/admin/requests/${requestId}`, { headers: authHeader(adminToken) });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.request.technician_name).toBeNull();
    expect(body.offers).toHaveLength(0);
    expect(body.messages).toHaveLength(0);
  });

  test('معرّف طلب غير موجود: 404', async ({ request }) => {
    const adminToken = await loginAdmin(request);
    const res = await request.get('/api/admin/requests/999999999', { headers: authHeader(adminToken) });
    expect(res.status()).toBe(404);
  });

  test('عميل أو فني (لا أدمن) يُرفَض بـ403 — نفس حماية requireRole على كل مسارات الأدمن الأخرى', async ({ request }) => {
    const { customer, technician, requestId } = await buildFullRequestFlow(request);

    const asCustomer = await request.get(`/api/admin/requests/${requestId}`, { headers: authHeader(customer.token) });
    expect(asCustomer.status()).toBe(403);

    const asTechnician = await request.get(`/api/admin/requests/${requestId}`, { headers: authHeader(technician.token) });
    expect(asTechnician.status()).toBe(403);
  });

  // [FEAT-ADMINREQUESTDETAIL-01] راجع تعليق المسار — عمداً بلا markChatRead:
  // عرض الأدمن للمحادثة لا يجوز أن يغيّر مؤشر "تمت المشاهدة" الخاص بالطرفين
  // الفعليين. تحقّق مباشر من جدول chat_reads نفسه، لا افتراضاً من سلوك الرد.
  test('عرض الأدمن للمحادثة لا يكتب أي صف بجدول chat_reads (لا يؤثر على مؤشر المشاهدة لدى الطرفين)', async ({ request }) => {
    const { requestId } = await buildFullRequestFlow(request);
    const adminToken = await loginAdmin(request);

    const db = openTestDb();
    let beforeCount;
    try {
      beforeCount = db.prepare('SELECT COUNT(*) c FROM chat_reads WHERE request_id=?').get(requestId).c;
    } finally {
      db.close();
    }

    const res = await request.get(`/api/admin/requests/${requestId}`, { headers: authHeader(adminToken) });
    expect(res.status()).toBe(200);

    const db2 = openTestDb();
    try {
      const afterCount = db2.prepare('SELECT COUNT(*) c FROM chat_reads WHERE request_id=?').get(requestId).c;
      expect(afterCount).toBe(beforeCount);
    } finally {
      db2.close();
    }
  });
});
