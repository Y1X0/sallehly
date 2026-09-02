// tests/security-headers.spec.js
// [FIX-FRAMEANCESTORS-01] راجع DECISIONS.md — middleware/security.js's helmetMiddleware
// يضبط frameguard: {action: 'deny'} (X-Frame-Options: DENY) بنية منع تضمين
// الموقع داخل أي إطار (iframe) على الإطلاق. لكن useDefaults: true بإعداد CSP
// يدمج توجيهات Helmet الافتراضية، ومنها frame-ancestors: ['self'] — لم تكن
// مُستبدَلة صراحة، فالسياسة الفعلية المُطبَّقة بالمتصفحات الحديثة (frame-ancestors
// يتفوّق على X-Frame-Options عند تعارضهما) كانت "مسموح من نفس الأصل" لا
// "ممنوع كلياً" كما توحي DENY. يثبت هذا الاختبار كلا الترويستين معاً على
// استجابة حقيقية.

const { test, expect } = require('@playwright/test');

test.describe('[FIX-FRAMEANCESTORS-01] ترويسات منع التضمين (framing) متّسقة فعلياً', () => {
  test('X-Frame-Options: DENY وContent-Security-Policy: frame-ancestors \'none\' معاً على استجابة حقيقية', async ({ request }) => {
    const res = await request.get('/health');
    const headers = res.headers();

    expect(headers['x-frame-options']).toBe('DENY');

    const csp = headers['content-security-policy'] || '';
    expect(csp).toContain("frame-ancestors 'none'");
    // لا يجوز أن تبقى القيمة الافتراضية 'self' موجودة أيضاً بنفس التوجيه —
    // هذا بالضبط ما كان يُضعِف DENY صامتاً قبل هذا الإصلاح.
    expect(csp).not.toContain("frame-ancestors 'self'");
  });
});
