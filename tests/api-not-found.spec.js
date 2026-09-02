// tests/api-not-found.spec.js
// [FIX-API404-01] راجع DECISIONS.md — قبل هذا الإصلاح، أي مسار /api/* غير
// معروف (لا route طابقه) كان يصل للمسار الشامل (server.js) ويحصل على
// index.html بحالة 200 بدل 404 JSON — يضلِّل أي عميل يتوقع JSON. يثبت هذا
// الاختبار السلوكين معاً: /api/* غير معروف يرجع الآن 404 JSON نظيف، وأي
// مسار آخر خارج /api يبقى يحصل على index.html كالمعتاد (لا كسر لتوجيه
// صفحات public/ العميقة).

const { test, expect } = require('@playwright/test');

test.describe('[FIX-API404-01] مسار /api/* غير معروف يرجع 404 JSON بدل index.html', () => {
  test('GET /api/غير-موجود يرجع 404 مع code واضح، لا HTML', async ({ request }) => {
    const res = await request.get('/api/this-endpoint-does-not-exist');
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('API_ROUTE_NOT_FOUND');
  });

  test('GET لمسار /api متداخل غير معروف يرجع 404 JSON أيضاً', async ({ request }) => {
    const res = await request.get('/api/admin/this-does-not-exist-either');
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('API_ROUTE_NOT_FOUND');
  });

  test('GET لمسار خارج /api (توجيه صفحة عميقة) لا يزال يحصل على index.html بحالة 200', async ({ request }) => {
    const res = await request.get('/some/deep/frontend/route/that/does/not/exist/as/a/file');
    expect(res.status()).toBe(200);
    const contentType = res.headers()['content-type'] || '';
    expect(contentType).toContain('text/html');
  });
});
