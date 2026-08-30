// services/error-alert.js
// [MON-FIX-01] راجع DECISIONS.md. تنبيه فوري بالإيميل عند أي خطأ غير متوقع
// فعلياً بالإنتاج — نفس مزوّد OTP تماماً (Resend، services/email.js)، فلا
// تبعية جديدة ولا حساب/مفتاح جديد: يعيد استخدام RESEND_API_KEY/RESEND_FROM
// الموجودين أصلاً، ويرسل إلى ALERT_EMAIL (أو ADMIN_EMAIL كبديل).
//
// كبح التكرار بالذاكرة: نفس مصدر الخطأ + نفس الرسالة لا يُرسِل تنبيهاً ثانياً
// خلال 15 دقيقة. خطأ يتكرر بكل طلب (bug بمسار شائع مثلاً) لن يُغرق البريد
// بمئات الرسائل المتطابقة — أول ظهور يُنبِّه فوراً وهذا يكفي للمراقبة.
//
// لا يرمي استثناءً أبداً للمستدعي (نفس فلسفة uploadBackupOffsite بـ
// services/offsite-backup.js) — فشل إرسال التنبيه نفسه لا يجوز أن يُسقط أو
// حتى يُبطئ المسار الذي استدعاه أصلاً.
//
// [SEC-FIX-ERRORALERTTIMEOUT-01] راجع DECISIONS.md — تحديث لتوثيق سابق: كان
// موثَّقاً بـSEC-FIX-EMAILCANCEL-01 أن resend.emails.send() هنا "لا يحجب
// استجابة أي طلب مستخدم" فلا حاجة لمهلة — هذا صحيح لمستدعي middleware/security.js
// (apiErrorHandler، fire-and-forget فعلاً) لكنه **غير صحيح** لمستدعي server.js
// الآخر: معالج process.on('uncaughtException') ينتظر (await) اكتمال alertError()
// صراحة قبل gracefulShutdown() (بنيّة واضحة: العملية قد تخرج خلال أجزاء من
// الثانية، fire-and-forget هناك تحديداً قد يعني عدم اكتمال طلب الشبكة إطلاقاً).
// بلا مهلة هنا، انقطاع/تعليق بطرف Resend بالضبط لحظة uncaughtException حقيقي
// (حالة العملية غير موثوقة أصلاً) كان يعلّق alertError() للأبد، فيؤخّر
// gracefulShutdown() (وبالتالي إعادة تشغيل العملية من منصة النشر) بلا أي حد
// زمني — بالضبط أثناء اللحظة التي يكون التعافي السريع فيها أهم ما يكون.
// withTimeout (15 ثانية، نفس مهلة OTP) تضمن أن alertError() نفسها لا تعلّق
// أبداً، بغض النظر عن أي مستدعٍ.

const { Resend } = require('resend');
const { RESEND_API_KEY, RESEND_FROM, ALERT_EMAIL, IS_PROD } = require('../config/env');
// [SEC-FIX-ERRORALERTTIMEOUT-01] راجع DECISIONS.md — withTimeout مصدَّرة من
// services/email.js أصلاً (SEC-FIX-EMAILTIMEOUT-01/SEC-FIX-EMAILCANCEL-01)،
// يُعاد استخدامها هنا حرفياً بدل تكرار نفس آلية Promise.race+AbortController.
const { withTimeout } = require('./email');

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
// نفس مهلة OTP بالضبط (services/email.js) — رسالة تنبيه خفيفة، لا سبب لمهلة
// مختلفة. قابلة للتجاوز عبر ERROR_ALERT_TIMEOUT_MS (نفس نمط PERF_LOG_SLOW_MS
// بـmiddleware/perf-monitor.js) فقط لتمكين اختبار السلوك الفعلي بمهلة قصيرة
// بلا انتظار 15 ثانية حقيقية بكل تشغيلة اختبارات — الإنتاج لا يضبط هذا المتغيّر
// إطلاقاً فيبقى على 15000 دائماً.
const ALERT_SEND_TIMEOUT_MS = Number(process.env.ERROR_ALERT_TIMEOUT_MS) || 15000;
const COOLDOWN_MS = 15 * 60 * 1000;
const lastSentAt = new Map();

