// tests/db-integrity.spec.js
// يغطي فجوات لم تكن مغطاة صراحة: أن migrate() آمن تماماً عند تشغيله أكثر من
// مرة (كما يحدث فعلياً بكل إعادة تشغيل/نشر بالإنتاج)، أن ملف backup الناتج
// صالح فعلاً للاستعادة (وليس فقط "موجود")، وأن معاملة قاعدة بيانات حقيقية
// (إكمال طلب برصيد غير كافٍ) تتراجع بالكامل ولا تترك أي أثر جزئي عند الفشل.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { test, expect } = require('@playwright/test');
const { getPendingOtp, openTestDb, TEST_DB_PATH } = require('./helpers/db');
const { migrate } = require('../config/migrate');

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

// migrate() يُستدعى فعلياً مرة واحدة بكل إقلاع سيرفر — لكن بالإنتاج هذا يعني
// عشرات المرات عبر عمر التطبيق (كل إعادة نشر/إعادة تشغيل). لم يوجد اختبار
// يثبت مباشرة أن التشغيل المتكرر آمن (لا يُضاعف بيانات seed، لا يرمي استثناءً
// بسبب "duplicate column").
test.describe('[DB] أمان تشغيل migrate() أكثر من مرة', () => {
  test('تشغيل migrate() مرتين على قاعدة جديدة: بلا استثناء، وبلا تضاعف بيانات seed', () => {
    const tmpPath = path.join(os.tmpdir(), `sallehly-migrate-idempotency-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    const db = new Database(tmpPath);
    try {
      expect(() => migrate(db)).not.toThrow();
      const servicesAfterFirst = db.prepare('SELECT COUNT(*) c FROM service_categories').get().c;
      const packagesAfterFirst = db.prepare('SELECT COUNT(*) c FROM packages').get().c;
      expect(servicesAfterFirst).toBeGreaterThan(0);
      expect(packagesAfterFirst).toBe(4);

      // التشغيل الثاني — يحاكي إعادة تشغيل/نشر لاحق على نفس قاعدة البيانات
      expect(() => migrate(db)).not.toThrow();
      const servicesAfterSecond = db.prepare('SELECT COUNT(*) c FROM service_categories').get().c;
      const packagesAfterSecond = db.prepare('SELECT COUNT(*) c FROM packages').get().c;
      expect(servicesAfterSecond).toBe(servicesAfterFirst);
      expect(packagesAfterSecond).toBe(4);

      // الجداول الجوهرية كلها موجودة بعد الترحيل
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
      for (const required of ['users', 'requests', 'offers', 'messages', 'ledger', 'ratings', 'support_tickets', 'support_messages', 'topups', 'complaints', 'audit_logs']) {
        expect(tables, `الجدول ${required} غير موجود بعد migrate()`).toContain(required);
      }
    } finally {
      db.close();
      fs.rmSync(tmpPath, { force: true });
      fs.rmSync(`${tmpPath}-wal`, { force: true });
      fs.rmSync(`${tmpPath}-shm`, { force: true });
    }
  });

  test('تشغيل migrate() ثالث مرة لا يُنشئ حساب أدمن مكرر', () => {
    const tmpPath = path.join(os.tmpdir(), `sallehly-migrate-admin-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    const db = new Database(tmpPath);
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      migrate(db);
      migrate(db);
      migrate(db);
      const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c;
      expect(admins).toBe(1);
    } finally {
      process.env.NODE_ENV = prevEnv;
      db.close();
      fs.rmSync(tmpPath, { force: true });
      fs.rmSync(`${tmpPath}-wal`, { force: true });
      fs.rmSync(`${tmpPath}-shm`, { force: true });
    }
  });
});

// tests/admin.spec.js يثبت أن POST /admin/backup ينشئ ملفاً فعلياً يتضمن
// كتابات WAL حديثة. هذا يذهب خطوة أبعد: يثبت أن الملف الناتج نفسه سليم بنيوياً
// (PRAGMA integrity_check) وقابل للفتح والاستعلام الكامل بشكل مستقل — أي أنه
// فعلاً "قابل للاستعادة" وليس مجرد نسخة بايتات قد تكون تالفة.
test.describe('[DB] صحة واستعادة النسخة الاحتياطية', () => {
  test('POST /admin/backup — الملف الناتج يجتاز PRAGMA integrity_check ويحتوي كل الجداول الجوهرية', async ({ request }) => {
    const adminRes = await request.post('/api/auth/login', { form: { email: 'admin-test@example.com', password: 'AdminTestPass123' } });
    const adminToken = (await adminRes.json()).token;

    const res = await request.post('/api/admin/backup', { headers: authHeader(adminToken) });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    const backupPath = path.join(path.dirname(TEST_DB_PATH), 'backups', body.file);
    expect(fs.existsSync(backupPath)).toBeTruthy();

    const backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      const integrity = backupDb.prepare('PRAGMA integrity_check').get();
      expect(integrity.integrity_check).toBe('ok');

      const liveDb = openTestDb();
      let liveUserCount;
      try { liveUserCount = liveDb.prepare('SELECT COUNT(*) c FROM users').get().c; } finally { liveDb.close(); }

      const backupUserCount = backupDb.prepare('SELECT COUNT(*) c FROM users').get().c;
      // النسخة أُخذت *بعد* كل بيانات الاختبار الحالية — يجب أن يطابق العدد فعلياً
      expect(backupUserCount).toBe(liveUserCount);

      // الاستعلام الكامل (JOIN حقيقي) يعمل على النسخة كأنها القاعدة الحية —
      // هذا هو الإثبات العملي لصلاحيتها للاستعادة الفعلية عند الحاجة.
      expect(() => backupDb.prepare(
        'SELECT r.id FROM requests r LEFT JOIN users u ON u.id = r.customer_id LIMIT 1'
      ).all()).not.toThrow();
    } finally {
      backupDb.close();
    }
  });
});

