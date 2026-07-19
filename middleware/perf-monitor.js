// middleware/perf-monitor.js
// ==========================================================================
// [PERF-HARDEN-01] مراقبة أداء دائمة اختيارية وخفيفة الوزن — مُعطّلة تماماً
// افتراضياً. هذه أداة مختلفة عن middleware/perf-trace.js (أداة تشخيص مؤقتة
// مخصّصة لجمع أدلة السبب الجذري، من المفترض إزالتها لاحقاً) — هذه الأداة
// مصمّمة لتبقى بالكود بشكل دائم كخيار تشغيلي بسيط.
//
// ماذا تفعل: تقيس مدة كل طلب HTTP فقط، وتسجّل سطراً واحداً (بادئته
// [PERF-SLOW]) فقط للطلبات التي تجاوزت عتبة زمنية معيّنة — وليس كل طلب،
// حتى لا تُغرق السجلات ولا تُضيف عبئاً محسوساً على كل استجابة.
//
// ما لا تسجّله (عمداً): لا نص استعلامات SQL، لا محتوى الطلب/الرد، لا هيدرز
// المصادقة، لا أي معرّف مستخدم أو بيانات شخصية — فقط: الطريقة (method)،
// المسار بدون query string، رمز الحالة، والمدة بالميلي ثانية.
//
// التفعيل: متغيّر بيئة PERF_LOG_ENABLED=true فقط (أي قيمة أخرى أو غيابه
// كلياً = مُعطّل تماماً، بلا أي أثر على الإنتاج الحالي ما لم يُفعَّل صراحةً).
// العتبة قابلة للضبط عبر PERF_LOG_SLOW_MS (اختياري، الافتراضي 800ms).
// ==========================================================================

const ENABLED = process.env.PERF_LOG_ENABLED === 'true';
const SLOW_MS = Number(process.env.PERF_LOG_SLOW_MS) || 800;

/** Express middleware اختياري — لا تأثير إطلاقاً إن لم يُفعَّل عبر البيئة. */
function installPerfMonitor(app) {
  if (!ENABLED) return;

  app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      if (durationMs < SLOW_MS) return;

      console.log('[PERF-SLOW]', JSON.stringify({
        method: req.method,
        path: req.originalUrl.split('?')[0],
        statusCode: res.statusCode,
        durationMs: Number(durationMs.toFixed(1)),
        at: new Date().toISOString(),
      }));
    });

    next();
  });
}

module.exports = { installPerfMonitor, PERF_MONITOR_ENABLED: ENABLED };
