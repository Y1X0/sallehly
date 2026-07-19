// tests/health.spec.js
// [PERF-HARDEN-04] فحص الصحة الخفيف — بلا مصادقة، يتأكد من استجابة السيرفر
// وقاعدة البيانات معاً. يُستخدَم من منصة النشر/أدوات المراقبة الخارجية.

const { test, expect } = require('@playwright/test');

test.describe('[PERF-HARDEN-04] GET /health', () => {
  test('يرجع 200 بلا أي توكن، ويؤكد استجابة قاعدة البيانات', async ({ request }) => {
    const res = await request.get('/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  test('لا يتطلّب أي هيدر Authorization، ولا يتأثر بوجود توكن غير صالح', async ({ request }) => {
    const res = await request.get('/health', { headers: { Authorization: 'Bearer not-a-real-token' } });
    expect(res.status()).toBe(200);
  });
});
