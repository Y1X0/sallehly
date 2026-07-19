// tests/authz-and-token-edge-cases.spec.js
// يغطي فجوات محددة غير مغطاة سابقاً رغم وجود المنطق بالكود: انتهاء صلاحية
// OTP فعلياً (وليس فقط رفض كود خاطئ)، توكن JWT منتهي/مُزوَّر/موقَّع بسر خاطئ،
// محاولة تصعيد صلاحية عبر /me/profile، وصلاحيات أدمن غير مُختبَرة على
// نقاط نهاية إدارة الخدمات/الباقات/إلغاء الطلب (كل الاختبارات الحالية لهذه
// النقاط تستخدم توكن أدمن فقط، بلا أي فحص رفض لغير الأدمن).

const jwt = require('jsonwebtoken');
const { test, expect } = require('@playwright/test');
const { getPendingOtp, openTestDb } = require('./helpers/db');

const JWT_SECRET = 'test_only_secret_not_for_real_use_1234567890'; // playwright.config.js

function uniqueEmail(tag) {
  return `test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}
function uniquePhone() {
  return `07${Math.floor(10000000 + Math.random() * 89999999)}`;
}

const VALID_PASSWORD = 'TestPass123';
const ADMIN_EMAIL = 'admin-test@example.com';
const ADMIN_PASSWORD = 'AdminTestPass123';

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

async function registerAndVerify(request, role = 'customer', extra = {}) {
  const email = uniqueEmail(role);
  const phone = uniquePhone();
  const registerRes = await request.post('/api/auth/register', {
    form: { role, email, phone, password: VALID_PASSWORD, name: 'مستخدم اختبار', city: 'عمان', ...extra },
  });
  if (!registerRes.ok()) throw new Error(`فشل التسجيل: ${registerRes.status()} ${await registerRes.text()}`);
  const otp = getPendingOtp(email);
  const res = await request.post('/api/auth/verify-otp', { form: { email, otp } });
  if (!res.ok()) throw new Error(`فشل verify-otp: ${res.status()} ${await res.text()}`);
  const body = await res.json();
  return { email, phone, token: body.token, user: body.user };
}

async function loginAdmin(request) {
  const res = await request.post('/api/auth/login', { form: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  if (!res.ok()) throw new Error(`فشل دخول الأدمن: ${res.status()} ${await res.text()}`);
  return (await res.json()).token;
}

test.describe('[OTP] انتهاء صلاحية الكود فعلياً (وليس فقط كود خاطئ)', () => {
  test('POST /auth/verify-otp — كود صحيح لكن منتهي الصلاحية يُرفض ولا يُنشئ الحساب', async ({ request }) => {
    const email = uniqueEmail('otp-expired');
    const phone = uniquePhone();
    const registerRes = await request.post('/api/auth/register', {
      form: { role: 'customer', email, phone, password: VALID_PASSWORD, name: 'مستخدم OTP منتهي', city: 'عمان' },
    });
    expect(registerRes.ok()).toBeTruthy();
    const otp = getPendingOtp(email);

    // اجعل الكود منتهي الصلاحية فعلياً بتعديل مباشر لقاعدة الاختبار (محاكاة مرور الوقت).
    const db = openTestDb();
    try {
      db.prepare('UPDATE pending_users SET otp_expires=? WHERE email=?').run(Date.now() - 1000, email);
    } finally {
      db.close();
    }

    const verifyRes = await request.post('/api/auth/verify-otp', { form: { email, otp } });
    expect(verifyRes.status()).toBe(400);
    const body = await verifyRes.json();
    expect(body.error).toContain('انتهت صلاحية الكود');

    // الحساب لم يُنشأ فعلياً
    const loginRes = await request.post('/api/auth/login', { form: { email, password: VALID_PASSWORD } });
    expect(loginRes.status()).toBe(401);
  });

  test('POST /auth/reset-password — كود صحيح لكن منتهي الصلاحية يُرفض ولا يغيّر كلمة السر', async ({ request }) => {
    const account = await registerAndVerify(request);
    const forgotRes = await request.post('/api/auth/forgot-password', { form: { email: account.email } });
    expect(forgotRes.ok()).toBeTruthy();
    const otp = getPendingOtp(account.email);

    const db = openTestDb();
    try {
      db.prepare('UPDATE pending_users SET otp_expires=? WHERE email=?').run(Date.now() - 1000, account.email);
    } finally {
      db.close();
    }

    const resetRes = await request.post('/api/auth/reset-password', {
      form: { email: account.email, otp, new_password: 'NewPassword999' },
    });
    expect(resetRes.status()).toBe(400);
    expect((await resetRes.json()).error).toContain('انتهت صلاحية الكود');

    const loginRes = await request.post('/api/auth/login', { form: { email: account.email, password: VALID_PASSWORD } });
    expect(loginRes.status()).toBe(200);
  });
});

test.describe('[JWT] حالات توكن حدّية غير مغطاة', () => {
  test('توكن JWT منتهي الصلاحية فعلياً (exp بالماضي) يُرفض بـ401', async ({ request }) => {
    const account = await registerAndVerify(request, 'customer', { name: 'مستخدم توكن منتهي' });
    const expiredToken = jwt.sign(
      { id: account.user.id, role: 'customer', name: account.user.name, tokenVersion: 0 },
      JWT_SECRET,
      { expiresIn: '-10s' } // موقَّع، لكن انتهت صلاحيته فوراً
    );
    const res = await request.get('/api/me', { headers: authHeader(expiredToken) });
    expect(res.status()).toBe(401);
  });

  test('توكن مُزوَّر (توقيع عشوائي غير صالح) يُرفض بـ401', async ({ request }) => {
    const res = await request.get('/api/me', { headers: authHeader('not.a.validjwt') });
    expect(res.status()).toBe(401);
  });

  test('توكن موقَّع بسر خاطئ (مختلف عن JWT_SECRET الفعلي) يُرفض بـ401', async ({ request }) => {
    const account = await registerAndVerify(request, 'customer', { name: 'مستخدم سر خاطئ' });
    const wrongSecretToken = jwt.sign(
      { id: account.user.id, role: 'customer', name: account.user.name, tokenVersion: 0 },
      'a-completely-different-secret-not-matching-server',
      { expiresIn: '7d' }
    );
    const res = await request.get('/api/me', { headers: authHeader(wrongSecretToken) });
    expect(res.status()).toBe(401);
  });

  test('توكن صالح البنية لمستخدم غير موجود إطلاقاً (id محذوف/وهمي) يُرفض بـ401', async ({ request }) => {
    const ghostToken = jwt.sign(
      { id: 999999999, role: 'customer', name: 'شبح', tokenVersion: 0 },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    const res = await request.get('/api/me', { headers: authHeader(ghostToken) });
    expect(res.status()).toBe(401);
  });
});

test.describe('[Role Escalation] محاولة تصعيد صلاحية عبر تعديل البروفايل', () => {
  test('إرسال role="admin" ضمن POST /me/profile لا يغيّر دور الحساب إطلاقاً', async ({ request }) => {
    const account = await registerAndVerify(request, 'customer', { name: 'عميل محاولة تصعيد' });
    const res = await request.post('/api/me/profile', {
      headers: authHeader(account.token),
      form: { name: 'عميل محاولة تصعيد', phone: account.phone, city: 'عمان', areas: '', role: 'admin', is_super_admin: '1' },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.user.role).toBe('customer');

    // تأكيد إضافي من قاعدة البيانات مباشرة — لا مجال لأي تسريب عبر مسار آخر
    const db = openTestDb();
    try {
      const row = db.prepare('SELECT role, is_super_admin FROM users WHERE id=?').get(account.user.id);
      expect(row.role).toBe('customer');
      expect(row.is_super_admin).toBe(0);
    } finally {
      db.close();
    }
  });
});

test.describe('[Admin-only] نقاط نهاية إدارة الخدمات/الباقات/إلغاء الطلب — رفض غير الأدمن', () => {
  let customerToken;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل بلا صلاحية إدارية' });
    customerToken = customer.token;
  });

  test('POST /admin/services — يرفض غير الأدمن بـ403', async ({ request }) => {
    const res = await request.post('/api/admin/services', {
      headers: authHeader(customerToken),
      form: { name: `خدمة محاولة غير مصرحة ${Date.now()}`, icon: '🔧' },
    });
    expect(res.status()).toBe(403);
  });

  test('DELETE /admin/services/:id — يرفض غير الأدمن بـ403', async ({ request }) => {
    const res = await request.delete('/api/admin/services/1', { headers: authHeader(customerToken) });
    expect(res.status()).toBe(403);
  });

  test('POST /admin/packages — يرفض غير الأدمن بـ403', async ({ request }) => {
    const res = await request.post('/api/admin/packages', {
      headers: authHeader(customerToken),
      form: { name: 'باقة محاولة غير مصرحة', amount: '10', bonus: '0', commission_per_order: '2' },
    });
    expect(res.status()).toBe(403);
  });

  test('PUT /admin/packages/:id — يرفض غير الأدمن بـ403', async ({ request }) => {
    const res = await request.put('/api/admin/packages/1', {
      headers: authHeader(customerToken),
      form: { name: 'باقة', amount: '10', bonus: '0', commission_per_order: '2' },
    });
    expect(res.status()).toBe(403);
  });

  test('DELETE /admin/packages/:id — يرفض غير الأدمن بـ403', async ({ request }) => {
    const res = await request.delete('/api/admin/packages/1', { headers: authHeader(customerToken) });
    expect(res.status()).toBe(403);
  });

  test('POST /admin/requests/:id/cancel — يرفض غير الأدمن بـ403', async ({ request }) => {
    const res = await request.post('/api/admin/requests/1/cancel', {
      headers: authHeader(customerToken),
      form: { reason: 'محاولة إلغاء غير مصرحة' },
    });
    expect(res.status()).toBe(403);
  });

  test('GET /admin/services — يرفض غير الأدمن بـ403', async ({ request }) => {
    const res = await request.get('/api/admin/services', { headers: authHeader(customerToken) });
    expect(res.status()).toBe(403);
  });
});

test.describe('[DB] فرض قيود FOREIGN KEY فعلياً (وليس افتراضاً فقط)', () => {
  test('إدراج طلب بـcustomer_id غير موجود إطلاقاً يفشل بخطأ قيد FOREIGN KEY', () => {
    const db = openTestDb();
    try {
      expect(() => {
        db.prepare(
          `INSERT INTO requests(customer_id,service,city,description,status) VALUES(?,?,?,?,?)`
        ).run(999999999, 'كهربائي', 'عمان', 'وصف اختبار قيد المفتاح الخارجي', 'بانتظار العروض');
      }).toThrow(/FOREIGN KEY/);
    } finally {
      db.close();
    }
  });

  test('إدراج عرض بـtechnician_id غير موجود إطلاقاً يفشل بخطأ قيد FOREIGN KEY', async ({ request }) => {
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل لفحص قيد المفتاح الخارجي' });
    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      form: { service: 'كهربائي', description: 'طلب مخصَّص لفحص قيد FOREIGN KEY على العروض', city: 'عمان', area: 'القويسمة' },
    });
    expect(createRes.ok()).toBeTruthy();
    const requestId = (await createRes.json()).request.id;

    const db = openTestDb();
    try {
      expect(() => {
        db.prepare(
          `INSERT INTO offers(request_id,technician_id,price,duration,status) VALUES(?,?,?,?,?)`
        ).run(requestId, 999999999, 10, '30 دقيقة', 'pending');
      }).toThrow(/FOREIGN KEY/);
    } finally {
      db.close();
    }
  });
});
