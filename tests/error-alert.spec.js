// tests/error-alert.spec.js
// [MON-FIX-01] راجع DECISIONS.md وservices/error-alert.js. بيئة الاختبار لا
// تضبط RESEND_API_KEY ولا ALERT_EMAIL — هذا الاختبار يثبت أن alertError()
// بهذه الحالة (نفس حالة أي بيئة لم تُعِدّ التنبيهات بعد) لا يرمي استثناءً
// أبداً ولا يعلّق الاستدعاء، ويرجع false بوضوح. لا يغطي هذا الاختبار مسار
// الإرسال الفعلي عبر الشبكة (يحتاج RESEND_API_KEY حقيقياً) ولا كبح التكرار —
// كلاهما بنفس منطق services/email.js الموجود أصلاً وغير المُختبَر شبكياً هنا
// أيضاً؛ الخاصية الجوهرية للسلامة (لا يفشل الاستدعاء الأصلي أبداً) هي المُثبَتة.

const { test, expect } = require('@playwright/test');
const { alertError, shouldSend, lastSentAt } = require('../services/error-alert');

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

// [SEC-FIX-ERRORALERTMAP-01] راجع DECISIONS.md — lastSentAt (خريطة بالذاكرة
// تكبح تكرار التنبيهات) لم تكن تحذف أي مفتاح إطلاقاً، بأي شرط — تسرّب ذاكرة
// بطيء يتراكم طوال عمر العملية. alertError() نفسها ترجع مبكراً بلا لمس
// الخريطة إطلاقاً بهذه البيئة (لا RESEND_API_KEY)، فهذا الاختبار يستدعي
// shouldSend مباشرة (مصدَّرة خصيصاً لهذا الغرض) بدل الاعتماد على alertError.
test.describe('[SEC-FIX-ERRORALERTMAP-01] تنظيف مفاتيح lastSentAt منتهية مهلة الكبح', () => {
  test('مفتاح تجاوز مهلة الكبح (15 دقيقة) يُحذف تلقائياً عند أي استدعاء لاحق لـshouldSend', () => {
    const staleKey = 'stale-test-key-' + Date.now() + Math.random();
    // يحاكي خطأ حدث منذ وقت طويل (تجاوز أي مهلة كبح واقعية بكثير) ولن يتكرر
    // — طابع زمني قديم يُدرَج مباشرة بدل انتظار 15 دقيقة حقيقية.
    lastSentAt.set(staleKey, Date.now() - 24 * 60 * 60 * 1000);
    expect(lastSentAt.has(staleKey)).toBe(true);

    // استدعاء shouldSend بمفتاح مختلف تماماً — يجب أن ينظّف المفاتيح منتهية
    // الصلاحية كأثر جانبي، لا فقط المفتاح المُستدعى به تحديداً.
    shouldSend('unrelated-key-' + Date.now() + Math.random());

    expect(lastSentAt.has(staleKey)).toBe(false);
  });

  test('مفتاح لا يزال ضمن مهلة الكبح لا يُحذف، ويبقى يمنع تكرار الإرسال', () => {
    const freshKey = 'fresh-test-key-' + Date.now() + Math.random();
    expect(shouldSend(freshKey)).toBe(true);
    expect(lastSentAt.has(freshKey)).toBe(true);
    expect(shouldSend(freshKey)).toBe(false); // ما زال ضمن الكبح، لم يُحذف
  });
});
