// tests/admin.spec.js
// يغطي أهم صلاحيات لوحة الأدمن: الإحصائيات، تفعيل/إيقاف المستخدمين، تعديل الرصيد يدوياً
// (مع تسجيله بدفتر الأستاذ)، حذف المستخدم بشروط، إدارة الخدمات والباقات، إلغاء طلب، وسجل التدقيق.

const path = require('path');
const Database = require('better-sqlite3');
const { test, expect } = require('@playwright/test');
const { getPendingOtp, TEST_DB_PATH, openTestDb } = require('./helpers/db');

// [H2/H3][PERF-03] messages.request_id (كل استعلامات الشات) و
// requests.customer_id ("طلباتي" للعميل) — يثبت أن الفهرسين موجودان فعلياً
// بقاعدة البيانات بعد migrate()، وليس فقط أن سطر CREATE INDEX موجود بالكود.
test.describe('[H2/H3] فهارس قاعدة البيانات الحرجة للأداء', () => {
  test('idx_messages_request موجود على messages(request_id)', () => {
    const db = openTestDb();
    try {
      const indexes = db.prepare('PRAGMA index_list(messages)').all().map((i) => i.name);
      expect(indexes).toContain('idx_messages_request');
      const cols = db.prepare('PRAGMA index_info(idx_messages_request)').all();
      expect(cols.map((c) => c.name)).toEqual(['request_id']);
    } finally {
      db.close();
    }
  });

  test('idx_requests_customer موجود على requests(customer_id)', () => {
    const db = openTestDb();
    try {
      const indexes = db.prepare('PRAGMA index_list(requests)').all().map((i) => i.name);
      expect(indexes).toContain('idx_requests_customer');
      const cols = db.prepare('PRAGMA index_info(idx_requests_customer)').all();
      expect(cols.map((c) => c.name)).toEqual(['customer_id']);
    } finally {
      db.close();
    }
  });
});

// [PERF-HARDEN-01] offers.request_id/technician_id يُستخدَمان بشرط WHERE عبر
// 13+ موقعاً مختلفاً (أبرزها فحص hasOffer بكل رسالة شات) بلا أي فهرس سابقاً.
test.describe('[PERF-HARDEN-01] فهارس إضافية على offers/ratings', () => {
  test('idx_offers_request موجود على offers(request_id)', () => {
    const db = openTestDb();
    try {
      const indexes = db.prepare('PRAGMA index_list(offers)').all().map((i) => i.name);
      expect(indexes).toContain('idx_offers_request');
    } finally {
      db.close();
    }
  });

  test('idx_offers_technician موجود على offers(technician_id)', () => {
    const db = openTestDb();
    try {
      const indexes = db.prepare('PRAGMA index_list(offers)').all().map((i) => i.name);
      expect(indexes).toContain('idx_offers_technician');
    } finally {
      db.close();
    }
  });

  test('idx_ratings_technician موجود على ratings(technician_id)', () => {
    const db = openTestDb();
    try {
      const indexes = db.prepare('PRAGMA index_list(ratings)').all().map((i) => i.name);
      expect(indexes).toContain('idx_ratings_technician');
    } finally {
      db.close();
    }
  });

  // [PERF-HARDEN-02] users.role يُستخدَم بشرط WHERE ببحث الفنيين وبمواقع
  // إرسال Push للأدمن — قِيس فعلياً أنه يحوّل خطة الاستعلام من فحص كامل
  // (SCAN) لبحث بالفهرس (SEARCH)، انظر تعليق config/migrate.js.
  test('idx_users_role موجود على users(role)', () => {
    const db = openTestDb();
    try {
      const indexes = db.prepare('PRAGMA index_list(users)').all().map((i) => i.name);
      expect(indexes).toContain('idx_users_role');
    } finally {
      db.close();
    }
  });

  // [PERF-HARDEN-02] support_messages.ticket_id — نفس مشكلة messages.request_id
  // (H2/H3 أعلاه) تماماً: بلا فهرس، كل فتح/رد على أي تذكرة دعم يفحص كامل
  // جدول رسائل الدعم عبر كل المستخدمين، لا رسائل تلك التذكرة فقط.
  test('idx_support_messages_ticket موجود على support_messages(ticket_id)', () => {
    const db = openTestDb();
    try {
      const indexes = db.prepare('PRAGMA index_list(support_messages)').all().map((i) => i.name);
      expect(indexes).toContain('idx_support_messages_ticket');
    } finally {
      db.close();
    }
  });

  // [PERF-HARDEN-01] journal_mode مضبوط فعلياً بقاعدة بيانات الاختبار (يُقرأ
  // من ملف القاعدة نفسه، يبقى محفوظاً عبر أي اتصال). synchronous بعكسه —
  // إعداد خاص بكل اتصال على حدة، فلا يُقرأ من اتصال جديد منفصل هنا كما فعل
  // اتصال السيرفر الحقيقي بـconfig/db.js؛ هذا الاختبار يثبت فقط أن الصيغة
  // نفسها (synchronous = NORMAL) صالحة وتُطبَّق بشكل صحيح على أي اتصال يضبطها،
  // وهي بالضبط السطر المُضاف بـconfig/db.js.
  test('journal_mode=WAL محفوظ بملف القاعدة، وsynchronous=NORMAL صيغة صالحة تُطبَّق فور ضبطها', () => {
    const db = openTestDb();
    try {
      const journalMode = db.pragma('journal_mode', { simple: true });
      expect(String(journalMode).toLowerCase()).toBe('wal');

      db.pragma('synchronous = NORMAL');
      const synchronous = db.pragma('synchronous', { simple: true });
      // SQLite يرجع synchronous كرقم: 0=OFF, 1=NORMAL, 2=FULL
      expect(synchronous).toBe(1);
    } finally {
      db.close();
    }
  });
});

