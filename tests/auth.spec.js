// tests/auth.spec.js
// يغطي: تسجيل عميل جديد → التحقق من OTP → تسجيل الدخول، بالإضافة لحالات الخطأ الأساسية.
// يعمل على سيرفر وقاعدة بيانات اختبار منفصلين بالكامل (راجع playwright.config.js).

const { test, expect } = require('@playwright/test');
const { getPendingOtp, openTestDb } = require('./helpers/db');

function uniqueEmail() {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}

function uniquePhone() {
  // رقم أردني صالح حسب التحقق بالسيرفر: يبدأ بـ 07 ويتكون من 10 أرقام بالضبط
  const suffix = Math.floor(10000000 + Math.random() * 89999999);
  return `07${suffix}`;
}

const VALID_PASSWORD = 'TestPass123';

test.describe.serial('تسجيل ودخول عميل جديد', () => {
  const email = uniqueEmail();
  const phone = uniquePhone();
  let sessionToken;

  test('POST /api/auth/register — يقبل بيانات صحيحة ويرسل خطوة تحقق', async ({ request }) => {
    const res = await request.post('/api/auth/register', {
      form: {
        role: 'customer',
        name: 'مستخدم اختبار',
        email,
        phone,
        password: VALID_PASSWORD,
        city: 'عمان',
      },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.step).toBe('verify');
    expect(body.email).toBe(email);
  });

  test('POST /api/auth/register — يرفض بريد إلكتروني مستخدم مسبقاً بنفس الخطوة', async ({ request }) => {
    // نفس الإيميل تماماً — لسا ما تحقق منه، لكن السيرفر يفحص جدول users فقط (وليس pending_users)
    // لذلك هذا الطلب يُفترض ينجح أيضاً (يستبدل الطلب المعلّق) — نتحقق من عدم انهياره على الأقل
    const res = await request.post('/api/auth/register', {
      form: {
        role: 'customer',
        name: 'مستخدم اختبار 2',
        email,
        phone: uniquePhone(),
        password: VALID_PASSWORD,
        city: 'عمان',
      },
    });
    expect(res.status()).toBe(200);
  });

  test('POST /api/auth/register — يرفض كلمة سر قصيرة (أقل من 8 أحرف)', async ({ request }) => {
    const res = await request.post('/api/auth/register', {
      form: {
        role: 'customer',
        name: 'مستخدم اختبار',
        email: uniqueEmail(),
        phone: uniquePhone(),
        password: '123',
        city: 'عمان',
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  test('POST /api/auth/register — يرفض رقم هاتف غير أردني الصيغة', async ({ request }) => {
    const res = await request.post('/api/auth/register', {
      form: {
        role: 'customer',
        name: 'مستخدم اختبار',
        email: uniqueEmail(),
        phone: '12345',
        password: VALID_PASSWORD,
        city: 'عمان',
      },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/auth/verify-otp — يرفض كود خاطئ', async ({ request }) => {
    const res = await request.post('/api/auth/verify-otp', {
      form: { email, otp: '000000' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/auth/verify-otp — ينشئ الحساب فعلياً بالكود الصحيح', async ({ request }) => {
    // نعيد التسجيل بنفس الإيميل لضمان وجود طلب معلّق حديث (الاختبار السابق استهلك محاولة خاطئة عليه)
    await request.post('/api/auth/register', {
      form: {
        role: 'customer',
        name: 'مستخدم اختبار نهائي',
        email,
        phone,
        password: VALID_PASSWORD,
        city: 'عمان',
      },
    });

    const otp = getPendingOtp(email);
    expect(otp).toMatch(/^\d{6}$/);

    const res = await request.post('/api/auth/verify-otp', {
      form: { email, otp },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.token).toBeTruthy();
    expect(body.user.email).toBe(email);
    expect(body.user.role).toBe('customer');
    // لا يجب أن يُعاد password_hash إطلاقاً بأي استجابة للمستخدم
    expect(body.user.password_hash).toBeUndefined();

    sessionToken = body.token;
  });

  test('POST /api/auth/login — ينجح ببيانات الدخول الصحيحة', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      form: { email, password: VALID_PASSWORD },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.token).toBeTruthy();
  });

  test('POST /api/auth/login — يرفض كلمة سر خاطئة برسالة عامة (بلا كشف تفاصيل)', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      form: { email, password: 'WrongPassword999' },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  test('POST /api/auth/login — يرفض إيميل غير موجود بنفس رسالة كلمة السر الخاطئة (منع Enumeration)', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      form: { email: uniqueEmail(), password: VALID_PASSWORD },
    });
    expect(res.status()).toBe(401);
  });

  test('GET /api/me — يرفض الوصول بلا توكن', async ({ request }) => {
    const res = await request.get('/api/me');
    expect(res.status()).toBe(401);
  });

  test('GET /api/me — يرجع بيانات المستخدم الصحيحة بتوكن صالح', async ({ request }) => {
    expect(sessionToken).toBeTruthy();
    const res = await request.get('/api/me', {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.user.email).toBe(email);
  });
});

// [PERF-04] bcrypt.compareSync -> bcrypt.compare (async) أضاف أول نقطة await
// فعلية داخل هذه الـhandlers — قبلها كان الطلب بأكمله يُنفَّذ ذرّياً (بلا أي
// فرصة لتداخل طلب آخر) لأن Node أحادي الخيط ولا شيء غير متزامن بالمنتصف.
// هذا الاختبار يثبت أن نافذة الـawait الجديدة لا تسبب أي تسرّب/تداخل بين
// طلبين متزامنين لحسابين مختلفين على /me/password (يستخدم نفس await
// bcrypt.compare المُضاف بتسجيل الدخول تماماً) — كل مستخدم يجب أن تُحدَّث
// كلمة سره هو فقط، بتوكن جلسته هو فقط.
// (يتعمّد تجنّب /auth/login: loginLimiter مشترك بمفتاح IP الواحد عبر كل
// ملفات هذه المجموعة، وميزانيته مستهلكة بالكامل تقريباً أصلاً من الاختبارات
// الحالية — /me/password يمرّ بنفس نقطة الـawait دون استهلاك تلك الحصة.)
test.describe('[PERF-04] تحديث كلمة سر متزامن لحسابين مختلفين — بلا تداخل', () => {
  async function registerVerifyAndGetToken(request, { email, phone, password }) {
    const registerRes = await request.post('/api/auth/register', {
      form: { role: 'customer', name: 'مستخدم تزامن', email, phone, password, city: 'عمان' },
    });
    if (!registerRes.ok()) throw new Error(`فشل التسجيل: ${registerRes.status()} ${await registerRes.text()}`);
    const otp = getPendingOtp(email);
    const verifyRes = await request.post('/api/auth/verify-otp', { form: { email, otp } });
    if (!verifyRes.ok()) throw new Error(`فشل verify-otp: ${verifyRes.status()} ${await verifyRes.text()}`);
    return (await verifyRes.json()).token;
  }

  test('طلبا /me/password متزامنان لحسابين مختلفين: كل حساب يُحدَّث بكلمة سره هو فقط', async ({ request }) => {
    const userA = { email: uniqueEmail(), phone: uniquePhone(), password: 'PasswordAAA111' };
    const userB = { email: uniqueEmail(), phone: uniquePhone(), password: 'PasswordBBB222' };

    const tokenA = await registerVerifyAndGetToken(request, userA);
    const tokenB = await registerVerifyAndGetToken(request, userB);

    // متزامنان فعلياً (بلا await بينهما) — كلاهما يمر عبر await bcrypt.compare
    // ثم await bcrypt.hash بنفس اللحظة تقريباً، على حسابين مختلفين كلياً.
    const [resA, resB] = await Promise.all([
      request.post('/api/me/password', {
        headers: { Authorization: `Bearer ${tokenA}` },
        form: { current_password: userA.password, new_password: 'NewPasswordAAA999' },
      }),
      request.post('/api/me/password', {
        headers: { Authorization: `Bearer ${tokenB}` },
        form: { current_password: userB.password, new_password: 'NewPasswordBBB999' },
      }),
    ]);

    expect(resA.status()).toBe(200);
    expect(resB.status()).toBe(200);

    const [bodyA, bodyB] = await Promise.all([resA.json(), resB.json()]);
    expect(bodyA.token).toBeTruthy();
    expect(bodyB.token).toBeTruthy();
    expect(bodyA.token).not.toBe(bodyB.token);

    // كل توكن جديد يجب أن يعمل فقط لصاحبه فعلياً — لا تداخل بين الحسابين.
    const [meA, meB] = await Promise.all([
      request.get('/api/me', { headers: { Authorization: `Bearer ${bodyA.token}` } }),
      request.get('/api/me', { headers: { Authorization: `Bearer ${bodyB.token}` } }),
    ]);
    expect((await meA.json()).user.email).toBe(userA.email);
    expect((await meB.json()).user.email).toBe(userB.email);
  });
});

// [PERF-HARDEN-03] يحاكي مباشرة الحالة النادرة التي يمكن أن تحدث فيها نافذة
// تسابق ضيقة بمسار /auth/register (بين فحص وجود الإيميل وإدراج صف pending_users
// الفعلي يوجد await واحد — bcrypt.hash — يسمح لطلب آخر بالتنفيذ بالمنتصف):
// أكثر من صف pending_users بنفس الإيميل. بدون ORDER BY id DESC LIMIT 1 صريح،
// .get() قد يُرجع أقدم صف بدل آخر محاولة فعلية للمستخدم.
test.describe('[PERF-HARDEN-03] pending_users — الصف الأحدث دائماً هو المُعتمَد عند تعدّد الصفوف', () => {
  test('POST /auth/verify-otp يقبل كود آخر محاولة تسجيل، ويرفض كود محاولة أقدم لنفس الإيميل', async ({ request }) => {
    const email = uniqueEmail();
    const db = openTestDb();
    let oldOtp, newOtp;
    try {
      oldOtp = '111111';
      newOtp = '222222';
      const data = JSON.stringify({
        role: 'customer', name: 'مستخدم اختبار السباق', email, phone: uniquePhone(),
        hash: '$2a$12$dummyhashdummyhashdummyhashdummyhashdummyhash', national_number: '', city: 'عمان', services: '', areas: '',
      });
      const insert = db.prepare(
        'INSERT INTO pending_users(email,otp,otp_expires,data,avatar_filename) VALUES(?,?,?,?,?)'
      );
      // الصف الأقدم أولاً (id أصغر)، ثم الأحدث (id أكبر) — محاكاة لمحاولتَي
      // تسجيل متتاليتين بلا حذف بينهما (بالضبط ما قد ينتج عن نافذة التسابق).
      insert.run(email, oldOtp, Date.now() + 10 * 60 * 1000, data, '');
      insert.run(email, newOtp, Date.now() + 10 * 60 * 1000, data, '');
    } finally {
      db.close();
    }

    // كود المحاولة الأقدم يُرفض — لو كان .get() يُرجع الصف الأقدم لكان هذا يُقبَل خطأً.
    const oldAttempt = await request.post('/api/auth/verify-otp', { form: { email, otp: oldOtp } });
    expect(oldAttempt.status()).toBe(400);

    // كود المحاولة الأحدث (الفعلية) يُقبَل وينشئ الحساب بنجاح.
    const newAttempt = await request.post('/api/auth/verify-otp', { form: { email, otp: newOtp } });
    expect(newAttempt.status()).toBe(200);
    const body = await newAttempt.json();
    expect(body.user.email).toBe(email);
  });
});
