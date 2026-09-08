// tests/google-auth.spec.js
// يغطي POST /api/auth/google و POST /api/auth/google-register.
// لا يمكن تزييف ID token حقيقي صادر عن Firebase داخل بيئة الاختبار (يتطلب
// مشروع Firebase حقيقي)، فالتغطية هنا تقتصر على مسارَي الرفض المتوقَّعين
// (توكن مفقود، توكن غير صالح) — وهما يعملان بنفس السلوك سواء كان Firebase
// Admin مهيَّأ فعلياً بهذه البيئة أم لا (راجع services/push.js:
// verifyGoogleIdToken يرمي استثناءً في الحالتين، والراوت يترجمه لنفس الرد).

const { test, expect } = require('@playwright/test');

test.describe('POST /api/auth/google', () => {
  test('يرفض طلباً بلا idToken', async ({ request }) => {
    const res = await request.post('/api/auth/google', { data: {} });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('GOOGLE_TOKEN_MISSING');
  });

  test('يرفض idToken غير صالح', async ({ request }) => {
    const res = await request.post('/api/auth/google', {
      data: { idToken: 'this-is-not-a-real-firebase-token' },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('GOOGLE_TOKEN_INVALID');
  });
});

test.describe('POST /api/auth/google-register', () => {
  test('يرفض طلباً بلا idToken', async ({ request }) => {
    const res = await request.post('/api/auth/google-register', {
      form: { role: 'customer', name: 'مستخدم اختبار', phone: '0791234567', city: 'عمان' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('GOOGLE_TOKEN_MISSING');
  });

  test('يرفض idToken غير صالح حتى لو باقي الحقول صحيحة', async ({ request }) => {
    const res = await request.post('/api/auth/google-register', {
      form: {
        idToken: 'this-is-not-a-real-firebase-token',
        role: 'customer',
        name: 'مستخدم اختبار',
        phone: '0791234568',
        city: 'عمان',
      },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('GOOGLE_TOKEN_INVALID');
  });
});
