// middleware/perf-trace.js
// ==========================================================================
// [TEMP-PERF-TRACE] أداة قياس مؤقتة فقط — لا تُغيّر أي منطق أو سلوك بالتطبيق.
// الهدف الوحيد: جمع أدلة حقيقية من الإنتاج لتحديد السبب الجذري الفعلي
// لرسالة "الخادم يستغرق وقتاً" (انظر تقرير Root Cause Investigation).
//
// ماذا تسجّل (لكل طلب، سطر JSON واحد بادئته [PERF-TRACE] على stdout):
//   - وقت البداية/النهاية، اسم الـendpoint، مدة التنفيذ الكلية (durationMs)
//   - كل استعلام SQLite نُفِّذ أثناء هذا الطلب (النص المختصر + المدة، ownQueries)
//   - "blockedByOthersMs": مجموع مدة استعلامات طلبات أخرى نُفِّذت أثناء
//     انتظار هذا الطلب — أي مقدار الوقت الذي حجبه طلب/مستخدم آخر عن هذا الطلب
//   - "queueOrNetworkGapMs": الفارق بين لحظة إرسال Flutter للطلب فعلياً
//     (هيدر X-Client-Sent-At) ولحظة بدء السيرفر معالجته — يلتقط الحجب
//     الذي يسبق حتى وصول الطلب لهذا الـmiddleware نفسه (حالة لا يستطيع
//     blockedByOthersMs التقاطها لأنها تسبق وجود correlationId أصلاً)
//   - "eventLoopHealthSnapshotMs": مؤشر عام (وليس محسوباً لهذا الطلب فقط)
//     لصحة event loop الكلية بلحظة انتهاء هذا الطلب
//   - "coldStart": هل هذا أول طلب منذ إقلاع العملية، وفجوة الخمول قبله
//   - "retryAttempt": رقم محاولة الإعادة (من هيدر X-Retry-Attempt الذي يرسله Flutter)
//   - correlationId: يربط سجل الـbackend بسجل Flutter لنفس الطلب بالضبط
//
// كيف تُزال لاحقاً: احذف هذا الملف، واحذف استدعاءي installPerfTrace()/
// wrapDbForPerfTrace() و مسار /_debug/client-log من server.js. لا تغييرات
// أخرى بأي مكان — كل التغييرات معزولة بهذا الملف + سطرين استدعاء بـserver.js.
// ==========================================================================

const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');
const { monitorEventLoopDelay } = require('perf_hooks');

const requestContext = new AsyncLocalStorage();

// مراقب حجب event loop الرسمي المدمج بـNode (لا يغيّر أي سلوك — قياس فقط).
// resolution=10 يعني يأخذ عيّنة كل 10ms، فيلتقط أي تجمّد يفوق ~10ms تقريباً.
const eventLoopMonitor = monitorEventLoopDelay({ resolution: 10 });
eventLoopMonitor.enable();

// سجل دوّار لكل استعلامات SQLite الأخيرة عبر كل الطلبات (لإسناد الحجب
// عبر الطلبات المتداخلة) — سعة محدودة حتى لا ينمو بلا حدود بذاكرة العملية.
const MAX_QUERY_LOG = 5000;
const recentQueries = [];
function pushQuery(entry) {
  recentQueries.push(entry);
  if (recentQueries.length > MAX_QUERY_LOG) recentQueries.shift();
}

// أول طلب منذ إقلاع العملية = مؤشر قوي على Cold Start (سواء كان سبب
// الإقلاع نوم Render أو إعادة نشر عادية — كلاهما "أول طلب بعد خمول").
const PROCESS_START_AT = Date.now();
let lastRequestEndedAt = null;
let requestsHandledSinceBoot = 0;

/** يلتف حول db.prepare() ليقيس مدة .get()/.all()/.run() فقط — بلا أي تغيير
 * بالسلوك: نفس القيم المُرجَعة، نفس رمي الأخطاء، بنفس الترتيب تماماً. */
function wrapDbForPerfTrace(db) {
  const originalPrepare = db.prepare.bind(db);
  db.prepare = function (sql) {
    const stmt = originalPrepare(sql);
    const shortSql = String(sql).replace(/\s+/g, ' ').trim().slice(0, 140);

    for (const method of ['get', 'all', 'run']) {
      const original = stmt[method].bind(stmt);
      stmt[method] = function (...args) {
        const ctx = requestContext.getStore();
        const t0 = process.hrtime.bigint();
        try {
          return original(...args);
        } finally {
          const t1 = process.hrtime.bigint();
          const durationMs = Number(t1 - t0) / 1e6;
          pushQuery({
            atMs: Date.now(),
            durationMs,
            sql: shortSql,
            method,
            correlationId: ctx ? ctx.correlationId : null,
          });
          if (ctx) {
            ctx.queries.push({ sql: shortSql, method, durationMs: Number(durationMs.toFixed(3)) });
          }
        }
      };
    }
    return stmt;
  };
  return db;
}

