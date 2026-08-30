// tests/email-prod-safety.spec.js
// [PERF-HARDEN-03] يثبت أن services/email.js لا يُعيد "نجاح" وهمياً بالإنتاج
// عند غياب RESEND_API_KEY — قبل هذا الإصلاح، كان يطبع الكود على console
// ويرجع true بلا أي شرط IS_PROD، فيبدو تسجيل/إعادة تعيين كلمة سر ناجحاً
// بالسجلات بينما المستخدم لن يستلم أي إيميل حقيقي إطلاقاً.
//
// اختبار وحدة مباشر (لا يستخدم سيرفر الاختبارات المشترك — يستورد الوحدة
// طازجة بمتغيرات بيئة مختلفة كل مرة) بنفس أسلوب tests/perf-monitor.spec.js.

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshRequire(modulePath, envOverrides) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  // config/env.js يُحسَب مرة واحدة عند أول require، ويُنشئ مجلدات DATA_DIR —
  // يجب تفريغ الكاش له أيضاً حتى تُطبَّق متغيرات البيئة الجديدة.
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

test.describe('[PERF-HARDEN-03] services/email.js — لا نجاح وهمي بالإنتاج بلا RESEND_API_KEY', () => {
  test('بالإنتاج (NODE_ENV=production) بلا RESEND_API_KEY: sendOtpEmail يرجع false', async () => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sallehly-email-prod-test-'));
    const { sendOtpEmail } = freshRequire('../services/email', {
      NODE_ENV: 'production',
      RESEND_API_KEY: '',
      JWT_SECRET: 'test_only_prod_env_secret_1234567890ABCDEFGH',
      DATA_DIR: tmpDataDir,
    });

    const result = await sendOtpEmail('someone@example.com', '123456', 'مستخدم');
    expect(result).toBe(false);

    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    // إعادة الوحدتين لحالتهما الطبيعية لأي اختبار لاحق بنفس عملية Playwright.
    delete require.cache[require.resolve('../services/email')];
    delete require.cache[require.resolve('../config/env')];
    require('../config/env');
  });

  test('بالتطوير/الاختبار (NODE_ENV=test) بلا RESEND_API_KEY: يبقى السلوك القديم (طباعة + true)', async () => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sallehly-email-dev-test-'));
    const { sendOtpEmail } = freshRequire('../services/email', {
      NODE_ENV: 'test',
      RESEND_API_KEY: '',
      DATA_DIR: tmpDataDir,
    });

    const result = await sendOtpEmail('someone@example.com', '123456', 'مستخدم');
    expect(result).toBe(true);

    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../services/email')];
    delete require.cache[require.resolve('../config/env')];
    require('../config/env');
  });
});

// [SEC-FIX-EMAILTIMEOUT-01] راجع DECISIONS.md — resend.emails.send() بلا أي
// مهلة، فانقطاع/تعليق بطرف Resend كان يعلّق /auth/forgot-password أو
// /auth/register بأكمله للأبد (كلاهما ينتظر sendOtpEmail قبل أي رد). محاكاة
// خادم Resend حيّ معلَّق فعلياً تتطلّب خادم HTTP وهمي حقيقي — خارج نطاق هذا
// الإصلاح؛ الاختبار هنا يثبت الآلية الفعلية المُستخدَمة (withTimeout) مباشرة:
// وعد لا يُحل أبداً (يحاكي طلب شبكة معلَّق حقيقياً) يجب أن يُرفَض خلال الحد
// الزمني المحدَّد، لا أن يعلّق منتظِره للأبد.
test.describe('[SEC-FIX-EMAILTIMEOUT-01] withTimeout يمنع تعليقاً أبدياً لوعد لا يُحل أبداً', () => {
  test('وعد لا يُحل أبداً (يحاكي اتصال Resend معلَّق) يُرفَض خلال الحد الزمني المحدَّد، لا أن يعلّق للأبد', async () => {
    const { withTimeout } = require('../services/email');
    const neverResolves = new Promise(() => {}); // يحاكي fetch بلا مهلة، معلَّق حرفياً للأبد

    const start = Date.now();
    let threw = false;
    try {
      await withTimeout(neverResolves, 300, 'test timeout');
    } catch (e) {
      threw = true;
      expect(e.message).toBe('test timeout');
    }
    const elapsed = Date.now() - start;

    expect(threw).toBe(true);
    // يثبت أنه رُفض فعلاً بسبب المهلة (~300ms) لا بسبب طول عشوائي — حد فضفاض
    // يكفي لتفادي هشاشة توقيت بيئة CI مع بقائه بعيداً كل البعد عن "معلَّق للأبد".
    expect(elapsed).toBeLessThan(2000);
  });

  test('وعد ينجح بسرعة قبل المهلة: withTimeout يُرجع نتيجته الفعلية بلا أي رفض', async () => {
    const { withTimeout } = require('../services/email');
    const result = await withTimeout(Promise.resolve('ok'), 5000, 'should not fire');
    expect(result).toBe('ok');
  });
});