// [PERF-HARDEN-01] يثبت أن السقف الوقائي الجديد على GET /admin/users (بلا
// أي معامل page/limit) فعّال حقاً على مستوى قاعدة البيانات، وليس فقط سطراً
// بالكود لا يُختبَر أبداً. يزرع 2001 صفاً مباشرة (أسرع من التسجيل الحقيقي
// عبر API لكل صف) ويتحقق أن الاستجابة الافتراضية محدودة بـ2000 بالضبط.
test.describe('[PERF-HARDEN-01] سقف وقائي على GET /admin/users بلا page/limit', () => {
  test('لا يرجع أكثر من 2000 مستخدم رغم وجود أكثر من ذلك بقاعدة البيانات', async ({ request }) => {
    const db = openTestDb();
    try {
      const insertUser = db.prepare(`INSERT INTO users(role,name,email,phone,password_hash,city,areas,services,is_active,created_at)
        VALUES ('technician', ?, ?, ?, 'x', 'عمان', 'القويسمة', 'كهربائي', 1, datetime('now'))`);
      const insertMany = db.transaction((n) => {
        for (let i = 0; i < n; i++) {
          insertUser.run(
            `فني اختبار السقف ${i}`,
            `perf-hardening-cap-${i}-${Date.now()}@example.com`,
            `07${String(90000000 + i).slice(0, 8)}`
          );
        }
      });
      insertMany(2001);
    } finally {
      db.close();
    }

    const adminToken = await loginAdmin(request);
    const res = await request.get('/api/admin/users', { headers: authHeader(adminToken) });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.users.length).toBeLessThanOrEqual(2000);
  });
});

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