/** Express middleware — يجب تركيبه أولاً قبل أي middleware/route آخر. */
function installPerfTrace(app) {
  app.use((req, res, next) => {
    const correlationId =
      req.headers['x-request-id'] || crypto.randomUUID();
    const retryAttempt = req.headers['x-retry-attempt']
      ? Number(req.headers['x-retry-attempt'])
      : 0;

    const startedAtMs = Date.now();
    const t0 = process.hrtime.bigint();

    // [مهم] الفارق الحقيقي بين "لحظة إرسال Flutter للطلب فعلياً" و"لحظة
    // بدء هذا الـmiddleware بمعالجته" — هذا الـmiddleware نفسه كود JS لا يمكنه
    // العمل إلا بعد أن يصبح event loop حراً، فلو كان محجوباً باستعلام طلب آخر،
    // startedAtMs هنا سيكون متأخراً بنفس مقدار الحجب دون أن يظهر ذلك بأي
    // قياس داخلي — لذا queueOrNetworkGapMs (المحسوبة أدناه من هيدر يرسله
    // Flutter وقت إرسال الطلب فعلياً) هي الدليل غير المباشر الوحيد على هذا
    // النوع من الحجب حين لا يوجد طلب آخر "مشتبه به" واضح بنفس السجل.
    const clientSentAtHeader = req.headers['x-client-sent-at'];
    const clientSentAtMs = clientSentAtHeader ? Number(clientSentAtHeader) : null;
    const queueOrNetworkGapMs =
      clientSentAtMs && Number.isFinite(clientSentAtMs)
        ? startedAtMs - clientSentAtMs
        : null;

    const idleGapMs = lastRequestEndedAt ? startedAtMs - lastRequestEndedAt : null;
    const isFirstRequestSinceBoot = requestsHandledSinceBoot === 0;
    requestsHandledSinceBoot += 1;

    const ctx = { correlationId, queries: [] };

    res.setHeader('X-Correlation-Id', correlationId);

    res.on('finish', () => {
      const t1 = process.hrtime.bigint();
      const durationMs = Number(t1 - t0) / 1e6;
      const endedAtMs = Date.now();
      lastRequestEndedAt = endedAtMs;

      // مجموع مدة استعلامات طلبات أخرى (correlationId مختلف) نُفِّذت أثناء
      // نافذة هذا الطلب الزمنية بالضبط — أي "كم من الوقت حجبني طلب آخر".
      let blockedByOthersMs = 0;
      for (const q of recentQueries) {
        if (
          q.correlationId !== correlationId &&
          q.atMs >= startedAtMs &&
          q.atMs <= endedAtMs
        ) {
          blockedByOthersMs += q.durationMs;
        }
      }

      const entry = {
        correlationId,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        statusCode: res.statusCode,
        durationMs: Number(durationMs.toFixed(1)),
        startedAt: new Date(startedAtMs).toISOString(),
        endedAt: new Date(endedAtMs).toISOString(),
        queueOrNetworkGapMs,
        retryAttempt,
        coldStart: {
          isFirstRequestSinceBoot,
          idleGapMs,
          processUptimeMs: startedAtMs - PROCESS_START_AT,
        },
        ownQueries: ctx.queries,
        ownQueriesTotalMs: Number(
          ctx.queries.reduce((a, q) => a + q.durationMs, 0).toFixed(1)
        ),
        blockedByOthersMs: Number(blockedByOthersMs.toFixed(1)),
        // [عام، منذ إقلاع العملية — ليس محسوباً لهذا الطلب تحديداً] مؤشر
        // صحة event loop الكلي بنفس لحظة انتهاء هذا الطلب. مفيد كسياق عام
        // (هل العملية بأكملها كانت تعاني حجباً متكرراً بهذه الفترة) — الدليل
        // المحدَّد فعلياً لهذا الطلب بالذات هو blockedByOthersMs وqueueOrNetworkGapMs.
        eventLoopHealthSnapshotMs: {
          maxLagSinceBoot: Number((eventLoopMonitor.max / 1e6).toFixed(1)),
          meanLagSinceBoot: Number((eventLoopMonitor.mean / 1e6).toFixed(1)),
        },
      };

      console.log('[PERF-TRACE]', JSON.stringify(entry));
    });

    requestContext.run(ctx, next);
  });
}

/** endpoint خفيف يستقبل أحداث تتبّع من تطبيق Flutter (بداية طلب/نهايته من
 * منظور العميل، إعادة محاولة، ظهور البانر) — يُسجَّلها بنفس صيغة الـbackend
 * (بادئة [PERF-TRACE]) حتى تُقرأ من نفس سجل Render مباشرة، مربوطة بنفس
 * correlationId. لا مصادقة (endpoint مؤقت للقياس فقط)، لا تأثير على أي جدول
 * بقاعدة البيانات، لا استجابة بها بيانات حساسة. */
function clientLogRoute(req, res) {
  const body = req.body || {};
  console.log(
    '[PERF-TRACE-CLIENT]',
    JSON.stringify({
      atServer: new Date().toISOString(),
      correlationId: body.correlationId || null,
      event: body.event || 'unknown',
      ...body,
    })
  );
  res.status(204).end();
}

module.exports = { installPerfTrace, wrapDbForPerfTrace, clientLogRoute };