// إكمال طلب يُشغّل معاملة حقيقية (routes/requests.routes.js: doComplete) تضم
// 3 عمليات كتابة (تحديث رصيد/عداد الفني، إدراج بقيد دفتر الأستاذ، تحديث
// commission_charged بالطلب). لا يوجد اختبار يثبت أن فشل هذه المعاملة (رصيد
// غير كافٍ) يتراجع بالكامل ولا يترك أي أثر جزئي على أي من الجداول الثلاثة.
test.describe('[DB] تراجع كامل عند فشل معاملة إكمال الطلب', () => {
  test('إكمال طلب برصيد فني غير كافٍ (بعد استهلاك الفرصتين المجانيتين): فشل 400 بلا أي أثر جزئي بقاعدة البيانات', async ({ request }) => {
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل تراجع المعاملة', city: CITY });
    const technician = await registerAndVerify(request, 'technician', {
      name: 'فني تراجع المعاملة', city: CITY, national_number: uniqueNationalNumber(), services: SERVICE, areas: 'القويسمة',
    });

    // يحاكي فنياً استهلك فرصتيه المجانيتين مسبقاً (نمط مطابق لما تفعله
    // tests/offers.spec.js بالفعل — تعديل مباشر بقاعدة اختبار معزولة تماماً)
    const setupDb = openTestDb();
    try {
      setupDb.prepare('UPDATE users SET free_orders_used=2, balance=0 WHERE id=?').run(technician.user.id);
    } finally {
      setupDb.close();
    }

    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      form: { service: SERVICE, description: 'طلب لاختبار تراجع معاملة الإكمال', city: CITY, area: 'القويسمة' },
    });
    expect(createRes.ok()).toBeTruthy();
    const requestId = (await createRes.json()).request.id;

    const offerRes = await request.post(`/api/requests/${requestId}/offer`, {
      headers: authHeader(technician.token),
      form: { offer_price: '10', duration: '30 دقيقة' },
    });
    expect(offerRes.ok()).toBeTruthy();
    const offerId = (await offerRes.json()).offers[0].id;

    const decisionRes = await request.post(`/api/offers/${offerId}/decision`, {
      headers: authHeader(customer.token),
      form: { decision: 'accepted' },
    });
    expect(decisionRes.ok()).toBeTruthy();

    const completeRes = await request.post(`/api/requests/${requestId}/status`, {
      headers: authHeader(customer.token),
      form: { status: 'مكتمل' },
    });
    expect(completeRes.status()).toBe(400);
    const completeBody = await completeRes.json();
    expect(completeBody.error).toContain('رصيد الفني غير كافٍ');

    // التحقق من عدم وجود أي أثر جزئي — كل الحقول الثلاثة المتأثرة بالمعاملة
    const checkDb = openTestDb();
    try {
      const r = checkDb.prepare('SELECT status, commission_charged FROM requests WHERE id=?').get(requestId);
      expect(r.status).toBe('تم اختيار عرض'); // لم يتحول لـ"مكتمل"
      expect(r.commission_charged).toBeNull(); // لم يُسجَّل أي مبلغ عمولة

      const tech = checkDb.prepare('SELECT balance, completed_jobs, free_orders_used FROM users WHERE id=?').get(technician.user.id);
      expect(tech.balance).toBe(0); // لم يُخصَم شيء
      expect(tech.completed_jobs).toBe(0); // لم يُحتسَب كعمل مكتمل
      expect(tech.free_orders_used).toBe(2); // لم يزد رغم دخول الفرع المجاني بالكود

      const ledgerRows = checkDb.prepare('SELECT * FROM ledger WHERE user_id=?').all(technician.user.id);
      expect(ledgerRows).toHaveLength(0); // لا أي قيد دفتر أستاذ جزئي
    } finally {
      checkDb.close();
    }

    // الطلب يبقى قابلاً للإكمال فعلياً بعد شحن رصيد كافٍ — يثبت أن التراجع لم يُفسد أي حالة
    const rechargeDb = openTestDb();
    try {
      rechargeDb.prepare('UPDATE users SET balance=100 WHERE id=?').run(technician.user.id);
    } finally {
      rechargeDb.close();
    }
    const retryRes = await request.post(`/api/requests/${requestId}/status`, {
      headers: authHeader(customer.token),
      form: { status: 'مكتمل' },
    });
    expect(retryRes.ok()).toBeTruthy();
  });
});
