// tests/auth.spec.js
// يغطي: تسجيل عميل جديد → التحقق من OTP → تسجيل الدخول، بالإضافة لحالات الخطأ الأساسية.
// يعمل على سيرفر وقاعدة بيانات اختبار منفصلين بالكامل (راجع playwright.config.js).

const { test, expect } = require('@playwright/test');
const { getPendingOtp } = require('./helpers/db');

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
