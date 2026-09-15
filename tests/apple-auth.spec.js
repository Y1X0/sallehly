// tests/apple-auth.spec.js
// [FEAT-APPLESIGNIN-01] يغطي POST /api/auth/apple و POST /api/auth/apple-register
// — نفس تغطية tests/google-auth.spec.js بالضبط ولنفس السبب (idToken حقيقي
// صادر عن Firebase غير قابل للتزييف هنا، فالتغطية تقتصر على مسارَي الرفض
// المتوقَّعين: توكن مفقود، توكن غير صالح — راجع services/push.js
// verifyFirebaseIdToken، وهي provider-agnostic فعلياً، نفس الدالة المستخدمة
// بمسار جوجل تحت اسم مستعار فقط).

const { test, expect } = require('@playwright/test');

test.describe('POST /api/auth/apple', () => {
  test('يرفض طلباً بلا idToken', async ({ request }) => {
    const res = await request.post('/api/auth/apple', { data: {} });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('APPLE_TOKEN_MISSING');
  });

  test('يرفض idToken غير صالح', async ({ request }) => {
    const res = await request.post('/api/auth/apple', {
      data: { idToken: 'this-is-not-a-real-firebase-token' },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('APPLE_TOKEN_INVALID');
  });
});

test.describe('POST /api/auth/apple-register', () => {
  test('يرفض طلباً بلا idToken', async ({ request }) => {
    const res = await request.post('/api/auth/apple-register', {
      form: { role: 'customer', name: 'مستخدم اختبار', phone: '0791234569', city: 'عمان' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('APPLE_TOKEN_MISSING');
  });

  test('يرفض idToken غير صالح حتى لو باقي الحقول صحيحة', async ({ request }) => {
    const res = await request.post('/api/auth/apple-register', {
      form: {
        idToken: 'this-is-not-a-real-firebase-token',
        role: 'customer',
        name: 'مستخدم اختبار',
        phone: '0791234570',
        city: 'عمان',
      },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('APPLE_TOKEN_INVALID');
  });
});
