// tests/allowed-origins-config.spec.js
// [SEC-FIX-TRUSTPROXY-CLOSED-01] راجع DECISIONS.md — sallehly.onrender.com
// كان مُدرَجاً بكلا قائمتَي config/env.js (ALLOWED_ORIGINS لفحص CSRF،
// IO_CORS_ORIGINS لسماحية Socket.IO) رغم تحقُّق ميداني أن هذا الأصل غير
// قابل للوصول مباشرة إطلاقاً (يرجع "not found") ولا أي عميل حقيقي يستخدمه —
// أصل مسموح ميت يوحي بصلاحية مسار لا يعمل. أُزيل من كلا القائمتين.
//
// اختبار وحدة مباشر (لا يستخدم سيرفر الاختبارات المشترك — webServer بملف
// playwright.config.js يعمل دائماً بـNODE_ENV=test، حيث القائمتان أصلاً
// تحملان النطاقات المحلية لا نطاقات الإنتاج). بنفس أسلوب
// tests/email-prod-safety.spec.js: يستورد config/env.js طازجاً بـ
// NODE_ENV=production لفحص قائمتَي الإنتاج الفعليتين مباشرة.

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshRequireEnv(envOverrides) {
  delete require.cache[require.resolve('../config/env')];

  const prev = {};
  for (const [k, v] of Object.entries(envOverrides)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  const mod = require('../config/env');

  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  return mod;
}

test.describe('[SEC-FIX-TRUSTPROXY-CLOSED-01] sallehly.onrender.com أُزيل من قوائم السماح بالإنتاج — أصل ميت غير قابل للوصول لا يجوز أن يبقى مُدرَجاً', () => {
  test('ALLOWED_ORIGINS بالإنتاج: لا يحمل sallehly.onrender.com، ويحمل النطاقين الحقيقيين فقط', () => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sallehly-origins-test-'));
    const { ALLOWED_ORIGINS } = freshRequireEnv({
      NODE_ENV: 'production',
      DATA_DIR: tmpDataDir,
      JWT_SECRET: 'test_only_prod_env_secret_1234567890ABCDEFGH',
    });

    expect(ALLOWED_ORIGINS).not.toContain('https://sallehly.onrender.com');
    expect(ALLOWED_ORIGINS).toEqual(
      expect.arrayContaining(['https://sallehly.com', 'https://www.sallehly.com'])
    );
    expect(ALLOWED_ORIGINS).toHaveLength(2);

    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../config/env')];
    require('../config/env');
  });

  test('IO_CORS_ORIGINS بالإنتاج: لا يحمل sallehly.onrender.com، ويحمل النطاقين الحقيقيين فقط', () => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sallehly-origins-test-'));
    const { IO_CORS_ORIGINS } = freshRequireEnv({
      NODE_ENV: 'production',
      DATA_DIR: tmpDataDir,
      JWT_SECRET: 'test_only_prod_env_secret_1234567890ABCDEFGH',
    });

    expect(IO_CORS_ORIGINS).not.toContain('https://sallehly.onrender.com');
    expect(IO_CORS_ORIGINS).toEqual(
      expect.arrayContaining(['https://sallehly.com', 'https://www.sallehly.com'])
    );
    expect(IO_CORS_ORIGINS).toHaveLength(2);

    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../config/env')];
    require('../config/env');
  });
});
