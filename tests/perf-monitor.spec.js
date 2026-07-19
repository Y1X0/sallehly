// tests/perf-monitor.spec.js
// يغطي: middleware/perf-monitor.js ([PERF-HARDEN-01]) — تحقّق من أنها
// مُعطّلة تماماً افتراضياً (بلا أي أثر على السلوك الحالي)، وأنها عند
// التفعيل تسجّل فقط الطلبات البطيئة (وليس كل طلب)، بحقول غير حسّاسة فقط.
// اختبار وحدة مباشر على الميدلوير نفسها (لا يحتاج طلبات HTTP فعلية عبر
// السيرفر المشترك بالاختبارات — الميزة مُعطّلة أصلاً بذلك السيرفر).

const { test, expect } = require('@playwright/test');
const { EventEmitter } = require('events');

function freshModule(enabledValue) {
  const modPath = require.resolve('../middleware/perf-monitor');
  delete require.cache[modPath];

  const prevEnabled = process.env.PERF_LOG_ENABLED;
  if (enabledValue === undefined) {
    delete process.env.PERF_LOG_ENABLED;
  } else {
    process.env.PERF_LOG_ENABLED = enabledValue;
  }

  const mod = require('../middleware/perf-monitor');

  // استعادة فورية حتى لا تؤثر على أي require لاحق بنفس عملية الاختبار.
  if (prevEnabled === undefined) delete process.env.PERF_LOG_ENABLED;
  else process.env.PERF_LOG_ENABLED = prevEnabled;

  return mod;
}

test.describe('[PERF-HARDEN-01] middleware/perf-monitor.js', () => {
  test('مُعطّلة تماماً افتراضياً (بلا PERF_LOG_ENABLED) — لا تُضيف أي middleware', () => {
    const { installPerfMonitor, PERF_MONITOR_ENABLED } = freshModule(undefined);
    expect(PERF_MONITOR_ENABLED).toBe(false);

    let useCalled = false;
    const fakeApp = { use: () => { useCalled = true; } };
    installPerfMonitor(fakeApp);
    expect(useCalled).toBe(false);
  });

  test('غير مُفعَّلة أيضاً لأي قيمة غير "true" حرفياً (مثال: "1")', () => {
    const { PERF_MONITOR_ENABLED } = freshModule('1');
    expect(PERF_MONITOR_ENABLED).toBe(false);
  });

  test('عند التفعيل: تسجّل فقط الطلبات التي تجاوزت العتبة، بحقول غير حسّاسة فقط', async () => {
    const prevSlowMs = process.env.PERF_LOG_SLOW_MS;
    process.env.PERF_LOG_SLOW_MS = '10';

    const { installPerfMonitor } = freshModule('true');

    let middleware;
    const fakeApp = { use: (fn) => { middleware = fn; } };
    installPerfMonitor(fakeApp);
    expect(typeof middleware).toBe('function');

    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args);

    try {
      // طلب "بطيء" (يتجاوز عتبة 10ms) — يحمل query string يجب ألا يظهر بالسجل.
      const slowReq = { method: 'GET', originalUrl: '/api/requests?token=shouldNotLeak' };
      const slowRes = new EventEmitter();
      slowRes.statusCode = 200;
      middleware(slowReq, slowRes, () => {});
      await new Promise((resolve) => setTimeout(resolve, 20));
      slowRes.emit('finish');

      // طلب "سريع" (تحت العتبة) — يجب ألا يُسجَّل إطلاقاً.
      const fastReq = { method: 'GET', originalUrl: '/api/meta' };
      const fastRes = new EventEmitter();
      fastRes.statusCode = 200;
      middleware(fastReq, fastRes, () => {});
      fastRes.emit('finish');
    } finally {
      console.log = originalLog;
      if (prevSlowMs === undefined) delete process.env.PERF_LOG_SLOW_MS;
      else process.env.PERF_LOG_SLOW_MS = prevSlowMs;
    }

    const perfLogs = logs.filter((l) => l[0] === '[PERF-SLOW]');
    expect(perfLogs.length).toBe(1);

    const entry = JSON.parse(perfLogs[0][1]);
    expect(entry.method).toBe('GET');
    expect(entry.path).toBe('/api/requests');
    expect(entry.statusCode).toBe(200);
    expect(typeof entry.durationMs).toBe('number');
    expect(entry.durationMs).toBeGreaterThanOrEqual(10);
    // فقط الحقول غير الحسّاسة المتوقّعة — لا شيء إضافي (لا SQL، لا معرّفات مستخدمين).
    expect(Object.keys(entry).sort()).toEqual(['at', 'durationMs', 'method', 'path', 'statusCode'].sort());
  });
});
