// tests/email-ascii-validation.spec.js — [FIX-EMAILASCII-01]
// يغطي: إيميل شكله صحيح لكن يحتوي رقماً/حرفاً غير-ASCII (محاكاة كيبورد
// بوضع عربي بدّل رقماً إنجليزياً برقم هندي عربي يشبهه بصرياً) يُرفض برسالة
// EMAIL_NON_ASCII الواضحة عند /auth/register و/auth/forgot-password، بدل
// المرور بنجاح ظاهري ثم الفشل لاحقاً عند إرسال Resend الحقيقي.

const { test, expect } = require('@playwright/test');

// "٠" (Arabic-Indic zero, U+0660) بدل "0" الإنجليزي العادي — بالضبط نمط
// الحالة الحقيقية المرصودة بسجلات Resend (422 "non-ASCII characters").
const NON_ASCII_EMAIL = 'test-user-16٠09232@example.com';

function uniquePhone() {
  const suffix = Math.floor(10000000 + Math.random() * 89999999);
  return `07${suffix}`;
}

test.describe('[FIX-EMAILASCII-01] رفض إيميل يحتوي رموزاً غير-ASCII', () => {
  test('POST /api/auth/register — يرفض برسالة EMAIL_NON_ASCII واضحة', async ({ request }) => {
    const res = await request.post('/api/auth/register', {
      form: {
        role: 'customer',
        name: 'مستخدم اختبار',
        email: NON_ASCII_EMAIL,
        phone: uniquePhone(),
        password: 'TestPass123',
        city: 'عمان',
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('EMAIL_NON_ASCII');
  });

  test('POST /api/auth/forgot-password — يرفض برسالة EMAIL_NON_ASCII واضحة (قبل أي فحص وجود حساب)', async ({ request }) => {
    const res = await request.post('/api/auth/forgot-password', {
      form: { email: NON_ASCII_EMAIL },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('EMAIL_NON_ASCII');
  });

  test('إيميل ASCII عادي طبيعي لا يتأثر — يمر فحص الشكل بلا أي رفض جديد', async ({ request }) => {
    const res = await request.post('/api/auth/register', {
      form: {
        role: 'customer',
        name: 'مستخدم اختبار',
        email: `normal-${Date.now()}@example.com`,
        phone: uniquePhone(),
        password: 'TestPass123',
        city: 'عمان',
      },
    });
    // OTP فعلياً غير مُرسَل ببيئة الاختبار (لا RESEND_API_KEY) — النجاح هنا
    // يعني فقط اجتياز كل فحوصات الشكل (200 مع step:'verify')، لا استلام بريد حقيقي.
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.step).toBe('verify');
  });
});
