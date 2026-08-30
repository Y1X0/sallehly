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

    // [FIX-WALLETDEDUCT-01] لا يوجد اختبار سابق يثبت مسار الخصم الفعلي الناجح
    // (فقط المسار المجاني، والمسار الفاشل برصيد غير كافٍ) — يثبت هذا أن
    // الرصيد يُخصم فعلياً بمقدار العمولة الصحيح فور نجاح الإكمال، والقيد
    // يُسجَّل بدفتر الأستاذ، وcommission_charged يُحفظ بنفس المبلغ بالطلب.
    const retryBody = await retryRes.json();
    expect(retryBody.request.status).toBe('مكتمل');
    expect(retryBody.request.commission_charged).toBe(2); // active_commission الافتراضية

    const verifyDb = openTestDb();
    try {
      const tech = verifyDb.prepare('SELECT balance, completed_jobs, free_orders_used FROM users WHERE id=?').get(technician.user.id);
      expect(tech.balance).toBe(98); // 100 - 2 (عمولة الطلب)
      expect(tech.completed_jobs).toBe(1);
      expect(tech.free_orders_used).toBe(2); // لم يزد — هذا المسار المدفوع

      const ledgerRows = verifyDb.prepare("SELECT * FROM ledger WHERE user_id=? AND type='خصم عمولة طلب'").all(technician.user.id);
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0].amount).toBe(-2);
      expect(ledgerRows[0].balance_after).toBe(98);
    } finally {
      verifyDb.close();
    }
  });
});

