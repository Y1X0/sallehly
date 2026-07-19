// tests/graceful-shutdown.spec.js
// [PERF-HARDEN-03] يثبت أن السيرفر يستجيب لإشارة SIGTERM (المُرسَلة من منصات
// النشر مثل Render قبل قتل العملية بمهلة سماح) بإغلاق نظيف سريع، بدل تجاهلها
// كلياً (السلوك السابق: لا أي معالج إشارة، فتُقتَل العملية فوراً بلا فرصة
// لإنهاء الطلبات الجارية أو إغلاق قاعدة البيانات). يشغّل سيرفراً حقيقياً
// منفصلاً كعملية فرعية (منفذ/قاعدة بيانات معزولة تماماً عن سيرفر الاختبارات
// المشترك)، يرسل SIGTERM، ويتأكد من خروج نظيف (exit code 0) خلال مهلة معقولة
// (أقل بكثير من مهلة الأمان الداخلية البالغة 10 ثوانٍ).

const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

test('SIGTERM يُنتج إغلاقاً نظيفاً سريعاً (exit code 0)، لا قتلاً فورياً', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sallehly-shutdown-test-'));
  const serverPath = path.join(__dirname, '..', 'server.js');

  const child = spawn('node', [serverPath], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      PORT: '4599',
      JWT_SECRET: 'graceful_shutdown_test_secret_1234567890AB',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stdout += d.toString(); });

  try {
    // انتظر إقلاع السيرفر فعلياً (رسالة الإقلاع بالسجل) قبل إرسال الإشارة.
    await new Promise((resolve, reject) => {
      const start = Date.now();
      const check = setInterval(() => {
        if (stdout.includes('صلّحلي يعمل على')) { clearInterval(check); resolve(); }
        else if (Date.now() - start > 15000) { clearInterval(check); reject(new Error('السيرفر لم يقلع خلال 15 ثانية: ' + stdout)); }
      }, 100);
    });

    const exitPromise = new Promise((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });

    const t0 = Date.now();
    child.kill('SIGTERM');

    const result = await Promise.race([
      exitPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('لم تخرج العملية خلال 8 ثوانٍ من SIGTERM')), 8000)),
    ]);
    const elapsedMs = Date.now() - t0;

    expect(result.code).toBe(0);
    // يجب أن يكون الإغلاق سريعاً فعلياً (لا مجرد الوصول لمهلة الأمان الداخلية 10s)
    expect(elapsedMs).toBeLessThan(5000);
    expect(stdout).toContain('[SHUTDOWN] SIGTERM');
    expect(stdout).toContain('تم الإغلاق النظيف بنجاح');
  } finally {
    try { child.kill('SIGKILL'); } catch (e) {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