// [SEC-FIX-ERRORALERTMAP-01] راجع DECISIONS.md — لم يكن هناك أي حذف/تنظيف
// إطلاقاً لأي مفتاح بهذه الخريطة. مفتاح كل إدخال يحمل نص رسالة الخطأ نفسها
// (حتى 300 حرف) — أي خطأ تختلف رسالته قليلاً بين حدوث وآخر (مثلاً تتضمن ID
// أو قيمة مُدخلة من المستخدم) كان يُنشئ مفتاحاً جديداً يبقى للأبد طوال عمر
// العملية. تنظيف انتهازي (opportunistic) بكل استدعاء بدل مؤقّت (setInterval)
// منفصل — لا حاجة لتبعية زمنية إضافية، وحجم الخريطة أصلاً صغير (عدد أنواع
// الأخطاء المميّزة، لا عدد الطلبات)، فالتكلفة مهملة.
function pruneExpired(now) {
  for (const [key, ts] of lastSentAt) {
    if (now - ts >= COOLDOWN_MS) lastSentAt.delete(key);
  }
}

function shouldSend(key) {
  const now = Date.now();
  pruneExpired(now);
  const last = lastSentAt.get(key);
  if (last && now - last < COOLDOWN_MS) return false;
  lastSentAt.set(key, now);
  return true;
}

// context: نص قصير يوضّح مصدر الخطأ (مثال: 'API error', 'uncaughtException')
async function alertError(context, err) {
  if (!resend || !ALERT_EMAIL) return false;

  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : '';
  const key = `${context}:${message}`.slice(0, 300);
  if (!shouldSend(key)) return false;

  // [SEC-FIX-ERRORALERTTIMEOUT-01] راجع DECISIONS.md وتعليق أعلى الملف —
  // نفس نمط sendOtpEmail (services/email.js) حرفياً: AbortController حقيقي
  // + withTimeout، بدل resend.emails.send() خام بلا أي مهلة.
  const controller = new AbortController();
  try {
    await withTimeout(resend.emails.send({
      from: RESEND_FROM,
      to: ALERT_EMAIL,
      subject: `⚠️ صلّحلي — خطأ بالسيرفر: ${context}`,
      html: `
        <div dir="rtl" style="font-family:sans-serif;max-width:600px;">
          <p><b>المصدر:</b> ${context}</p>
          <p><b>الوقت:</b> ${new Date().toISOString()}</p>
          <p><b>البيئة:</b> ${IS_PROD ? 'production' : 'development'}</p>
          <pre style="white-space:pre-wrap;background:#f4f4f4;padding:12px;border-radius:8px;">${(stack || message || '').slice(0, 4000)}</pre>
          <p style="color:#888;font-size:12px;">لن يُرسَل تنبيه آخر لنفس الخطأ خلال ١٥ دقيقة.</p>
        </div>
      `
    }, { signal: controller.signal }), ALERT_SEND_TIMEOUT_MS, 'error alert send timeout', () => controller.abort());
    return true;
  } catch (e) {
    console.error('[MON-FIX-01] فشل إرسال تنبيه الخطأ نفسه:', e.message);
    return false;
  }
}

// shouldSend وlastSentAt مصدَّرتان فقط لتمكين اختبار مباشر لكبح التكرار
// وتنظيف المفاتيح منتهية الصلاحية بلا انتظار حقيقي لـ15 دقيقة أو حاجة
// لـRESEND_API_KEY حقيقي (نفس فلسفة تصدير withTimeout من services/email.js).
module.exports = { alertError, shouldSend, lastSentAt };
