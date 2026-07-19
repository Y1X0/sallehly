// tests/bcrypt-migration.spec.js
// [PERF-05] يثبت مباشرة أن الانتقال من bcryptjs إلى bcrypt (native) لا يكسر
// أي مسار مصادقة حقيقي: كلمات سر مستخدمين موجودين مسبقاً (بصيغة $2a$ القديمة
// الناتجة عن bcryptjs) تبقى تعمل بلا أي إعادة تجزئة، التسجيل/تغيير كلمة
// السر/إعادة التعيين الجديدة تُنتج وتتحقق بشكل صحيح، وسلوك الفشل (كلمة سر
// خاطئة، بريد غير موجود) يبقى مطابقاً تماماً بلا أي تغيير بالرسالة أو الرمز.

const { test, expect } = require('@playwright/test');
const { getPendingOtp, openTestDb } = require('./helpers/db');

function uniqueEmail(tag) {
  return `test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}
function uniquePhone() {
  return `07${Math.floor(10000000 + Math.random() * 89999999)}`;
}

const VALID_PASSWORD = 'TestPass123';

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

async function registerAndVerify(request, extra = {}) {
  const email = uniqueEmail('bcryptmig');
  const phone = uniquePhone();
  const registerRes = await request.post('/api/auth/register', {
    form: { role: 'customer', email, phone, password: VALID_PASSWORD, name: 'مستخدم اختبار الترحيل', city: 'عمان', ...extra },
  });
  if (!registerRes.ok()) throw new Error(`فشل التسجيل: ${registerRes.status()} ${await registerRes.text()}`);
  const otp = getPendingOtp(email);
  const res = await request.post('/api/auth/verify-otp', { form: { email, otp } });
  if (!res.ok()) throw new Error(`فشل verify-otp: ${res.status()} ${await res.text()}`);
  const body = await res.json();
  return { email, phone, token: body.token, user: body.user };
}

// [PERF-05] هذا الهاش حقيقي 100% — ناتج فعلي من bcryptjs@2.4.3 لكلمة السر
// 'TestPass123' بتكلفة 12 (نفس القيمة المستخدمة بكل مسارات هذا التطبيق)،
// مُلتقَط مرة واحدة قبل إزالة bcryptjs من المشروع. يُستخدَم هنا فقط لمحاكاة
// صف مستخدم حقيقي كان موجوداً بقاعدة البيانات *قبل* هذا الترحيل — بلا أي
// حاجة لإبقاء bcryptjs كتبعية (ولو للتطوير) لإثبات التوافق الرجعي.
const LEGACY_BCRYPTJS_HASH = '$2a$12$almya5ibdMLkBi9G7tySk.5y68AWaKeWcQiV/uMAL7HTXCh5CeAqu';
const LEGACY_PASSWORD = 'TestPass123';

test.describe('[PERF-05] ترحيل bcryptjs → bcrypt الأصلي — أمان المصادقة الكامل', () => {
  test('1) مستخدم موجود مسبقاً بهاش $2a$ (bcryptjs القديم) يسجّل دخوله بنجاح دون أي إعادة تجزئة', async ({ request }) => {
    const email = uniqueEmail('legacy-hash');
    const phone = uniquePhone();

    const db = openTestDb();
    let userId;
    try {
      expect(LEGACY_BCRYPTJS_HASH.startsWith('$2a$')).toBeTruthy();
      const info = db.prepare(
        `INSERT INTO users(role,name,email,phone,password_hash,is_active) VALUES('customer',?,?,?,?,1)`
      ).run('مستخدم قديم', email, phone, LEGACY_BCRYPTJS_HASH);
      userId = info.lastInsertRowid;
    } finally {
      db.close();
    }

    const res = await request.post('/api/auth/login', { form: { email, password: LEGACY_PASSWORD } });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.token).toBeTruthy();
    expect(body.user.email).toBe(email);

    // الهاش المخزَّن يبقى كما هو تماماً — لا إعادة تجزئة ولا تحديث صامت لصيغته.
    const verifyDb = openTestDb();
    try {
      const row = verifyDb.prepare('SELECT password_hash FROM users WHERE id=?').get(userId);
      expect(row.password_hash).toBe(LEGACY_BCRYPTJS_HASH);
    } finally {
      verifyDb.close();
    }
  });

  test('2) تسجيل حساب جديد بالكامل (register → verify-otp → login) ينتج هاشاً بصيغة $2b$ (bcrypt الأصلي) ويعمل بشكل صحيح', async ({ request }) => {
    const account = await registerAndVerify(request);
    expect(account.token).toBeTruthy();

    const db = openTestDb();
    try {
      const row = db.prepare('SELECT password_hash FROM users WHERE email=?').get(account.email);
      expect(row.password_hash.startsWith('$2b$')).toBeTruthy();
    } finally {
      db.close();
    }

    const loginRes = await request.post('/api/auth/login', { form: { email: account.email, password: VALID_PASSWORD } });
    expect(loginRes.status()).toBe(200);
  });

  test('3) تغيير كلمة السر (/me/password): يعمل بنجاح، والدخول بكلمة السر الجديدة فقط', async ({ request }) => {
    const account = await registerAndVerify(request);
    const newPassword = 'NewSecurePass456';

    const changeRes = await request.post('/api/me/password', {
      headers: authHeader(account.token),
      form: { current_password: VALID_PASSWORD, new_password: newPassword },
    });
    expect(changeRes.status()).toBe(200);
    const changeBody = await changeRes.json();
    expect(changeBody.token).toBeTruthy();

    const oldPasswordLogin = await request.post('/api/auth/login', { form: { email: account.email, password: VALID_PASSWORD } });
    expect(oldPasswordLogin.status()).toBe(401);

    const newPasswordLogin = await request.post('/api/auth/login', { form: { email: account.email, password: newPassword } });
    expect(newPasswordLogin.status()).toBe(200);
  });

  test('4) إعادة تعيين كلمة السر (/auth/forgot-password → /auth/reset-password): يعمل بنجاح، والدخول بالكلمة الجديدة فقط', async ({ request }) => {
    const account = await registerAndVerify(request);
    const newPassword = 'ResetPass789';

    const forgotRes = await request.post('/api/auth/forgot-password', { form: { email: account.email } });
    expect(forgotRes.ok()).toBeTruthy();
    const otp = getPendingOtp(account.email);

    const resetRes = await request.post('/api/auth/reset-password', {
      form: { email: account.email, otp, new_password: newPassword },
    });
    expect(resetRes.status()).toBe(200);

    const oldPasswordLogin = await request.post('/api/auth/login', { form: { email: account.email, password: VALID_PASSWORD } });
    expect(oldPasswordLogin.status()).toBe(401);

    const newPasswordLogin = await request.post('/api/auth/login', { form: { email: account.email, password: newPassword } });
    expect(newPasswordLogin.status()).toBe(200);
  });

  test('5) سلوك فشل الدخول بلا أي تغيير: كلمة سر خاطئة ترجع نفس الرسالة العامة بـ401', async ({ request }) => {
    const account = await registerAndVerify(request);
    const res = await request.post('/api/auth/login', { form: { email: account.email, password: 'WrongPassword999' } });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('بيانات الدخول غير صحيحة');
  });

  test('5b) بريد غير موجود إطلاقاً يرجع نفس رسالة/رمز كلمة السر الخاطئة تماماً (منع Enumeration) — DUMMY_HASH لا يرمي أي استثناء', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      form: { email: uniqueEmail('never-registered'), password: 'AnyPassword123' },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('بيانات الدخول غير صحيحة');
  });

  test('5c) حساب موقوف (is_active=0) بكلمة سر صحيحة: يُرفض بـ403 بعد التحقق الناجح من الهاش، لا 401', async ({ request }) => {
    const account = await registerAndVerify(request);
    const db = openTestDb();
    try {
      db.prepare('UPDATE users SET is_active=0 WHERE email=?').run(account.email);
    } finally {
      db.close();
    }
    const res = await request.post('/api/auth/login', { form: { email: account.email, password: VALID_PASSWORD } });
    expect(res.status()).toBe(403);
  });

  test('6) طلبات دخول متزامنة حقيقية (bcrypt native، threadpool) لعدة حسابات مختلفة: كل حساب يتحقق بنجاح بلا أي تداخل', async ({ request }) => {
    const accounts = await Promise.all([
      registerAndVerify(request, { name: 'مستخدم تزامن 1' }),
      registerAndVerify(request, { name: 'مستخدم تزامن 2' }),
      registerAndVerify(request, { name: 'مستخدم تزامن 3' }),
    ]);

    const results = await Promise.all(
      accounts.map((a) => request.post('/api/auth/login', { form: { email: a.email, password: VALID_PASSWORD } }))
    );

    for (let i = 0; i < results.length; i++) {
      expect(results[i].status()).toBe(200);
      const body = await results[i].json();
      expect(body.user.email).toBe(accounts[i].email);
    }
  });
});
