// tests/error-alert.spec.js
// [MON-FIX-01] راجع DECISIONS.md وservices/error-alert.js. بيئة الاختبار لا
// تضبط RESEND_API_KEY ولا ALERT_EMAIL — هذا الاختبار يثبت أن alertError()
// بهذه الحالة (نفس حالة أي بيئة لم تُعِدّ التنبيهات بعد) لا يرمي استثناءً
// أبداً ولا يعلّق الاستدعاء، ويرجع false بوضوح. لا يغطي هذا الاختبار مسار
// الإرسال الفعلي عبر الشبكة (يحتاج RESEND_API_KEY حقيقياً) ولا كبح التكرار —
// كلاهما بنفس منطق services/email.js الموجود أصلاً وغير المُختبَر شبكياً هنا
// أيضاً؛ الخاصية الجوهرية للسلامة (لا يفشل الاستدعاء الأصلي أبداً) هي المُثبَتة.

const { test, expect } = require('@playwright/test');
const http = require('http');
const express = require('express');
const { alertError, shouldSend, lastSentAt, computeDedupKey } = require('../services/error-alert');

// نفس نمط freshRequire بـtests/email-prod-safety.spec.js: يستورد الوحدة طازجة
// بمتغيرات بيئة مختلفة (تفريغ الكاش أولاً)، ويعيد كل شيء لحالته الطبيعية بعدها.
// config/env.js يُحسَب مرة واحدة عند أول require (نفس ملاحظة email-prod-safety.spec.js
// بالضبط) — يجب تفريغ كاشه أيضاً، وإلا يبقى error-alert.js يقرأ RESEND_API_KEY/
// ALERT_EMAIL القديمين المُخزَّنين بالكاش (غالباً فارغين ببيئة الاختبار)
// بغض النظر عن متغيرات البيئة الجديدة المضبوطة هنا.
function freshRequire(modulePath, envOverrides) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  delete require.cache[require.resolve('../config/env')];
  const prev = {};
  for (const [k, v] of Object.entries(envOverrides)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const mod = require(modulePath);
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return mod;
}

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

// [SEC-FIX-ALERTKEYDOS-01] راجع DECISIONS.md — مفتاح كبح التكرار كان مبنياً
// من err.message مباشرة. لأخطاء JSON مشوَّه (body-parser)، Node يُضمِّن
// مقتطفاً حرفياً من محتوى الطلب برسالة الخطأ — مهاجم غير مصادَق يقدر يغيّر
// بايتات الجسم بكل طلب فيتجاوز الكبح كلياً. هذا الاختبار يبني نفس الخطأ
// الحقيقي الذي ينتجه body-parser فعلاً (لا كائن Error مصطنَع يدوياً) عبر
// تطبيق Express حقيقي مصغَّر، بحمولتين مختلفتين تماماً، ويثبت أن المفتاح
// الناتج متطابق الآن — الكبح يعمل رغم اختلاف محتوى الطلب.
async function triggerRealJsonSyntaxError(app, body) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const req = http.request(
        { port, host: '127.0.0.1', path: '/x', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (res) => { res.on('data', () => {}); res.on('end', () => server.close(() => resolve())); }
      );
      req.end(body);
    });
  });
}

test.describe('[SEC-FIX-ALERTKEYDOS-01] مفتاح الكبح لا يتأثر بمحتوى الطلب — كبح فعلي، لا قابل للتجاوز', () => {
  test('حمولتان JSON مشوَّهتان مختلفتان تماماً من نفس نقطة الفشل الحقيقية (body-parser) تُنتجان نفس المفتاح', async () => {
    let capturedErrors = [];
    const app = express();
    app.use(express.json());
    app.post('/x', (req, res) => res.json({ ok: true }));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      capturedErrors.push(err);
      res.status(400).json({ error: 'bad' });
    });

    await triggerRealJsonSyntaxError(app, '{"a":AAAA_ATTACKER_MARKER_ONE_XYZ}');
    await triggerRealJsonSyntaxError(app, '{"a":BBBB_ATTACKER_MARKER_TWO_QRS}');

    expect(capturedErrors).toHaveLength(2);
    const [err1, err2] = capturedErrors;

    // إثبات أن هذين خطأين حقيقيين مختلفَي الرسالة فعلاً (لا اختبار زائف).
    expect(err1.message).not.toBe(err2.message);
    expect(err1.message).toContain('AAAA');
    expect(err2.message).toContain('BBBB');

    // الإثبات الجوهري: نفس المفتاح رغم اختلاف الرسالة الكامل.
    const key1 = computeDedupKey('API error', err1);
    const key2 = computeDedupKey('API error', err2);
    expect(key1).toBe(key2);

    // وأثر ذلك فعلياً على shouldSend: الحمولة الثانية (خطأ "مختلف" ظاهرياً)
    // مكبوحة الآن، لا مُنبَّهة كل مرة كما كان يحدث قبل الإصلاح.
    const testKey = key1 + '-shouldsend-test-' + Date.now();
    expect(shouldSend(testKey)).toBe(true);
    expect(shouldSend(testKey)).toBe(false);
  });

  test('خطآن حقيقيان مختلفان فعلياً (context مختلف) يبقيان يُنتجان مفاتيح مختلفة — التمييز الحقيقي لم يُفقَد', () => {
    const err = new Error('نفس نوع الخطأ');
    const keyA = computeDedupKey('API error', err);
    const keyB = computeDedupKey('uncaughtException', err);
    expect(keyA).not.toBe(keyB);
  });

  test('نوعا خطأ مختلفان (TypeError مقابل SyntaxError) بنفس context يُنتجان مفاتيح مختلفة', () => {
    const keyType = computeDedupKey('API error', new TypeError('x'));
    const keySyntax = computeDedupKey('API error', new SyntaxError('x'));
    expect(keyType).not.toBe(keySyntax);
  });
});