// [DATA-INTEGRITY-02] راجع DECISIONS.md وconfig/migrate.js
// (migrateTableAddForeignKeys). يحاكي هذا الاختبار الترحيل الحقيقي على قاعدة
// إنتاج قائمة فعلياً: قاعدة جديدة تُهاجَر أولاً بشكل طبيعي (كل الجداول الثمانية
// تحصل على FK مباشرة من CREATE TABLE)، ثم تُعاد كتابة الجداول يدوياً بالشكل
// القديم (بلا أي FOREIGN KEY، تماماً كحالة الإنتاج الحقيقية قبل هذا الإصلاح)
// مع بيانات حقيقية مُدرَجة، ثم يُعاد تشغيل migrate() مرة ثانية — يجب أن يضيف
// FK هذه المرة، وأن يحافظ على كل صف موجود مسبقاً بلا أي فقدان.
test.describe('[DATA-INTEGRITY-02] إضافة FOREIGN KEY للجداول الثمانية على قاعدة موجودة مسبقاً', () => {
  const OLD_SCHEMA = {
    messages: `CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL, sender_id INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    chat_violations: `CREATE TABLE chat_violations(id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL, user_id INTEGER NOT NULL, body TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, status TEXT NOT NULL DEFAULT 'مفتوح')`,
    chat_reads: `CREATE TABLE chat_reads(request_id INTEGER NOT NULL, user_id INTEGER NOT NULL, last_read_message_id INTEGER DEFAULT 0, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(request_id,user_id))`,
    message_reports: `CREATE TABLE message_reports(id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL, message_id INTEGER, reporter_id INTEGER NOT NULL, reported_user_id INTEGER, reason TEXT NOT NULL, message_body TEXT, status TEXT DEFAULT 'قيد المراجعة', created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    user_blocks: `CREATE TABLE user_blocks(id INTEGER PRIMARY KEY AUTOINCREMENT, blocker_id INTEGER NOT NULL, blocked_id INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(blocker_id, blocked_id))`,
    ratings: `CREATE TABLE ratings(id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL UNIQUE, technician_id INTEGER NOT NULL, customer_id INTEGER NOT NULL, stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5), comment TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    ledger: `CREATE TABLE ledger(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, type TEXT NOT NULL, amount REAL NOT NULL, balance_after REAL NOT NULL, note TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    complaints: `CREATE TABLE complaints(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, request_id INTEGER, subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT DEFAULT 'open', created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  };

  test('قاعدة قائمة مسبقاً بلا FK على الجداول الثمانية: migrate() يضيفها، ويحافظ على كل صف موجود، ويرفض صفوفاً يتيمة بعدها', () => {
    const tmpPath = path.join(os.tmpdir(), `sallehly-fk-migration-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    const db = new Database(tmpPath);
    try {
      // خطوة 1: ترحيل طبيعي أولي — ينشئ users/requests/... (بما فيها الثمانية
      // بصيغتها الجديدة مباشرة، بما أن القاعدة جديدة بالكامل هنا).
      migrate(db);

      const customerId = db.prepare("INSERT INTO users(role,name,email,phone,password_hash,city) VALUES('customer',?,?,?,?,?)")
        .run('عميل ترحيل FK', 'fkmig-customer@example.com', '0791234567', 'x', CITY).lastInsertRowid;
      const technicianId = db.prepare("INSERT INTO users(role,name,email,phone,password_hash,city) VALUES('technician',?,?,?,?,?)")
        .run('فني ترحيل FK', 'fkmig-tech@example.com', '0791234568', 'x', CITY).lastInsertRowid;
      const requestId = db.prepare("INSERT INTO requests(customer_id,technician_id,service,city,description,status) VALUES(?,?,?,?,?,?)")
        .run(customerId, technicianId, SERVICE, CITY, 'طلب اختبار ترحيل FK', 'مكتمل').lastInsertRowid;
      const messageId = db.prepare('INSERT INTO messages(request_id,sender_id,body) VALUES(?,?,?)')
        .run(requestId, customerId, 'رسالة قبل الترحيل').lastInsertRowid;

      // خطوة 2: إعادة كتابة الجداول الثمانية يدوياً بالشكل القديم (بلا FK)
      // مع نقل نفس البيانات المُدرَجة أعلاه — يحاكي بالضبط حالة قاعدة إنتاج
      // حقيقية لم تُرحَّل بعد.
      for (const table of Object.keys(OLD_SCHEMA)) {
        const cols = db.prepare(`SELECT * FROM ${table} LIMIT 1`).columns().map((c) => c.name);
        const rows = db.prepare(`SELECT * FROM ${table}`).all();
        db.exec(`DROP TABLE ${table}`);
        db.exec(OLD_SCHEMA[table]);
        const colList = cols.join(',');
        const placeholders = cols.map(() => '?').join(',');
        const ins = db.prepare(`INSERT INTO ${table} (${colList}) VALUES(${placeholders})`);
        for (const row of rows) ins.run(cols.map((c) => row[c]));
      }

      for (const table of Object.keys(OLD_SCHEMA)) {
        expect(db.pragma(`foreign_key_list(${table})`), `${table} يجب أن يبدأ بلا FK بهذا الاختبار`).toHaveLength(0);
      }

      // خطوة 3: الترحيل الحقيقي قيد الاختبار — إعادة تشغيل migrate() على
      // نفس القاعدة (بالضبط كإعادة نشر على قاعدة إنتاج قائمة).
      expect(() => migrate(db)).not.toThrow();

      for (const table of Object.keys(OLD_SCHEMA)) {
        expect(db.pragma(`foreign_key_list(${table})`).length, `${table} يجب أن يحمل FK بعد الترحيل`).toBeGreaterThan(0);
      }

      // البيانات المُدرَجة قبل الترحيل ما زالت موجودة بلا أي فقدان
      const preservedMessage = db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
      expect(preservedMessage).toBeTruthy();
      expect(preservedMessage.body).toBe('رسالة قبل الترحيل');
      expect(preservedMessage.request_id).toBe(Number(requestId));

      // sqlite_sequence استمر بشكل صحيح — إدراج جديد يأخذ id أعلى من أي موجود
      const newMessageId = db.prepare('INSERT INTO messages(request_id,sender_id,body) VALUES(?,?,?)')
        .run(requestId, customerId, 'رسالة بعد الترحيل').lastInsertRowid;
      expect(Number(newMessageId)).toBeGreaterThan(Number(messageId));

      // FK يُطبَّق فعلياً الآن — صف يتيم (request_id غير موجود) يُرفَض
      expect(() => {
        db.prepare('INSERT INTO messages(request_id,sender_id,body) VALUES(?,?,?)').run(999999, customerId, 'رسالة يتيمة');
      }).toThrow(/FOREIGN KEY constraint failed/);

      // إعادة تشغيل migrate() ثالث مرة — idempotent، لا يعيد بناء ما هو مُهاجَر أصلاً
      expect(() => migrate(db)).not.toThrow();
      const stillThere = db.prepare('SELECT id FROM messages WHERE id=?').get(messageId);
      expect(stillThere).toBeTruthy();
    } finally {
      db.close();
      fs.rmSync(tmpPath, { force: true });
      fs.rmSync(`${tmpPath}-wal`, { force: true });
      fs.rmSync(`${tmpPath}-shm`, { force: true });
    }
  });

  test('صف يتيم فعلي بجدول قديم: الترحيل يتراجع بأمان (rollback)، الجدول يبقى بلا FK، بلا فقدان بيانات، وبلا إسقاط migrate()', () => {
    const tmpPath = path.join(os.tmpdir(), `sallehly-fk-migration-orphan-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    const db = new Database(tmpPath);
    try {
      migrate(db);

      // إعادة كتابة chat_violations فقط بالشكل القديم، مع صف يتيم عمداً
      // (request_id يشير لطلب غير موجود إطلاقاً) — يحاكي بيانات فاسدة نظرياً
      // موجودة مسبقاً على قاعدة إنتاج، لم تُكتشَف بعد.
      db.exec('DROP TABLE chat_violations');
      db.exec(OLD_SCHEMA.chat_violations);
      db.prepare("INSERT INTO chat_violations(request_id,user_id,body,reason) VALUES(?,?,?,?)")
        .run(999999, 1, 'محتوى مخالفة', 'سبب');

      // الترحيل الكامل لا يجب أن يرمي استثناءً غير مُلتقَط أبداً (يُسجَّل
      // ويُتخطّى داخلياً، لا يُسقط الإقلاع بأكمله بسبب جدول واحد فاسد).
      expect(() => migrate(db)).not.toThrow();

      // الجدول المتأثر يبقى بلا FK (لم يُهاجَر) — تراجع تلقائي كامل
      expect(db.pragma('foreign_key_list(chat_violations)')).toHaveLength(0);
      // الصف اليتيم نفسه لا يزال موجوداً بلا أي فقدان (لم يُحذف بمنتصف عملية فاشلة)
      const orphanRow = db.prepare('SELECT * FROM chat_violations WHERE request_id=?').get(999999);
      expect(orphanRow).toBeTruthy();
      expect(orphanRow.reason).toBe('سبب');
    } finally {
      db.close();
      fs.rmSync(tmpPath, { force: true });
      fs.rmSync(`${tmpPath}-wal`, { force: true });
      fs.rmSync(`${tmpPath}-shm`, { force: true });
    }
  });
});
