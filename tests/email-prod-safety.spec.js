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