test.describe.serial('لوحة الأدمن', () => {
  let adminToken;
  let customer;
  let technician;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });
    adminToken = await loginAdmin(request);
    customer = await registerAndVerify(request, 'customer', { name: 'عميل اختبار أدمن', city: CITY });
    technician = await registerAndVerify(request, 'technician', {
      name: 'فني اختبار أدمن', city: CITY, national_number: uniqueNationalNumber(), services: 'كهربائي', areas: 'القويسمة',
    });
    await request.dispose();
  });

  test('GET /admin/stats — يرفض غير الأدمن، وينجح للأدمن بالحقول المتوقعة', async ({ request }) => {
    const forbidden = await request.get('/api/admin/stats', { headers: authHeader(customer.token) });
    expect(forbidden.status()).toBe(403);

    const res = await request.get('/api/admin/stats', { headers: authHeader(adminToken) });
    expect(res.status()).toBe(200);
    const stats = (await res.json()).stats;
    expect(typeof stats.customers).toBe('number');
    expect(typeof stats.revenue).toBe('string'); // toFixed ترجع نصاً من السيرفر
    expect(Array.isArray(stats.topServices)).toBe(true);
  });

  // [PERF-02] createDbBackup أصبحت غير متزامنة (fs.promises بدل fs.*Sync) —
  // هذا الاختبار يثبت أن endpoint النسخ الاحتياطي اليدوي ما زال يعمل بنفس
  // الشكل تماماً (200 + اسم ملف) رغم التغيير الداخلي.
  test('POST /admin/backup — يرفض غير الأدمن، وينشئ نسخة احتياطية فعلية للأدمن', async ({ request }) => {
    const forbidden = await request.post('/api/admin/backup', { headers: authHeader(customer.token) });
    expect(forbidden.status()).toBe(403);

    const res = await request.post('/api/admin/backup', { headers: authHeader(adminToken) });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.file).toBe('string');
    expect(body.file.endsWith('.sqlite')).toBe(true);
  });

  // [SEC-FIX-C2] القاعدة تعمل بوضع WAL (journal_mode=WAL) — كتابة حديثة قد
  // تبقى بملف -wal فترة، ولا تُدمَج بالملف الرئيسي إلا عند checkpoint. لو كانت
  // آلية النسخ الاحتياطي عادت لنسخ بايتات خام (fs.copyFile) لملف .sqlite
  // الرئيسي فقط، هذا الاختبار كان سيفشل لأن المستخدم المسجَّل للتو هنا (كتابة
  // حية لم يُطلَب لها أي checkpoint) لن يظهر بالنسخة. db.backup() (Online
  // Backup API الأصلية بـSQLite) مصمَّمة خصيصاً لالتقاط WAL بأمان أثناء الكتابة.
  test('POST /admin/backup — النسخة الناتجة تتضمّن كتابات WAL حديثة لم تُدمَج بعد بالملف الرئيسي', async ({ request }) => {
    const fresh = await registerAndVerify(request, 'customer', { name: 'عميل نسخة احتياطية WAL', city: CITY });

    const res = await request.post('/api/admin/backup', { headers: authHeader(adminToken) });
    expect(res.status()).toBe(200);
    const body = await res.json();

    const backupPath = path.join(path.dirname(TEST_DB_PATH), 'backups', body.file);
    const backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      const row = backupDb.prepare('SELECT id, email FROM users WHERE email=?').get(fresh.email.toLowerCase());
      expect(row).toBeTruthy();
      expect(row.email).toBe(fresh.email.toLowerCase());
    } finally {
      backupDb.close();
    }
  });

  test('GET /admin/users — يرفض غير الأدمن، وينجح للأدمن', async ({ request }) => {
    const forbidden = await request.get('/api/admin/users', { headers: authHeader(customer.token) });
    expect(forbidden.status()).toBe(403);

    const res = await request.get('/api/admin/users', { headers: authHeader(adminToken) });
    expect(res.status()).toBe(200);
    expect((await res.json()).users.some((u) => u.email === technician.email)).toBe(true);
  });

  test('POST /admin/users/:id/toggle — إيقاف الفني يمنعه من الدخول لاحقاً', async ({ request }) => {
    const res = await request.post(`/api/admin/users/${technician.user.id}/toggle`, { headers: authHeader(adminToken) });
    expect(res.status()).toBe(200);

    const loginRes = await request.post('/api/auth/login', {
      form: { email: technician.email, password: VALID_PASSWORD },
    });
    expect(loginRes.status()).toBe(403);

    // إعادة التفعيل حتى لا تؤثر على بقية الاختبارات
    const reactivate = await request.post(`/api/admin/users/${technician.user.id}/toggle`, { headers: authHeader(adminToken) });
    expect(reactivate.status()).toBe(200);
    const loginAgain = await request.post('/api/auth/login', { form: { email: technician.email, password: VALID_PASSWORD } });
    expect(loginAgain.status()).toBe(200);
  });

  test('POST /admin/users/:id/toggle — الأدمن لا يقدر يوقف حسابه الخاص', async ({ request }) => {
    const meRes = await request.get('/api/me', { headers: authHeader(adminToken) });
    const adminId = (await meRes.json()).user.id;
    const res = await request.post(`/api/admin/users/${adminId}/toggle`, { headers: authHeader(adminToken) });
    expect(res.status()).toBe(400);
  });

  test('POST /admin/users/:id/profile — تعديل الاسم والمدينة', async ({ request }) => {
    const res = await request.post(`/api/admin/users/${technician.user.id}/profile`, {
      headers: authHeader(adminToken),
      form: { name: 'اسم معدَّل من الأدمن', city: 'إربد' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.user.name).toBe('اسم معدَّل من الأدمن');
    expect(body.user.city).toBe('إربد');
  });

  test('POST /admin/users/:id/balance — تعديل الرصيد يدوياً يُسجَّل بدفتر الأستاذ', async ({ request }) => {
    const missingReason = await request.post(`/api/admin/users/${technician.user.id}/balance`, {
      headers: authHeader(adminToken),
      form: { amount: '5' },
    });
    expect(missingReason.status()).toBe(400);

    const res = await request.post(`/api/admin/users/${technician.user.id}/balance`, {
      headers: authHeader(adminToken),
      form: { amount: '5', reason: 'تعويض عن خطأ فني بالنظام' },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).balance).toBe(5);

    const ledgerRes = await request.get('/api/ledger', {
      headers: authHeader(adminToken),
      params: { user_id: String(technician.user.id) },
    });
    const ledger = (await ledgerRes.json()).ledger;
    expect(ledger.some((l) => l.type === 'تعديل يدوي من الإدارة' && l.amount === 5)).toBe(true);
  });

  test('POST /admin/users/:id/balance — يرفض تعديلاً يجعل الرصيد سالباً', async ({ request }) => {
    const res = await request.post(`/api/admin/users/${technician.user.id}/balance`, {
      headers: authHeader(adminToken),
      form: { amount: '-100', reason: 'محاولة خصم أكبر من الرصيد المتاح' },
    });
    expect(res.status()).toBe(400);
  });

  test('DELETE /admin/users/:id — يُمنع حذف مستخدم برصيد أكبر من صفر', async ({ request }) => {
    const res = await request.delete(`/api/admin/users/${technician.user.id}`, { headers: authHeader(adminToken) });
    expect(res.status()).toBe(409);
  });

  test('DELETE /admin/users/:id — يُمنع حذف مستخدم عنده طلب نشط', async ({ request }) => {
    const freshCustomer = await registerAndVerify(request, 'customer', { name: 'عميل للحذف', city: CITY });
    await request.post('/api/requests', {
      headers: authHeader(freshCustomer.token),
      multipart: { service: 'كهربائي', city: CITY, area: 'القويسمة', description: 'طلب نشط يمنع حذف صاحبه' },
    });
    const res = await request.delete(`/api/admin/users/${freshCustomer.user.id}`, { headers: authHeader(adminToken) });
    expect(res.status()).toBe(409);
  });

  test('DELETE /admin/users/:id — ينجح لمستخدم بلا طلبات نشطة وبلا رصيد', async ({ request }) => {
    const disposableCustomer = await registerAndVerify(request, 'customer', { name: 'عميل قابل للحذف', city: CITY });
    const res = await request.delete(`/api/admin/users/${disposableCustomer.user.id}`, { headers: authHeader(adminToken) });
    expect(res.status()).toBe(200);
  });

  test('إدارة الخدمات: إضافة، رفض التكرار، ثم حذف', async ({ request }) => {
    const uniqueServiceName = `خدمة اختبار ${Date.now()}`;
    const createRes = await request.post('/api/admin/services', {
      headers: authHeader(adminToken),
      form: { name: uniqueServiceName, icon: '🔧' },
    });
    expect(createRes.status()).toBe(200);
    const serviceId = (await createRes.json()).service.id;

    const duplicateRes = await request.post('/api/admin/services', {
      headers: authHeader(adminToken),
      form: { name: uniqueServiceName, icon: '🔧' },
    });
    expect(duplicateRes.status()).toBe(409);

    const deleteRes = await request.delete(`/api/admin/services/${serviceId}`, { headers: authHeader(adminToken) });
    expect(deleteRes.status()).toBe(200);
  });

  test('إدارة الباقات: إضافة، تعديل، ثم حذف', async ({ request }) => {
    const createRes = await request.post('/api/admin/packages', {
      headers: authHeader(adminToken),
      form: { name: `باقة اختبار ${Date.now()}`, amount: '15', bonus: '1', commission_per_order: '2' },
    });
    expect(createRes.status()).toBe(200);
    const pkg = (await createRes.json()).package;

    const updateRes = await request.put(`/api/admin/packages/${pkg.id}`, {
      headers: authHeader(adminToken),
      form: { name: pkg.name, amount: '20', bonus: '2', commission_per_order: '3' },
    });
    expect(updateRes.status()).toBe(200);
    const updated = (await updateRes.json()).package;
    expect(updated.amount).toBe(20);
    // [FIX-PACKAGEACTIVE-01] is_active غير مُرسَل بهذا الطلب — يجب أن يبقى
    // كما كان (1 افتراضياً عند الإنشاء)، وليس أن يُصفَّر بصمت.
    expect(updated.is_active).toBe(1);

    const deleteRes = await request.delete(`/api/admin/packages/${pkg.id}`, { headers: authHeader(adminToken) });
    expect(deleteRes.status()).toBe(200);
  });

  test('PUT /admin/packages/:id — تعطيل باقة يخفيها من /meta العامة فوراً', async ({ request }) => {
    const createRes = await request.post('/api/admin/packages', {
      headers: authHeader(adminToken),
      form: { name: `باقة للتعطيل ${Date.now()}`, amount: '30', bonus: '3', commission_per_order: '2' },
    });
    const pkg = (await createRes.json()).package;

    const metaBefore = await request.get('/api/meta', { headers: authHeader(technician.token) });
    expect((await metaBefore.json()).packages.some((p) => p.id === pkg.id)).toBe(true);

    // [FIX-PACKAGEACTIVE-01] is_active يُرسَل كـboolean JSON فعلي (مثل Flutter
    // تماماً — Dio يُرسل Map كـJSON افتراضياً) لا كنص form عبر form-urlencoded؛
    // نص "false" سيُقيَّم truthy بجافاسكربت لو أُرسل بذاك الشكل.
    const disableRes = await request.put(`/api/admin/packages/${pkg.id}`, {
      headers: authHeader(adminToken),
      data: { name: pkg.name, amount: 30, bonus: 3, commission_per_order: 2, is_active: false },
    });
    expect(disableRes.status()).toBe(200);
    expect((await disableRes.json()).package.is_active).toBe(0);

    const metaAfter = await request.get('/api/meta', { headers: authHeader(technician.token) });
    expect((await metaAfter.json()).packages.some((p) => p.id === pkg.id)).toBe(false);

    await request.delete(`/api/admin/packages/${pkg.id}`, { headers: authHeader(adminToken) });
  });

  test('POST /admin/requests/:id/cancel — يتطلب سبباً، وينجح ويغلق الطلب', async ({ request }) => {
    const c = await registerAndVerify(request, 'customer', { name: 'عميل لإلغاء الطلب', city: CITY });
    const reqRes = await request.post('/api/requests', {
      headers: authHeader(c.token),
      multipart: { service: 'كهربائي', city: CITY, area: 'القويسمة', description: 'طلب سيتم إلغاؤه من الأدمن' },
    });
    const requestId = (await reqRes.json()).request.id;

    const noReason = await request.post(`/api/admin/requests/${requestId}/cancel`, { headers: authHeader(adminToken), form: {} });
    expect(noReason.status()).toBe(400);

    const res = await request.post(`/api/admin/requests/${requestId}/cancel`, {
      headers: authHeader(adminToken),
      form: { reason: 'العميل غير متجاوب على الاتصال' },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).request.status).toBe('ملغي');

    const again = await request.post(`/api/admin/requests/${requestId}/cancel`, {
      headers: authHeader(adminToken),
      form: { reason: 'محاولة إلغاء مرة ثانية' },
    });
    expect(again.status()).toBe(400);
  });

  test('GET /admin/audit-logs — يعكس العمليات الإدارية السابقة، ويدعم البحث', async ({ request }) => {
    const res = await request.get('/api/admin/audit-logs', { headers: authHeader(adminToken) });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.total).toBeGreaterThan(0);
    expect(body.logs.some((l) => l.action === 'تعديل رصيد يدوي')).toBe(true);

    const searchRes = await request.get('/api/admin/audit-logs', {
      headers: authHeader(adminToken),
      params: { search: 'رصيد' },
    });
    expect(searchRes.status()).toBe(200);
    expect((await searchRes.json()).logs.length).toBeGreaterThan(0);
  });

  test('GET /admin/audit-logs — يرفض غير الأدمن', async ({ request }) => {
    const res = await request.get('/api/admin/audit-logs', { headers: authHeader(customer.token) });
    expect(res.status()).toBe(403);
  });
});
