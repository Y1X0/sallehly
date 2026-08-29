// tests/error-alert.spec.js
// [MON-FIX-01] راجع DECISIONS.md وservices/error-alert.js. بيئة الاختبار لا
// تضبط RESEND_API_KEY ولا ALERT_EMAIL — هذا الاختبار يثبت أن alertError()
// بهذه الحالة (نفس حالة أي بيئة لم تُعِدّ التنبيهات بعد) لا يرمي استثناءً
// أبداً ولا يعلّق الاستدعاء، ويرجع false بوضوح. لا يغطي هذا الاختبار مسار
// الإرسال الفعلي عبر الشبكة (يحتاج RESEND_API_KEY حقيقياً) ولا كبح التكرار —
// كلاهما بنفس منطق services/email.js الموجود أصلاً وغير المُختبَر شبكياً هنا
// أيضاً؛ الخاصية الجوهرية للسلامة (لا يفشل الاستدعاء الأصلي أبداً) هي المُثبَتة.

const { test, expect } = require('@playwright/test');
const { alertError } = require('../services/error-alert');

test.describe('[MON-FIX-01] alertError — سلامة بلا إعداد', () => {
  test('يرجع false بهدوء بلا استثناء عندما لا RESEND_API_KEY ولا ALERT_EMAIL مضبوطَين', async () => {
    const result = await alertError('unit-test', new Error('خطأ تجريبي'));
    expect(result).toBe(false);
  });

  test('يقبل سبب غير Error (كما يصل أحياناً من unhandledRejection) بلا استثناء', async () => {
    const result = await alertError('unit-test', 'مجرد نص، لا كائن Error');
    expect(result).toBe(false);
  });
});
