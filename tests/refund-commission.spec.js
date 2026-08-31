// tests/refund-commission.spec.js
// [FEAT-REFUND-01] راجع DECISIONS.md — POST /admin/requests/:id/refund-commission
// أول آلية استرداد إدارية حقيقية: تعكس commission_charged وتُضيف الرصيد
// للفني بمعاملة واحدة، وتُسجَّل بنوع ledger مختلف تماماً عن التعديل اليدوي
// العام ('استرداد عمولة نزاع' لا 'تعديل يدوي من الإدارة')، مرتبطة بـrequest_id.

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

/// يبني طلباً حتى قبول عرض الفني (technician_id مُعيَّن، status='تم اختيار عرض')
/// دون إكماله — يُستخدَم لاختبارات الحالات التي لا تحتاج عمولة مخصومة فعلياً.
async function buildAcceptedRequest(request) {
  const customer = await registerAndVerify(request, 'customer', { name: 'عميل استرداد', city: CITY });
  const technician = await registerAndVerify(request, 'technician', {
    name: 'فني استرداد', city: CITY, national_number: uniqueNationalNumber(), services: SERVICE, areas: 'القويسمة',
  });

  const createRes = await request.post('/api/requests', {
    headers: authHeader(customer.token),
    form: { service: SERVICE, city: CITY, area: 'القويسمة', description: 'وصف مشكلة لاختبار الاسترداد' },
  });
  const requestId = (await createRes.json()).request.id;

  const offerRes = await request.post(`/api/requests/${requestId}/offer`, {
    headers: authHeader(technician.token),
    form: { offer_price: '25', duration: 'خلال ساعة' },
  });
  const offerId = (await offerRes.json()).offers[0].id;

  await request.post(`/api/offers/${offerId}/decision`, {
    headers: authHeader(customer.token),
    form: { decision: 'accepted' },
  });

  return { customer, technician, requestId };
}

/// يبني طلباً مُكتملاً بعمولة مخصومة فعلياً (لا الفرع المجاني) — يفرض
/// استهلاك الفرصتين المجانيتين ورصيداً كافياً عبر تعديل مباشر بقاعدة
/// الاختبار المعزولة، نفس نمط tests/db-integrity.spec.js بالضبط.
async function buildCompletedRequestWithRealCommission(request) {
  const { customer, technician, requestId } = await buildAcceptedRequest(request);

  const setupDb = openTestDb();
  try {
    setupDb.prepare('UPDATE users SET free_orders_used=2, balance=100 WHERE id=?').run(technician.user.id);
  } finally {
    setupDb.close();
  }

  const completeRes = await request.post(`/api/requests/${requestId}/status`, {
    headers: authHeader(customer.token),
    form: { status: 'مكتمل' },
  });
  expect(completeRes.ok()).toBeTruthy();
  const completeBody = await completeRes.json();
  expect(completeBody.request.commission_charged).toBe(2);

  return { customer, technician, requestId };
}

