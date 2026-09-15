// tests/social-account-deletion.spec.js — [FIX-SOCIALDELETE-01]
// راجع DECISIONS.md وتعليق migrate.js — حساب جوجل/أبل يُنشأ بكلمة سر عشوائية
// غير معروفة حتى لصاحب الحساب (راجع /auth/google-register، /auth/apple-register:
// randomHash = bcrypt.hash(crypto.randomBytes(32)...)). قبل هذا الإصلاح، كان
// DELETE /me يطلب كلمة السر دائماً للتأكيد — فيرفض bcrypt.compare أي كلمة
// يكتبها مستخدم كهذا دائماً: لا طريقة يحذف فيها حسابه الذاتي إطلاقاً. هذا
// عطل حقيقي مكتشَف عبر تدقيق الكود، أثّر على أي مستخدم Google Sign-In حالي.
//
// لا يمكن تزييف idToken حقيقي صادر عن Firebase هنا (راجع google-auth.spec.js/
// apple-auth.spec.js لنفس القيد)، فمحاكاة "حساب اجتماعي" هنا تتم بتعديل مباشر
// لقاعدة بيانات الاختبار بعد تسجيل عادي — يطابق تماماً الحالة الحقيقية التي
// ينشئها /auth/google-register فعلياً (has_password=0، password_hash عشوائي
// لا يعرفه صاحب الحساب).

const { test, expect } = require('@playwright/test');
const { getPendingOtp, openTestDb } = require('./helpers/db');

function uniqueEmail(tag) {
  return `test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}
function uniquePhone() {
  const suffix = Math.floor(10000000 + Math.random() * 89999999);
  return `07${suffix}`;
}

const VALID_PASSWORD = 'TestPass123';
const CITY = 'عمان';

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

async function registerAndVerify(request, extra = {}) {
  const email = uniqueEmail('social-del');
  const phone = uniquePhone();
  const registerRes = await request.post('/api/auth/register', {
    form: { role: 'customer', name: 'عميل اختبار حذف حساب اجتماعي', email, phone, password: VALID_PASSWORD, city: CITY, ...extra },
  });
  if (!registerRes.ok()) throw new Error(`فشل تسجيل أثناء تجهيز الاختبار: ${registerRes.status()} ${await registerRes.text()}`);
  const otp = getPendingOtp(email);
  const res = await request.post('/api/auth/verify-otp', { form: { email, otp } });
  if (!res.ok()) throw new Error(`فشل verify-otp أثناء تجهيز الاختبار: ${res.status()} ${await res.text()}`);
  const body = await res.json();
  return { email, phone, token: body.token, user: body.user };
}

// يحاكي بالضبط ما يفعله /auth/google-register أو /auth/apple-register عند
// إنشاء حساب: has_password=0 + password_hash عشوائي لا يعرفه صاحب الحساب.
function simulateSocialAccount(userId) {
  const db = openTestDb();
  try {
    db.prepare("UPDATE users SET has_password=0, password_hash='$2a$12$notARealHashNobodyKnowsThisValue1234567890abcdefghij' WHERE id=?").run(userId);
  } finally {
    db.close();
  }
}

test.describe('[FIX-SOCIALDELETE-01] حذف حساب اجتماعي (جوجل/أبل) بلا كلمة سر حقيقية', () => {
  test('DELETE /api/me لحساب اجتماعي (has_password=0): ينجح بلا الحاجة لكلمة سر صحيحة', async ({ request }) => {
    const customer = await registerAndVerify(request);
    simulateSocialAccount(customer.user.id);

    // كلمة سر عشوائية لا علاقة لها بأي شيء — كانت سترفض قبل الإصلاح، ويجب
    // أن تُقبَل الآن لأن has_password=0 يتجاوز الفحص بالكامل (auth() أعلاه
    // أثبت الهوية فعلاً عبر توكن صالح).
    const res = await request.delete('/api/me', {
      headers: authHeader(customer.token),
      form: { password: 'كلمة سر عشوائية لا يعرفها أحد' },
    });
    expect(res.status(), await res.text()).toBe(200);

    const loginRes = await request.post('/api/auth/login', {
      form: { email: customer.email, password: VALID_PASSWORD },
    });
    expect(loginRes.status()).not.toBe(200);
  });

  test('DELETE /api/me لحساب عادي (has_password ليس 0): ما زال يرفض كلمة سر خاطئة بـ401 (لا انحدار)', async ({ request }) => {
    const customer = await registerAndVerify(request);

    const res = await request.delete('/api/me', {
      headers: authHeader(customer.token),
      form: { password: 'كلمة سر خاطئة قطعاً' },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('DELETE_ACCOUNT_WRONG_PASSWORD');

    // الحساب لا يزال موجوداً وفعّالاً
    const loginRes = await request.post('/api/auth/login', {
      form: { email: customer.email, password: VALID_PASSWORD },
    });
    expect(loginRes.status()).toBe(200);
  });
});