// [SEC-FIX-EMAILCANCEL-01] راجع DECISIONS.md — نطاق متروك عمداً بـ
// SEC-FIX-EMAILTIMEOUT-01 أعلاه: withTimeout وحدها تحدّ فقط زمن انتظار
// المستدعي، لا تُلغي طلب fetch الأصلي المهجور فعلياً. هذا الاختبار يستخدم
// خادم HTTP حقيقي محلي لا يرد أبداً (يحاكي بالضبط "خادم Resend حيّ معلَّق
// فعلياً" الذي وصفه SEC-FIX-EMAILTIMEOUT-01 كخارج نطاقه وقتها) — يثبت أن
// الاتصال الحقيقي يُغلَق فعلاً من طرف العميل عند انتهاء المهلة، لا أن يبقى
// معلَّقاً بالخلفية حتى بعد أن يستأنف المستدعي.
test.describe('[SEC-FIX-EMAILCANCEL-01] onTimeout يُلغي طلب fetch الأصلي فعلياً، لا يتركه معلَّقاً بالخلفية', () => {
  test('AbortController مُمرَّر لـresend.emails.send عبر signal يُغلق الاتصال الحقيقي فعلاً عند انتهاء المهلة', async () => {
    const http = require('http');
    const { Resend } = require('resend');
    const { withTimeout } = require('../services/email');

    let serverSawClose = false;
    const server = http.createServer((req, res) => {
      // لا يردّ أبداً — يحاكي خادم Resend معلَّق فعلياً بلا استجابة ولا إغلاق.
      req.on('close', () => { serverSawClose = true; });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const resend = new Resend('re_fake_key_for_cancel_test', { baseUrl: `http://127.0.0.1:${port}` });
      const controller = new AbortController();

      const start = Date.now();
      let threw = false;
      try {
        await withTimeout(
          resend.emails.send({ from: 'x@example.com', to: 'x@example.com', subject: 'x', html: 'x' }, { signal: controller.signal }),
          200,
          'test cancel timeout',
          () => controller.abort()
        );
      } catch (e) {
        threw = true;
        expect(e.message).toBe('test cancel timeout');
      }
      const elapsed = Date.now() - start;

      expect(threw).toBe(true);
      expect(elapsed).toBeLessThan(2000);

      // الإثبات الحقيقي: الخادم نفسه يرى الاتصال يُغلَق من طرف العميل — دليل
      // أن الطلب أُلغي فعلياً على مستوى الشبكة، لا مجرد تجاهل الوعد بجافاسكربت
      // بينما الاتصال الحقيقي يبقى مفتوحاً بالخلفية. مهلة قصيرة إضافية لإعطاء
      // حدث 'close' فرصة الوصول (قد يصل بعد رفض withTimeout بجزء من الثانية).
      await new Promise((r) => setTimeout(r, 300));
      expect(serverSawClose, 'الخادم لم يرَ الاتصال يُغلَق — الطلب بقي معلَّقاً بالخلفية رغم انتهاء المهلة').toBe(true);
    } finally {
      server.close();
    }
  });
});
