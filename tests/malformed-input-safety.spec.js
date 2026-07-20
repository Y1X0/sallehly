// tests/malformed-input-safety.spec.js
// يغطي "Invalid JSON" و"Empty responses" من متطلبات اختبار الفشل (Part 4):
// يثبت أن جسم JSON تالف أو حمولة أكبر من الحد المسموح (1MB) لا تُسقط
// السيرفر ولا تكسر أي طلب لاحق — تُرفض بأمان عبر apiErrorHandler
// (middleware/security.js، مُسجَّل كـmiddleware أخير بـserver.js).

const { test, expect } = require('@playwright/test');

test.describe('[Failure] مدخلات جسم الطلب التالفة لا تُسقط السيرفر', () => {
  test('POST بجسم JSON تالف صراحة (Content-Type: application/json) يُرفض بأمان (400) وليس 500 أو انقطاع اتصال', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      headers: { 'Content-Type': 'application/json' },
      data: '{"email": "broken@example.com", "password": ', // JSON غير مكتمل عمداً
    });
    // أي رد HTTP فعلي (وليس فشل اتصال) يثبت أن السيرفر لم ينهَر
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('السيرفر يبقى يعمل بشكل طبيعي لطلب صحيح لاحق مباشرة بعد الجسم التالف', async ({ request }) => {
    // يُشغَّل بعد الاختبار أعلاه — يثبت عملياً أن الخطأ لم يُسقط عملية Node
    // بأكملها (لا انقطاع اتصال لبقية الاختبارات اللاحقة بنفس ملف/تشغيلة الاختبار).
    const res = await request.get('/health');
    expect(res.status()).toBe(200);
  });

  test('POST بحمولة نصية أكبر من الحد المسموح (1MB) تُرفض بأمان دون إسقاط السيرفر', async ({ request }) => {
    const hugeBody = 'x'.repeat(2 * 1024 * 1024); // 2MB > حد الـ1MB المضبوط بـapp.js
    const res = await request.post('/api/auth/login', {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ email: 'a@b.com', password: hugeBody }),
      timeout: 15000,
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);

    const followUp = await request.get('/health');
    expect(followUp.status()).toBe(200);
  });
});