test.describe('[FEAT-REFUND-01] POST /admin/requests/:id/refund-commission', () => {
  test('استرداد ناجح: يضيف مبلغ العمولة بالضبط لرصيد الفني، يضبط commission_refunded_at، ويكتب قيد ledger مميّز ومرتبط بالطلب', async ({ request }) => {
    const { technician, requestId } = await buildCompletedRequestWithRealCommission(request);
    const adminToken = await loginAdmin(request);

    const beforeDb = openTestDb();
    let balanceBefore;
    try {
      balanceBefore = beforeDb.prepare('SELECT balance FROM users WHERE id=?').get(technician.user.id).balance;
    } finally {
      beforeDb.close();
    }
    expect(balanceBefore).toBe(98); // 100 - 2 (عمولة الإكمال)

    const res = await request.post(`/api/admin/requests/${requestId}/refund-commission`, {
      headers: authHeader(adminToken),
      data: { reason: 'العميل أثبت أن الفني لم يُنجز العمل فعلياً' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.amount).toBe(2);
    expect(body.balance_after).toBe(100); // 98 + 2 استرداد كامل

    const db = openTestDb();
    try {
      const tech = db.prepare('SELECT balance FROM users WHERE id=?').get(technician.user.id);
      expect(tech.balance).toBe(100);

      const r = db.prepare('SELECT commission_charged, commission_refunded_at FROM requests WHERE id=?').get(requestId);
      expect(r.commission_charged).toBe(2); // السجل التاريخي يبقى بلا تعديل
      expect(r.commission_refunded_at).not.toBeNull();

      const ledgerRows = db.prepare("SELECT * FROM ledger WHERE user_id=? AND type='استرداد عمولة نزاع'").all(technician.user.id);
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0].amount).toBe(2);
      expect(ledgerRows[0].balance_after).toBe(100);
      expect(ledgerRows[0].request_id).toBe(requestId);
      expect(ledgerRows[0].note).toBe('العميل أثبت أن الفني لم يُنجز العمل فعلياً');

      // مميّز فعلياً عن التعديل اليدوي العام — لا يوجد أي قيد 'تعديل يدوي
      // من الإدارة' نتج عن هذا الاسترداد.
      const manualAdjustRows = db.prepare("SELECT * FROM ledger WHERE user_id=? AND type='تعديل يدوي من الإدارة'").all(technician.user.id);
      expect(manualAdjustRows).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test('استرداد ثانٍ لنفس الطلب: 400 REQUEST_ALREADY_REFUNDED، بلا أي أثر مالي إضافي', async ({ request }) => {
    const { technician, requestId } = await buildCompletedRequestWithRealCommission(request);
    const adminToken = await loginAdmin(request);

    const first = await request.post(`/api/admin/requests/${requestId}/refund-commission`, {
      headers: authHeader(adminToken),
      data: { reason: 'سبب استرداد أول صحيح' },
    });
    expect(first.status()).toBe(200);

    const second = await request.post(`/api/admin/requests/${requestId}/refund-commission`, {
      headers: authHeader(adminToken),
      data: { reason: 'محاولة استرداد ثانية' },
    });
    expect(second.status()).toBe(400);
    const body = await second.json();
    expect(body.code).toBe('REQUEST_ALREADY_REFUNDED');

    const db = openTestDb();
    try {
      const tech = db.prepare('SELECT balance FROM users WHERE id=?').get(technician.user.id);
      expect(tech.balance).toBe(100); // لم يتضاعف الاسترداد

      const ledgerRows = db.prepare("SELECT * FROM ledger WHERE user_id=? AND type='استرداد عمولة نزاع'").all(technician.user.id);
      expect(ledgerRows).toHaveLength(1); // قيد واحد فقط
    } finally {
      db.close();
    }
  });

  test('طلب بلا عمولة مخصومة أصلاً (لم يُكمَل بعد): 400 REQUEST_NO_COMMISSION_CHARGED', async ({ request }) => {
    const { requestId } = await buildAcceptedRequest(request);
    const adminToken = await loginAdmin(request);

    const res = await request.post(`/api/admin/requests/${requestId}/refund-commission`, {
      headers: authHeader(adminToken),
      data: { reason: 'محاولة استرداد بلا عمولة' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('REQUEST_NO_COMMISSION_CHARGED');
  });

  test('طلب مكتمل ضمن الفرصتين المجانيتين (commission_charged=0): 400 REQUEST_NO_COMMISSION_CHARGED', async ({ request }) => {
    const { customer, requestId } = await buildAcceptedRequest(request);
    const adminToken = await loginAdmin(request);

    const completeRes = await request.post(`/api/requests/${requestId}/status`, {
      headers: authHeader(customer.token),
      form: { status: 'مكتمل' },
    });
    const completeBody = await completeRes.json();
    expect(completeBody.request.commission_charged).toBe(0); // أول طلب مجاني

    const res = await request.post(`/api/admin/requests/${requestId}/refund-commission`, {
      headers: authHeader(adminToken),
      data: { reason: 'محاولة استرداد على طلب مجاني' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('REQUEST_NO_COMMISSION_CHARGED');
  });

  test('طلب بلا فني مُعيَّن بعد: 400 REQUEST_NO_TECHNICIAN', async ({ request }) => {
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل بلا فني للاسترداد', city: CITY });
    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      form: { service: SERVICE, city: CITY, area: 'القويسمة', description: 'طلب بلا فني لاختبار الاسترداد' },
    });
    const requestId = (await createRes.json()).request.id;
    const adminToken = await loginAdmin(request);

    const res = await request.post(`/api/admin/requests/${requestId}/refund-commission`, {
      headers: authHeader(adminToken),
      data: { reason: 'محاولة استرداد بلا فني' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('REQUEST_NO_TECHNICIAN');
  });

  test('سبب مفقود أو قصير جداً: 400، بلا أي تغيير على الرصيد', async ({ request }) => {
    const { technician, requestId } = await buildCompletedRequestWithRealCommission(request);
    const adminToken = await loginAdmin(request);

    const missing = await request.post(`/api/admin/requests/${requestId}/refund-commission`, {
      headers: authHeader(adminToken),
      data: {},
    });
    expect(missing.status()).toBe(400);

    const tooShort = await request.post(`/api/admin/requests/${requestId}/refund-commission`, {
      headers: authHeader(adminToken),
      data: { reason: 'قص' },
    });
    expect(tooShort.status()).toBe(400);

    const db = openTestDb();
    try {
      const tech = db.prepare('SELECT balance FROM users WHERE id=?').get(technician.user.id);
      expect(tech.balance).toBe(98); // لم يتغيّر — لا محاولة نجحت
    } finally {
      db.close();
    }
  });

  test('معرّف طلب غير موجود: 404', async ({ request }) => {
    const adminToken = await loginAdmin(request);
    const res = await request.post('/api/admin/requests/999999999/refund-commission', {
      headers: authHeader(adminToken),
      data: { reason: 'سبب صحيح لمعرّف غير موجود' },
    });
    expect(res.status()).toBe(404);
  });

  test('عميل أو فني (لا أدمن) يُرفَض بـ403', async ({ request }) => {
    const { customer, technician, requestId } = await buildCompletedRequestWithRealCommission(request);

    const asCustomer = await request.post(`/api/admin/requests/${requestId}/refund-commission`, {
      headers: authHeader(customer.token),
      data: { reason: 'محاولة استرداد من عميل' },
    });
    expect(asCustomer.status()).toBe(403);

    const asTechnician = await request.post(`/api/admin/requests/${requestId}/refund-commission`, {
      headers: authHeader(technician.token),
      data: { reason: 'محاولة استرداد من فني' },
    });
    expect(asTechnician.status()).toBe(403);
  });
});
