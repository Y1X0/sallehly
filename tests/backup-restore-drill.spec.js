// tests/backup-restore-drill.spec.js
// [DR-FIX-01] راجع DECISIONS.md وscripts/restore-db.js. هذا الاختبار الوحيد
// الذي يثبت أن الاستعادة تعمل فعلياً من طرف لطرف — لا يفتح ملف النسخة مباشرة
// فقط (ذلك مغطى أصلاً بـtests/db-integrity.spec.js وtests/admin.spec.js)، بل
// يُشغِّل أداة الاستعادة الحقيقية (scripts/restore-db.js) كعملية منفصلة تماماً
// كما سيفعل مُشغِّل حقيقي أثناء كارثة، على مسار هدف جديد بالكامل، ثم يتحقق أن
// بيانات حقيقية أُنشئت بهذا الاختبار موجودة فعلاً بالملف المُستعاد. نسخة
// احتياطية لم تُختبَر استعادتها ليست نسخة احتياطية.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const Database = require('better-sqlite3');
const { test, expect } = require('@playwright/test');
const { getPendingOtp, TEST_DB_PATH } = require('./helpers/db');

const execFileAsync = promisify(execFile);

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

// scripts/restore-db.js يقرأ config/env.js عند require — لازم نمرّر نفس
// متغيرات بيئة الاختبار (DATA_DIR تحديداً) وإلا يقرأ مسار قاعدة بيانات مختلف
// كلياً عن السيرفر الحي بهذا الاختبار.
function runRestoreScript(args) {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'restore-db.js');
  return execFileAsync('node', [scriptPath, ...args], {
    env: { ...process.env, NODE_ENV: 'test', DATA_DIR: './data-test' },
    cwd: path.join(__dirname, '..')
  });
}

test.describe.serial('[DR-FIX-01] استعادة نسخة احتياطية فعلياً — من طرف لطرف', () => {
  let customer;
  let adminToken;
  let uniqueRequestDescription;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });

    const email = uniqueEmail('restoredrill');
    const phone = uniquePhone();
    const registerRes = await request.post('/api/auth/register', {
      form: { role: 'customer', email, phone, password: VALID_PASSWORD, name: 'عميل تمرين الاستعادة', city: 'عمان' }
    });
    if (!registerRes.ok()) throw new Error(`فشل تسجيل العميل: ${registerRes.status()} ${await registerRes.text()}`);
    const otp = getPendingOtp(email);
    const verifyRes = await request.post('/api/auth/verify-otp', { form: { email, otp } });
    const body = await verifyRes.json();
    customer = { token: body.token };

    // بيانات فريدة يمكن التحقق من وجودها بالملف المُستعاد تحديداً (لا يمكن
    // أن تكون موجودة صدفة من اختبار آخر).
    uniqueRequestDescription = `وصف تمرين استعادة فريد ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      multipart: { service: 'كهربائي', city: 'عمان', area: 'القويسمة', description: uniqueRequestDescription }
    });
    if (!createRes.ok()) throw new Error(`فشل إنشاء الطلب: ${createRes.status()} ${await createRes.text()}`);

    const adminRes = await request.post('/api/auth/login', { form: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    adminToken = (await adminRes.json()).token;

    await request.dispose();
  });

  test('النسخة الاحتياطية الحقيقية تُستعاد لمسار جديد، وتحتوي البيانات الفعلية التي أُنشئت للتو', async ({ request }) => {
    // 1) نسخة احتياطية حقيقية عبر نفس المسار المستخدَم بالإنتاج فعلياً.
    const backupRes = await request.post('/api/admin/backup', { headers: authHeader(adminToken) });
    expect(backupRes.status()).toBe(200);
    const backupBody = await backupRes.json();
    const backupPath = path.join('data-test', 'backups', backupBody.file);
    expect(fs.existsSync(backupPath)).toBeTruthy();

    // 2) --list يجب أن يعرض هذه النسخة (يثبت أن الأداة تقرأ نفس مجلد النسخ فعلياً).
    const { stdout: listOutput } = await runRestoreScript(['--list']);
    expect(listOutput).toContain(backupBody.file);

    // 3) الاستعادة الفعلية — العملية الحقيقية التي يُشغّلها المُشغِّل أثناء
    // كارثة، لمسار هدف جديد تماماً (ليس قاعدة الاختبار الحيّة، حتى لا نعطّل
    // بقية الاختبارات المتوازية).
    const restoreTarget = path.join(os.tmpdir(), `restore-drill-${Date.now()}.sqlite`);
    const { stdout: restoreOutput } = await runRestoreScript(['--source', backupPath, '--target', restoreTarget]);
    expect(restoreOutput).toContain('فحص السلامة: ok');
    expect(fs.existsSync(restoreTarget)).toBeTruthy();

    // 4) الفحص الحقيقي: افتح الملف المُستعاد (لا الأصلي) وتأكّد أن البيانات
    // التي أُنشئت بهذا الاختبار تحديداً موجودة فعلاً بعد الاستعادة.
    const restoredDb = new Database(restoreTarget, { readonly: true, fileMustExist: true });
    try {
      const integrity = restoredDb.prepare('PRAGMA integrity_check').get();
      expect(integrity.integrity_check).toBe('ok');

      const found = restoredDb.prepare('SELECT id FROM requests WHERE description=?').get(uniqueRequestDescription);
      expect(found).toBeTruthy();
    } finally {
      restoredDb.close();
    }

    fs.unlinkSync(restoreTarget);
  });

  test('استعادة من ملف تالف تُرفض بوضوح، ولا تُنشئ أو تلمس أي ملف بالمسار الهدف', async () => {
    const corruptSource = path.join(os.tmpdir(), `corrupt-backup-${Date.now()}.sqlite`);
    fs.writeFileSync(corruptSource, 'هذا ليس ملف SQLite صالحاً إطلاقاً');
    const restoreTarget = path.join(os.tmpdir(), `restore-drill-corrupt-${Date.now()}.sqlite`);

    await expect(runRestoreScript(['--source', corruptSource, '--target', restoreTarget])).rejects.toThrow();
    expect(fs.existsSync(restoreTarget)).toBeFalsy();

    fs.unlinkSync(corruptSource);
  });

  test('استعادة لمسار القاعدة الحيّة بلا --force تُرفض صراحة', async () => {
    await expect(runRestoreScript(['--source', TEST_DB_PATH, '--target', TEST_DB_PATH])).rejects.toThrow(/--force/);
  });
});
