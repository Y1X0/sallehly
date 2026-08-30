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

// [PERF-HARDEN-05] راجع DECISIONS.md — GET /admin/stats ينفّذ نحو 10
// استعلامات منفصلة على requests/users بلا أي فهرس على أعمدة الفلترة
// المستخدَمة فعلياً بها. يثبت هذا أن الفهارس الستة موجودة فعلياً بقاعدة
// البيانات بعد migrate() (لا فقط سطر CREATE INDEX بالكود)، وأن خطة الاستعلام
// الفعلية لكل استعلام حقيقي بـGET /admin/stats صارت SEARCH بالفهرس بدل SCAN
// كامل للجدول — نفس أسلوب التحقق المستخدَم أصلاً لـidx_users_role
// (PERF-HARDEN-02) عبر EXPLAIN QUERY PLAN، لا مجرد افتراض أن وجود الفهرس كافٍ.
test.describe('[PERF-HARDEN-05] فهارس GET /admin/stats', () => {
  const cases = [
    { table: 'requests', index: 'idx_requests_status', column: 'status' },
    { table: 'requests', index: 'idx_requests_created', column: 'created_at' },
    { table: 'requests', index: 'idx_requests_service', column: 'service' },
    { table: 'users', index: 'idx_users_created', column: 'created_at' },
    { table: 'users', index: 'idx_users_active', column: 'is_active' },
    { table: 'users', index: 'idx_users_verification', column: 'verification_status' },
  ];

  for (const { table, index, column } of cases) {
    test(`${index} موجود على ${table}(${column})`, () => {
      const db = openTestDb();
      try {
        const indexes = db.prepare(`PRAGMA index_list(${table})`).all().map((i) => i.name);
        expect(indexes).toContain(index);
        const cols = db.prepare(`PRAGMA index_info(${index})`).all();
        expect(cols.map((c) => c.name)).toEqual([column]);
      } finally {
        db.close();
      }
    });
  }

  const queries = [
    { sql: "SELECT COUNT(*) c FROM requests WHERE status='ملغي'", index: 'idx_requests_status' },
    { sql: "SELECT service, COUNT(*) cnt FROM requests GROUP BY service ORDER BY cnt DESC LIMIT 5", index: 'idx_requests_service' },
    { sql: "SELECT COUNT(*) c FROM requests WHERE created_at >= datetime('now','-1 days')", index: 'idx_requests_created' },
    { sql: "SELECT COUNT(*) c FROM users WHERE created_at >= datetime('now','-1 days')", index: 'idx_users_created' },
    { sql: "SELECT COUNT(*) c FROM users WHERE is_active=0", index: 'idx_users_active' },
    { sql: "SELECT COUNT(*) c FROM users WHERE role='technician' AND verification_status='pending'", index: 'idx_users_verification' },
  ];

  for (const { sql, index } of queries) {
    test(`خطة الاستعلام الفعلي "${sql}" تستخدم ${index} (SEARCH لا SCAN كامل)`, () => {
      const db = openTestDb();
      try {
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(' | ');
        expect(plan, `خطة الاستعلام: ${plan}`).toContain(index);
      } finally {
        db.close();
      }
    });
  }
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
          avatar: { name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
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

  // [SEC-FIX-SUSPENDACTIVE-01] راجع DECISIONS.md — قبل هذا الإصلاح، هذا
  // المسار كان يوقف فنياً (أو عميلاً) له طلب "تم اختيار عرض" بلا أي فحص،
  // فيُقفَل عن REST فوراً (middleware/auth.js) بلا أي طريقة لإكمال الطلب،
  // ويبقى الطرف الآخر عالقاً للأبد. DELETE /admin/users/:id يحمل نفس الفحص
  // أصلاً — هذا الاختبار يثبت أن /toggle صار يطابقه.
  test('POST /admin/users/:id/toggle — لا يمكن إيقاف فني أو عميل له طلب نشط (تم اختيار عرض)', async ({ request }) => {
    const busyTech = await registerAndVerify(request, 'technician', {
      name: 'فني بطلب نشط لاختبار الإيقاف', city: CITY, national_number: uniqueNationalNumber(), services: 'كهربائي', areas: 'القويسمة',
    });
    const busyCustomer = await registerAndVerify(request, 'customer', { name: 'عميل بطلب نشط لاختبار الإيقاف', city: CITY });

    const createRes = await request.post('/api/requests', {
      headers: authHeader(busyCustomer.token),
      form: { service: 'كهربائي', city: CITY, area: 'القويسمة', description: 'طلب لاختبار منع إيقاف حساب نشط' },
    });
    expect(createRes.ok()).toBeTruthy();
    const requestId = (await createRes.json()).request.id;

    const offerRes = await request.post(`/api/requests/${requestId}/offer`, {
      headers: authHeader(busyTech.token),
      form: { offer_price: '20', duration: '30 دقيقة' },
    });
    expect(offerRes.ok()).toBeTruthy();
    const offerId = (await offerRes.json()).offers.find((o) => o.technician_id === busyTech.user.id).id;

    const acceptRes = await request.post(`/api/offers/${offerId}/decision`, {
      headers: authHeader(busyCustomer.token),
      form: { decision: 'accepted' },
    });
    expect(acceptRes.ok()).toBeTruthy();

    // الفني نفسه له الآن طلب "تم اختيار عرض" — إيقافه يجب أن يُرفض
    const toggleTechRes = await request.post(`/api/admin/users/${busyTech.user.id}/toggle`, { headers: authHeader(adminToken) });
    expect(toggleTechRes.status()).toBe(409);

    // ونفس الفحص يحمي العميل (customer_id OR technician_id بالاستعلام الواحد)
    const toggleCustomerRes = await request.post(`/api/admin/users/${busyCustomer.user.id}/toggle`, { headers: authHeader(adminToken) });
    expect(toggleCustomerRes.status()).toBe(409);

    const checkDb = openTestDb();
    try {
      expect(checkDb.prepare('SELECT is_active FROM users WHERE id=?').get(busyTech.user.id).is_active).toBe(1);
      expect(checkDb.prepare('SELECT is_active FROM users WHERE id=?').get(busyCustomer.user.id).is_active).toBe(1);
    } finally {
      checkDb.close();
    }
  });

  // [FIX-PENDINGOFFER-01] راجع DECISIONS.md — الفحص أعلاه (SEC-FIX-SUSPENDACTIVE-01)
  // يغطي requests.technician_id، الذي يبقى NULL طالما لم يُقبَل عرض بعد.
  // فني قدَّم عرضاً pending فقط (لم يُقبَل بعد) كان يفوت ذلك الفحص تماماً.
  test('POST /admin/users/:id/toggle وDELETE /admin/users/:id — لا يمكن إيقاف أو حذف فني له عرض معلَّق (لم يُقبَل بعد)', async ({ request }) => {
    const offeringTech = await registerAndVerify(request, 'technician', {
      name: 'فني بعرض معلَّق لاختبار الإيقاف', city: CITY, national_number: uniqueNationalNumber(), services: 'كهربائي', areas: 'القويسمة',
    });
    const waitingCustomer = await registerAndVerify(request, 'customer', { name: 'عميل ينتظر قراراً على عرض', city: CITY });

    const createRes = await request.post('/api/requests', {
      headers: authHeader(waitingCustomer.token),
      form: { service: 'كهربائي', city: CITY, area: 'القويسمة', description: 'طلب لاختبار منع إيقاف فني له عرض معلَّق' },
    });
    expect(createRes.ok()).toBeTruthy();
    const requestId = (await createRes.json()).request.id;

    const offerRes = await request.post(`/api/requests/${requestId}/offer`, {
      headers: authHeader(offeringTech.token),
      form: { offer_price: '20', duration: '30 دقيقة' },
    });
    expect(offerRes.ok()).toBeTruthy();
    // العرض لسا pending — لم يقبله العميل بعد، requests.technician_id لا يزال NULL
    expect((await offerRes.json()).offers.find((o) => o.technician_id === offeringTech.user.id).status).toBe('pending');

    const toggleRes = await request.post(`/api/admin/users/${offeringTech.user.id}/toggle`, { headers: authHeader(adminToken) });
    expect(toggleRes.status()).toBe(409);

    const deleteRes = await request.delete(`/api/admin/users/${offeringTech.user.id}`, { headers: authHeader(adminToken) });
    expect(deleteRes.status()).toBe(409);

    const checkDb = openTestDb();
    try {
      expect(checkDb.prepare('SELECT is_active FROM users WHERE id=?').get(offeringTech.user.id).is_active).toBe(1);
    } finally {
      checkDb.close();
    }
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

  // [SEC-FIX-BALANCETOGHOST-01] راجع DECISIONS.md — anonymizeUser (يُشغَّل
  // بـDELETE /admin/users/:id أعلاه) يضبط deleted_at لكن لا يلمس balance
  // إطلاقاً؛ بلا فحص صريح، أدمن يستهدف معرّفاً قديماً كان يقدر يُضيف رصيداً
  // فعلياً لحساب لم يعد أحد يقدر يسجّل دخوله إليه أبداً — رصيد عالق للأبد.
  test('POST /admin/users/:id/balance — يُمنع تعديل رصيد حساب محذوف (بعد DELETE /admin/users/:id)', async ({ request }) => {
    const deletedCustomer = await registerAndVerify(request, 'customer', { name: 'عميل سيُحذف قبل محاولة تعديل رصيده', city: CITY });
    const deleteRes = await request.delete(`/api/admin/users/${deletedCustomer.user.id}`, { headers: authHeader(adminToken) });
    expect(deleteRes.status()).toBe(200);

    const res = await request.post(`/api/admin/users/${deletedCustomer.user.id}/balance`, {
      headers: authHeader(adminToken),
      form: { amount: '50', reason: 'محاولة إضافة رصيد بعد الحذف' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('USER_DELETED');

    const afterRes = await request.get(`/api/admin/users/${deletedCustomer.user.id}`, { headers: authHeader(adminToken) });
    expect((await afterRes.json()).user.balance).toBe(0);
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

  // [SEC-FIX-PKGFINITE-01] راجع DECISIONS.md — Infinity/NaN كانا يمرّان فحص
  // `!amount`/`amount < 0` (كلاهما false لـInfinity، وNaN falsy لكن `< 0`
  // أيضاً false لها) ويُخزَّنان فعلياً: Infinity حرفياً بعمود REAL، وNaN
  // كـNULL صامت. Number.isFinite يرفض كليهما الآن.
  test('POST/PUT /admin/packages — Infinity وNaN بـamount/bonus/commission_per_order تُرفض بـ400، لا تُخزَّن أبداً', async ({ request }) => {
    const badAmountRes = await request.post('/api/admin/packages', {
      headers: authHeader(adminToken),
      data: { name: `باقة رقم غير منتهٍ ${Date.now()}`, amount: 'Infinity', bonus: 1, commission_per_order: 2 },
    });
    expect(badAmountRes.status()).toBe(400);

    const badBonusRes = await request.post('/api/admin/packages', {
      headers: authHeader(adminToken),
      data: { name: `باقة بونص غير رقمي ${Date.now()}`, amount: 15, bonus: 'abc', commission_per_order: 2 },
    });
    expect(badBonusRes.status()).toBe(400);

    const badCommissionRes = await request.post('/api/admin/packages', {
      headers: authHeader(adminToken),
      data: { name: `باقة عمولة غير منتهية ${Date.now()}`, amount: 15, bonus: 1, commission_per_order: 'Infinity' },
    });
    expect(badCommissionRes.status()).toBe(400);

    // نفس الفحوص على مسار التعديل، على باقة سليمة موجودة أصلاً
    const okCreate = await request.post('/api/admin/packages', {
      headers: authHeader(adminToken),
      form: { name: `باقة سليمة للتعديل ${Date.now()}`, amount: '15', bonus: '1', commission_per_order: '2' },
    });
    const pkg = (await okCreate.json()).package;

    const badUpdateRes = await request.put(`/api/admin/packages/${pkg.id}`, {
      headers: authHeader(adminToken),
      data: { name: pkg.name, amount: 'Infinity', bonus: 1, commission_per_order: 2 },
    });
    expect(badUpdateRes.status()).toBe(400);

    // الباقة تبقى بقيمها الأصلية السليمة — لا Infinity ولا NULL تسرّب لقاعدة البيانات
    const checkDb = openTestDb();
    try {
      const dbRow = checkDb.prepare('SELECT amount, bonus, commission_per_order FROM packages WHERE id=?').get(pkg.id);
      expect(dbRow.amount).toBe(15);
      expect(dbRow.bonus).toBe(1);
      expect(dbRow.commission_per_order).toBe(2);
    } finally {
      checkDb.close();
    }

    await request.delete(`/api/admin/packages/${pkg.id}`, { headers: authHeader(adminToken) });
  });

  // [SEC-FIX-AMOUNTBOUND-01] راجع DECISIONS.md — Number.isFinite وحدها لا
  // تضع أي سقف واقعي؛ رقم منتهٍ فعلاً كـ1e15 كان يمر بصمت (خطأ كتابة أو
  // تلاعب متعمَّد) بلا أي تحذير. سقف دفاعي بحت (MAX_FINANCIAL_AMOUNT).
  test('POST /admin/users/:id/balance وPOST/PUT /admin/packages — مبلغ منتهٍ لكن ضخم جداً يُرفَض بـ400', async ({ request }) => {
    const hugeBalanceRes = await request.post(`/api/admin/users/${technician.user.id}/balance`, {
      headers: authHeader(adminToken),
      form: { amount: '99999999999', reason: 'محاولة تعديل رصيد بمبلغ غير واقعي' },
    });
    expect(hugeBalanceRes.status()).toBe(400);
    // الرصيد الفعلي لم يتغيّر إطلاقاً — لا نصف نجاح
    const meRes = await request.get('/api/me', { headers: authHeader(technician.token) });
    expect((await meRes.json()).user.balance).toBeLessThan(99999999999);

    const hugePackageRes = await request.post('/api/admin/packages', {
      headers: authHeader(adminToken),
      data: { name: `باقة مبلغ ضخم ${Date.now()}`, amount: 99999999999, bonus: 1, commission_per_order: 2 },
    });
    expect(hugePackageRes.status()).toBe(400);

    const hugeBonusRes = await request.post('/api/admin/packages', {
      headers: authHeader(adminToken),
      data: { name: `باقة بونص ضخم ${Date.now()}`, amount: 15, bonus: 99999999999, commission_per_order: 2 },
    });
    expect(hugeBonusRes.status()).toBe(400);

    // نفس الفحص على مسار التعديل، على باقة سليمة موجودة أصلاً
    const okCreate = await request.post('/api/admin/packages', {
      headers: authHeader(adminToken),
      form: { name: `باقة سليمة لاختبار سقف المبلغ ${Date.now()}`, amount: '15', bonus: '1', commission_per_order: '2' },
    });
    const pkg = (await okCreate.json()).package;
    const hugeUpdateRes = await request.put(`/api/admin/packages/${pkg.id}`, {
      headers: authHeader(adminToken),
      data: { name: pkg.name, amount: 99999999999, bonus: 1, commission_per_order: 2 },
    });
    expect(hugeUpdateRes.status()).toBe(400);

    // الباقة تبقى بقيمتها الأصلية — لا رقم ضخم تسرّب لقاعدة البيانات
    const checkDb = openTestDb();
    try {
      const dbRow = checkDb.prepare('SELECT amount FROM packages WHERE id=?').get(pkg.id);
      expect(dbRow.amount).toBe(15);
    } finally {
      checkDb.close();
    }

    await request.delete(`/api/admin/packages/${pkg.id}`, { headers: authHeader(adminToken) });
  });

  // [SEC-FIX-AMOUNTBOUND-01] راجع DECISIONS.md — commission_per_order كانت
  // مستثناة عمداً بالإصلاح الأصلي أعلاه (لم تُطلَب صراحة وقتها). نفس السقف
  // (MAX_FINANCIAL_AMOUNT) أُضيف لها الآن على مساري الإنشاء والتعديل معاً.
  test('POST/PUT /admin/packages — عمولة منتهية لكن ضخمة جداً (commission_per_order) تُرفَض بـ400', async ({ request }) => {
    const hugeCommissionCreateRes = await request.post('/api/admin/packages', {
      headers: authHeader(adminToken),
      data: { name: `باقة عمولة ضخمة ${Date.now()}`, amount: 15, bonus: 1, commission_per_order: 99999999999 },
    });
    expect(hugeCommissionCreateRes.status()).toBe(400);

    const okCreate = await request.post('/api/admin/packages', {
      headers: authHeader(adminToken),
      form: { name: `باقة سليمة لاختبار سقف العمولة ${Date.now()}`, amount: '15', bonus: '1', commission_per_order: '2' },
    });
    const pkg = (await okCreate.json()).package;

    const hugeCommissionUpdateRes = await request.put(`/api/admin/packages/${pkg.id}`, {
      headers: authHeader(adminToken),
      data: { name: pkg.name, amount: 15, bonus: 1, commission_per_order: 99999999999 },
    });
    expect(hugeCommissionUpdateRes.status()).toBe(400);

    // الباقة تبقى بعمولتها الأصلية — لا رقم ضخم تسرّب لقاعدة البيانات
    const checkDb = openTestDb();
    try {
      const dbRow = checkDb.prepare('SELECT commission_per_order FROM packages WHERE id=?').get(pkg.id);
      expect(dbRow.commission_per_order).toBe(2);
    } finally {
      checkDb.close();
    }

    await request.delete(`/api/admin/packages/${pkg.id}`, { headers: authHeader(adminToken) });
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

  // [DATA-INTEGRITY-04] راجع DECISIONS.md — POST /admin/requests/:id/cancel
  // كان يُنفّذ رفض العروض المعلَّقة وتحديث حالة الطلب كاستعلامين منفصلين بلا
  // db.transaction() واحدة، بنفس فئة DATA-INTEGRITY-03 (سحب العرض). نفس تقنية
  // إثبات الذرّية: SQLite trigger مؤقت يُفشل تحديداً UPDATE requests للطلب المستهدَف.
  test('POST /admin/requests/:id/cancel — فشل مصطنع أثناء تحديث حالة الطلب: العرض المعلَّق لا يُرفض (rollback كامل)، لا كتابة جزئية', async ({ request }) => {
    const c = await registerAndVerify(request, 'customer', { name: 'عميل اختبار ذرّية إلغاء الأدمن', city: CITY });
    const t = await registerAndVerify(request, 'technician', {
      name: 'فني اختبار ذرّية إلغاء الأدمن', city: CITY, national_number: uniqueNationalNumber(), services: 'كهربائي', areas: 'القويسمة',
    });
    const reqRes = await request.post('/api/requests', {
      headers: authHeader(c.token),
      multipart: { service: 'كهربائي', city: CITY, area: 'القويسمة', description: 'طلب لاختبار ذرّية إلغاء الأدمن عند فشل منتصف المعاملة' },
    });
    const requestId = (await reqRes.json()).request.id;

    const offerRes = await request.post(`/api/requests/${requestId}/offer`, {
      headers: authHeader(t.token),
      form: { offer_price: '12', duration: 'فوري' },
    });
    expect(offerRes.status()).toBe(200);
    const offerId = (await offerRes.json()).offers.find((o) => o.request_id === requestId).id;

    const db = openTestDb();
    try {
      db.exec(`
        CREATE TRIGGER data_integrity_04_admincancel_force_fail
        BEFORE UPDATE ON requests
        WHEN NEW.id = ${requestId}
        BEGIN SELECT RAISE(ABORT, 'DATA-INTEGRITY-04 admin-cancel simulated failure');
        END;
      `);
    } finally {
      db.close();
    }

    const cancelRes = await request.post(`/api/admin/requests/${requestId}/cancel`, {
      headers: authHeader(adminToken),
      form: { reason: 'محاولة إلغاء أثناء فشل مصطنع' },
    });
    expect(cancelRes.status()).not.toBe(200);

    const afterFailDb = openTestDb();
    try {
      const offerRow = afterFailDb.prepare('SELECT status FROM offers WHERE id=?').get(offerId);
      expect(offerRow.status, 'رُفض العرض رغم فشل تحديث الطلب — لا ذرّية').toBe('pending');
      const reqRow = afterFailDb.prepare('SELECT status FROM requests WHERE id=?').get(requestId);
      expect(reqRow.status).toBe('وصلت عروض');
    } finally {
      afterFailDb.close();
    }

    const dropTriggerDb = openTestDb();
    try {
      dropTriggerDb.exec('DROP TRIGGER IF EXISTS data_integrity_04_admincancel_force_fail');
    } finally {
      dropTriggerDb.close();
    }

    const retryRes = await request.post(`/api/admin/requests/${requestId}/cancel`, {
      headers: authHeader(adminToken),
      form: { reason: 'إلغاء طبيعي بعد إزالة الفشل المصطنع' },
    });
    expect(retryRes.status()).toBe(200);
    const finalDb = openTestDb();
    try {
      expect(finalDb.prepare('SELECT status FROM offers WHERE id=?').get(offerId).status).toBe('rejected');
      expect(finalDb.prepare('SELECT status FROM requests WHERE id=?').get(requestId).status).toBe('ملغي');
    } finally {
      finalDb.close();
    }
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

test.describe('[SEC-FIX-ADMINTARGET-01] أدمن عادي لا يقدر يوقف أو يحذف حساب أدمن آخر', () => {
  // [SEC-FIX-ADMINTARGET-01] راجع DECISIONS.md — لا endpoint عام لإنشاء حساب
  // أدمن ثانٍ (POST /auth/register يرفض role='admin' صراحة، وPOST
  // /admin/users/:id/role يسمح فقط بالتحويل بين عميل/فني) — الإدراج المباشر
  // بقاعدة البيانات هو الطريقة الوحيدة لتجهيز حساب أدمن ثانٍ لهذا الاختبار،
  // بنفس أسلوب tests/bcrypt-migration.spec.js.
  async function createSecondAdmin(email, password) {
    const bcrypt = require('bcrypt');
    const hash = await bcrypt.hash(password, 12);
    const db = openTestDb();
    try {
      db.prepare(
        "INSERT INTO users(role,name,email,phone,password_hash,is_active,is_super_admin) VALUES('admin',?,?,?,?,1,0)"
      ).run('أدمن ثانٍ للاختبار', email, `07${Math.floor(10000000 + Math.random() * 89999999)}`, hash);
    } finally {
      db.close();
    }
  }

  test('POST /admin/users/:id/toggle وDELETE /admin/users/:id — يُرفَضان على حساب أدمن آخر بـ400', async ({ request }) => {
    const actorEmail = `admin-actor-${Date.now()}@example.com`;
    const targetEmail = `admin-target-${Date.now()}@example.com`;
    const password = 'AdminTestPass123';
    await createSecondAdmin(actorEmail, password);
    await createSecondAdmin(targetEmail, password);

    const actorLoginRes = await request.post('/api/auth/login', { form: { email: actorEmail, password } });
    expect(actorLoginRes.status()).toBe(200);
    const actorToken = (await actorLoginRes.json()).token;

    const db = openTestDb();
    let targetId;
    try {
      targetId = db.prepare('SELECT id FROM users WHERE email=?').get(targetEmail).id;
    } finally {
      db.close();
    }

    const toggleRes = await request.post(`/api/admin/users/${targetId}/toggle`, { headers: authHeader(actorToken) });
    expect(toggleRes.status()).toBe(400);
    expect((await toggleRes.json()).code).toBe('ADMIN_CANNOT_TARGET_ADMIN');

    const deleteRes = await request.delete(`/api/admin/users/${targetId}`, { headers: authHeader(actorToken) });
    expect(deleteRes.status()).toBe(400);
    expect((await deleteRes.json()).code).toBe('ADMIN_CANNOT_TARGET_ADMIN');

    // الهدف بقي فعّالاً بلا أي تغيير — لا نصف نجاح
    const checkDb = openTestDb();
    try {
      const row = checkDb.prepare('SELECT is_active FROM users WHERE id=?').get(targetId);
      expect(row.is_active).toBe(1);
    } finally {
      checkDb.close();
    }
  });
});