// [SEC-FIX-ERRORALERTTIMEOUT-01] راجع DECISIONS.md — resend.emails.send() هنا
// كان بلا أي مهلة، بعكس sendOtpEmail (services/email.js). خادم Resend حقيقي
// معلَّق (لا يرد أبداً) كان يعلّق alertError() نفسها للأبد — خطير تحديداً
// لأن process.on('uncaughtException') بـserver.js ينتظر (await) اكتمالها
// صراحة قبل gracefulShutdown(). خادم HTTP حقيقي محلي لا يرد أبداً (نفس أسلوب
// tests/email-prod-safety.spec.js's SEC-FIX-EMAILCANCEL-01)، مع RESEND_BASE_URL
// (مدعوم من حزمة resend نفسها) موجَّه إليه — يحاكي بالضبط "خادم Resend حيّ
// معلَّق فعلياً" بلا الحاجة لتعديل services/error-alert.js لإتاحة baseUrl مخصَّص.
test.describe('[SEC-FIX-ERRORALERTTIMEOUT-01] alertError لا تعلّق أبداً حتى مع خادم Resend معلَّق فعلياً', () => {
  test('خادم Resend حيّ لا يرد أبداً: alertError تُرجع false خلال المهلة المحدَّدة، لا تعلّق للأبد', async () => {
    let serverSawClose = false;
    const server = http.createServer((req) => {
      // لا يردّ أبداً — يحاكي خادم Resend معلَّق بلا استجابة ولا إغلاق.
      req.on('close', () => { serverSawClose = true; });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const { alertError: freshAlertError } = freshRequire('../services/error-alert', {
        RESEND_API_KEY: 're_fake_key_for_alert_timeout_test',
        ALERT_EMAIL: 'alerts@example.com',
        RESEND_BASE_URL: `http://127.0.0.1:${port}`,
        ERROR_ALERT_TIMEOUT_MS: '300',
      });

      const start = Date.now();
      const result = await freshAlertError(
        'unit-test-' + Date.now() + Math.random(),
        new Error('خطأ تجريبي يحاكي uncaughtException')
      );
      const elapsed = Date.now() - start;

      // الإثبات الجوهري: لا تعليق أبدي — ترجع false بوضوح خلال حد زمني
      // ضيّق (حد فضفاض يكفي لتفادي هشاشة توقيت CI مع بقائه بعيداً عن "معلَّق للأبد").
      expect(result).toBe(false);
      expect(elapsed).toBeLessThan(3000);

      // إثبات إضافي (نفس نمط SEC-FIX-EMAILCANCEL-01): الخادم نفسه يرى الاتصال
      // يُغلَق من طرف العميل — الإلغاء حقيقي على مستوى الشبكة، لا مجرد تجاهل
      // الوعد بجافاسكربت بينما الطلب يبقى معلَّقاً بالخلفية.
      await new Promise((r) => setTimeout(r, 800));
      expect(serverSawClose, 'الخادم لم يرَ الاتصال يُغلَق — الطلب بقي معلَّقاً بالخلفية رغم انتهاء المهلة').toBe(true);

      delete require.cache[require.resolve('../services/error-alert')];
      delete require.cache[require.resolve('../services/email')];
      delete require.cache[require.resolve('../config/env')];
      require('../config/env');
    } finally {
      server.close();
    }
  });
});
