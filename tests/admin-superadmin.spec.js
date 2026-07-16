// tests/admin-superadmin.spec.js
// يغطي القدرات الجديدة: super admin، الإيقاف بسبب، بروفايل مستخدم كامل،
// تحويل الأدوار (وحمايته)، توثيق الفني، إدارة المخالفات/البلاغات، دفتر
// الأستاذ الشامل، والإحصائيات الزمنية.

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

test.describe.serial('Super Admin وقدرات الأدمن الموسّعة', () => {
  let adminToken;
  let adminId;
  let customer;
  let technician;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });
    adminToken = await loginAdmin(request);
    const meRes = await request.get('/api/me', { headers: authHeader(adminToken) });
    adminId = (await meRes.json()).user.id;
    customer = await registerAndVerify(request, 'customer', { name: 'عميل اختبار سوبر أدمن', city: CITY });
    technician = await registerAndVerify(request, 'technician', {
      name: 'فني اختبار سوبر أدمن', city: CITY, national_number: uniqueNationalNumber(), services: 'كهربائي', areas: 'القويسمة',
    });
    await request.dispose();
  });

  test('GET /me — حساب الأدمن المُهيَّأ من .env هو super admin تلقائياً', async ({ request }) => {
    const res = await request.get('/api/me', { headers: authHeader(adminToken) });
    expect(res.status()).toBe(200);
    const user = (await res.json()).user;
    expect(user.is_super_admin).toBe(1);
  });

  test('فني جديد يبدأ verification_status=pending، والعميل/الأدمن verified فوراً', async ({ request }) => {
    const techMe = await request.get('/api/me', { headers: authHeader(technician.token) });
    expect((await techMe.json()).user.verification_status).toBe('pending');

    const adminMe = await request.get('/api/me', { headers: authHeader(adminToken) });
    expect((await adminMe.json()).user.verification_status).toBe('verified');
  });

  test('POST /admin/users/:id/verify — يوثّق الفني، ويرفض لغير الفنيين', async ({ request }) => {
    const res = await request.post(`/api/admin/users/${technician.user.id}/verify`, { headers: authHeader(adminToken) });
    expect(res.status()).toBe(200);
    const techMe = await request.get('/api/me', { headers: authHeader(technician.token) });
    expect((await techMe.json()).user.verification_status).toBe('verified');

    const onCustomer = await request.post(`/api/admin/users/${customer.user.id}/verify`, { headers: authHeader(adminToken) });
    expect(onCustomer.status()).toBe(400);
  });

  test('POST /admin/users/:id/toggle — إيقاف بسبب يُسجَّل ويُصفَّر عند إعادة التفعيل', async ({ request }) => {
    const suspendRes = await request.post(`/api/admin/users/${technician.user.id}/toggle`, {
      headers: authHeader(adminToken),
      form: { reason: 'مخالفات متكررة بالمحادثة' },
    });
    expect(suspendRes.status()).toBe(200);

    const detailAfterSuspend = await request.get(`/api/admin/users/${technician.user.id}`, { headers: authHeader(adminToken) });
    const suspendedUser = (await detailAfterSuspend.json()).user;
    expect(suspendedUser.is_active).toBe(0);
    expect(suspendedUser.suspension_reason).toBe('مخالفات متكررة بالمحادثة');
    expect(suspendedUser.suspended_at).toBeTruthy();
    expect(suspendedUser.suspended_by).toBe(adminId);

    // إعادة التفعيل — يُصفّر بيانات التوقيف تلقائياً.
    const restoreRes = await request.post(`/api/admin/users/${technician.user.id}/toggle`, { headers: authHeader(adminToken) });
    expect(restoreRes.status()).toBe(200);
    const detailAfterRestore = await request.get(`/api/admin/users/${technician.user.id}`, { headers: authHeader(adminToken) });
    const restoredUser = (await detailAfterRestore.json()).user;
    expect(restoredUser.is_active).toBe(1);
    expect(restoredUser.suspension_reason).toBeNull();
    expect(restoredUser.suspended_at).toBeNull();
    expect(restoredUser.suspended_by).toBeNull();
  });

  test('GET /admin/users/:id — يرفض غير الأدمن، وينجح بكل الأقسام المتوقعة', async ({ request }) => {
    const forbidden = await request.get(`/api/admin/users/${technician.user.id}`, { headers: authHeader(customer.token) });
    expect(forbidden.status()).toBe(403);

    const res = await request.get(`/api/admin/users/${technician.user.id}`, { headers: authHeader(adminToken) });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.user.id).toBe(technician.user.id);
    expect(Array.isArray(body.requestsAsTechnician)).toBe(true);
    expect(Array.isArray(body.offers)).toBe(true);
    expect(Array.isArray(body.ledger)).toBe(true);
    expect(typeof body.moderation.violationsCount).toBe('number');
  });

  test.describe.serial('تغيير الأدوار (super admin فقط)', () => {
    let plainCustomer;
    let plainTechnician;

    test.beforeAll(async ({ playwright }) => {
      const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });
      plainCustomer = await registerAndVerify(request, 'customer', { name: 'عميل لتحويل الدور', city: CITY });
      plainTechnician = await registerAndVerify(request, 'technician', {
        name: 'فني لتحويل الدور', city: CITY, national_number: uniqueNationalNumber(), services: 'سباك', areas: 'خلدا',
      });
      await request.dispose();
    });

    test('عادي admin (بدون is_super_admin) يُرفض بـ403', async ({ request }) => {
      const db = openTestDb();
      try {
        db.prepare('UPDATE users SET is_super_admin=0 WHERE id=?').run(adminId);
        const res = await request.post(`/api/admin/users/${plainCustomer.user.id}/role`, {
          headers: authHeader(adminToken),
          form: { role: 'technician', national_number: uniqueNationalNumber(), services: 'نجار', areas: 'عمان' },
        });
        expect(res.status()).toBe(403);
      } finally {
        db.prepare('UPDATE users SET is_super_admin=1 WHERE id=?').run(adminId);
        db.close();
      }
    });

    test('فني بلديه رصيد يُمنع تحويله لعميل', async ({ request }) => {
      await request.post(`/api/admin/users/${plainTechnician.user.id}/balance`, {
        headers: authHeader(adminToken),
        form: { amount: '5', reason: 'رصيد اختبار منع التحويل' },
      });
      const res = await request.post(`/api/admin/users/${plainTechnician.user.id}/role`, {
        headers: authHeader(adminToken),
        form: { role: 'customer' },
      });
      expect(res.status()).toBe(409);
      // صفّر الرصيد ثانية حتى لا يؤثر على اختبار التحويل الناجح لاحقاً.
      await request.post(`/api/admin/users/${plainTechnician.user.id}/balance`, {
        headers: authHeader(adminToken),
        form: { amount: '-5', reason: 'تصفير الرصيد بعد اختبار المنع' },
      });
    });

    test('عميل بدون صورة شخصية يُمنع تحويله لفني', async ({ request }) => {
      const res = await request.post(`/api/admin/users/${plainCustomer.user.id}/role`, {
        headers: authHeader(adminToken),
        form: { role: 'technician', national_number: uniqueNationalNumber(), services: 'نجار', areas: 'عمان' },
      });
      expect(res.status()).toBe(400);
      expect((await res.json()).error).toContain('صورة');
    });

    test('عميل عنده طلب نشط يُمنع تحويله لفني', async ({ request }) => {
      const activeReqCustomer = await registerAndVerify(request, 'customer', {
        name: 'عميل بطلب نشط', city: CITY,
        // نحتاج صورة شخصية لتفادي رفض "بلا صورة" — لكن التسجيل customer form لا يقبل ملف بسهولة هنا،
        // فالتحقق المطلوب هنا هو رفض التحويل بسبب الطلب النشط تحديداً، بصرف النظر عن سبب لاحق آخر محتمل.
      });
      await request.post('/api/requests', {
        headers: authHeader(activeReqCustomer.token),
        multipart: { service: 'كهربائي', city: CITY, area: 'القويسمة', description: 'طلب نشط يمنع تحويل صاحبه لفني' },
      });
      const res = await request.post(`/api/admin/users/${activeReqCustomer.user.id}/role`, {
        headers: authHeader(adminToken),
        form: { role: 'technician', national_number: uniqueNationalNumber(), services: 'نجار', areas: 'عمان' },
      });
      expect(res.status()).toBe(409);
      expect((await res.json()).error).toContain('طلب نشط');
    });

    test('تحويل فني (بلا تاريخ عمل) لعميل ينجح، ويُبطل التوكن القديم فوراً', async ({ request }) => {
      const res = await request.post(`/api/admin/users/${plainTechnician.user.id}/role`, {
        headers: authHeader(adminToken),
        form: { role: 'customer' },
      });
      expect(res.status()).toBe(200);
      expect((await res.json()).user.role).toBe('customer');

      // التوكن القديم (يحمل الدور القديم 'technician') يجب أن يُرفض الآن.
      const staleTokenRes = await request.get('/api/me', { headers: authHeader(plainTechnician.token) });
      expect(staleTokenRes.status()).toBe(401);

      // تسجيل دخول جديد يعكس الدور الصحيح.
      const loginRes = await request.post('/api/auth/login', {
        form: { email: plainTechnician.email, password: VALID_PASSWORD },
      });
      const freshUser = (await loginRes.json()).user;
      expect(freshUser.role).toBe('customer');
      expect(freshUser.national_number).toBeFalsy();
    });

    test('تحويل عميل لفني (مع الحقول المطلوبة) ينجح', async ({ request }) => {
      // ألصق صورة شخصية بالعميل أولاً (شرط التحويل لفني) عبر تعديل البروفايل.
      const profileRes = await request.post('/api/me/profile', {
        headers: authHeader(plainCustomer.token),
        multipart: {
          name: 'عميل لتحويل الدور', phone: plainCustomer.phone, city: CITY,
          avatar: { name: 'a.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
        },
      });
      expect(profileRes.status()).toBe(200);
      expect((await profileRes.json()).user.avatar_url).toBeTruthy();

      const nationalNumber = uniqueNationalNumber();
      const res = await request.post(`/api/admin/users/${plainCustomer.user.id}/role`, {
        headers: authHeader(adminToken),
        form: { role: 'technician', national_number: nationalNumber, services: 'دهان', areas: 'وسط البلد' },
      });
      expect(res.status()).toBe(200);
      const updated = (await res.json()).user;
      expect(updated.role).toBe('technician');

      const loginRes = await request.post('/api/auth/login', {
        form: { email: plainCustomer.email, password: VALID_PASSWORD },
      });
      const freshUser = (await loginRes.json()).user;
      expect(freshUser.role).toBe('technician');
      expect(freshUser.verification_status).toBe('verified');
    });

    test('لا يمكن تحويل حساب الأدمن نفسه، ولا لنفس الدور الحالي', async ({ request }) => {
      const selfRes = await request.post(`/api/admin/users/${adminId}/role`, {
        headers: authHeader(adminToken),
        form: { role: 'customer' },
      });
      expect(selfRes.status()).toBe(400);

      const sameRoleRes = await request.post(`/api/admin/users/${customer.user.id}/role`, {
        headers: authHeader(adminToken),
        form: { role: 'customer' },
      });
      expect(sameRoleRes.status()).toBe(400);
    });
  });

  test.describe.serial('إدارة المخالفات والبلاغات', () => {
    let acceptedRequest;
    let reportedTechnician;
    let reportingCustomer;

    test.beforeAll(async ({ playwright }) => {
      const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });
      reportingCustomer = await registerAndVerify(request, 'customer', { name: 'عميل بلاغات', city: CITY });
      reportedTechnician = await registerAndVerify(request, 'technician', {
        name: 'فني مبلَّغ عنه', city: CITY, national_number: uniqueNationalNumber(), services: 'كهربائي', areas: CITY,
      });
      const createRes = await request.post('/api/requests', {
        headers: authHeader(reportingCustomer.token),
        multipart: { service: 'كهربائي', city: CITY, area: CITY, description: 'وصف تجريبي كافٍ للطول لاختبار المخالفات' },
      });
      acceptedRequest = (await createRes.json()).request;
      await request.post(`/api/requests/${acceptedRequest.id}/offer`, {
        headers: authHeader(reportedTechnician.token),
        form: { offer_price: '10', duration: 'خلال ساعة' },
      });
      const offersRes = await request.get(`/api/requests/${acceptedRequest.id}/offers`, { headers: authHeader(reportingCustomer.token) });
      const offerId = (await offersRes.json()).offers[0].id;
      await request.post(`/api/offers/${offerId}/decision`, { headers: authHeader(reportingCustomer.token), form: { decision: 'accepted' } });
      // مخالفة: رسالة تحتوي رقم هاتف.
      await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
        headers: authHeader(reportingCustomer.token),
        form: { body: 'تواصل معي على 0791234567 مباشرة' },
      });
      await request.dispose();
    });

    test('POST /chat-violations/:id/status — يحدّث الحالة، ويرفض قيمة غير معروفة', async ({ request }) => {
      const listRes = await request.get('/api/chat-violations', { headers: authHeader(adminToken) });
      const violation = (await listRes.json()).violations.find((v) => v.request_id === acceptedRequest.id);
      expect(violation).toBeTruthy();
      expect(violation.status).toBe('مفتوح');

      const badStatus = await request.post(`/api/chat-violations/${violation.id}/status`, {
        headers: authHeader(adminToken),
        form: { status: 'حالة غير موجودة' },
      });
      expect(badStatus.status()).toBe(400);

      const res = await request.post(`/api/chat-violations/${violation.id}/status`, {
        headers: authHeader(adminToken),
        form: { status: 'تمت المراجعة' },
      });
      expect(res.status()).toBe(200);
      expect((await res.json()).violation.status).toBe('تمت المراجعة');
    });

    test('POST /message-reports/:id/status — يحدّث الحالة', async ({ request }) => {
      await request.post(`/api/requests/${acceptedRequest.id}/report-message`, {
        headers: authHeader(reportingCustomer.token),
        form: { reason: 'محتوى غير لائق' },
      });
      const listRes = await request.get('/api/message-reports', { headers: authHeader(adminToken) });
      const report = (await listRes.json()).reports.find((r) => r.request_id === acceptedRequest.id);
      expect(report).toBeTruthy();

      const res = await request.post(`/api/message-reports/${report.id}/status`, {
        headers: authHeader(adminToken),
        form: { status: 'تم اتخاذ إجراء' },
      });
      expect(res.status()).toBe(200);
      expect((await res.json()).report.status).toBe('تم اتخاذ إجراء');
    });
  });

  test('GET /admin/ledger — يرفض غير الأدمن، ويدعم الفلترة حسب user_id', async ({ request }) => {
    const forbidden = await request.get('/api/admin/ledger', { headers: authHeader(customer.token) });
    expect(forbidden.status()).toBe(403);

    const res = await request.get('/api/admin/ledger', { headers: authHeader(adminToken), params: { user_id: String(technician.user.id) } });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.every((e) => e.user_id === technician.user.id)).toBe(true);
  });

  test('GET /admin/stats — يتضمّن نشاط الفترات الزمنية والتوثيق/الإيقاف', async ({ request }) => {
    const res = await request.get('/api/admin/stats', { headers: authHeader(adminToken) });
    expect(res.status()).toBe(200);
    const stats = (await res.json()).stats;
    expect(stats.activity.daily).toBeTruthy();
    expect(stats.activity.weekly).toBeTruthy();
    expect(stats.activity.monthly).toBeTruthy();
    expect(typeof stats.activity.monthly.newRequests).toBe('number');
    expect(typeof stats.suspendedUsers).toBe('number');
    expect(typeof stats.pendingVerification).toBe('number');
  });
});
