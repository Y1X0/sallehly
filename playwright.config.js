// playwright.config.js
// إعداد اختبارات الـ API. يشغّل نسخة منفصلة تمامًا من السيرفر على منفذ مختلف (4001)
// وقاعدة بيانات اختبار منفصلة (data-test/) — لا علاقة لها إطلاقًا بـ data/sallehly.sqlite
// الحقيقية التي يستخدمها السيرفر أثناء التطوير أو الإنتاج.

const { defineConfig } = require('@playwright/test');

const TEST_PORT = 4001;
const TEST_BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1, // تسلسلي بالكامل: يمنع تصادم أكثر من ملف اختبار على نفس الموارد المشتركة (rate limiters وقاعدة بيانات واحدة)
  timeout: 30_000,
  reporter: [['list']],

  use: {
    baseURL: TEST_BASE_URL,
    extraHTTPHeaders: {
      'Accept': 'application/json',
    },
  },

  // يشغّل السيرفر تلقائيًا قبل الاختبارات، وعلى بيئة معزولة بالكامل عن بيئة التطوير/الإنتاج
  webServer: {
    command: 'node tests/clean-test-db.js && node server.js',
    url: TEST_BASE_URL,
    reuseExistingServer: false,
    timeout: 20_000,
    env: {
      NODE_ENV: 'test',
      PORT: String(TEST_PORT),
      DATA_DIR: './data-test',
      JWT_SECRET: 'test_only_secret_not_for_real_use_1234567890',
      // بدون RESEND_API_KEY عمداً: يجعل السيرفر يطبع كود الـ OTP بالـ console بدل إرسال إيميل حقيقي،
      // وهذا بالضبط ما تحتاجه الاختبارات لاستخراج الكود دون أي اعتماد على شبكة خارجية.
    },
  },
});
