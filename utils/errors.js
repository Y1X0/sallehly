// utils/errors.js
// [SEC-FIX-CHATACCESS-CHOKEPOINT-01] راجع DECISIONS.md — أنواع أخطاء بسيطة
// (بلا أي اعتماد على db/io، آمنة تُستدعى من أي مكان، نفس فلسفة utils/helpers.js)
// تحمل status code معها، حتى تقدر middleware/security.js's apiErrorHandler
// تترجمها لاستجابة نظيفة صحيحة (403 مثلاً) بدل أن تسقط بصمت على استجابة
// 500/400 عامة غير مقصودة. أي دالة مشتركة (مثل utils/db-helpers.js's
// getMessages) تفرض تحققاً أمنياً داخلياً ترمي واحدة من هذه بدل throw new Error()
// خام — الفرق حاسم: خطأ خام يعني "فشل غير متوقَّع" (يُسجَّل، يُنبَّه، يُرجع خطأ
// عام)، بينما ForbiddenError يعني "قرار صلاحية متوقَّع ومقصود" (يُترجَم مباشرة
// لـ403 بلا أي تسجيل/تنبيه إزعاجي — نفس معاملة أخطاء التحقق الأخرى بـ
// apiErrorHandler).
class ForbiddenError extends Error {
  constructor(message = 'لا تملك صلاحية', code = 'AUTH_FORBIDDEN') {
    super(message);
    this.name = 'ForbiddenError';
    this.status = 403;
    this.code = code;
  }
}

// [FEAT-UPLOADQUOTA-01] راجع DECISIONS.md — نفس فلسفة ForbiddenError أعلاه
// بالضبط: قرار متوقَّع ومقصود (تجاوز حصة التخزين)، لا خطأ غير متوقَّع، فيُترجَم
// مباشرة لاستجابة نظيفة بدل المرور بمسار التسجيل/التنبيه العام.
class QuotaExceededError extends Error {
  constructor(message = 'تجاوزت الحد الأقصى المسموح لمساحة التخزين', code = 'STORAGE_QUOTA_EXCEEDED') {
    super(message);
    this.name = 'QuotaExceededError';
    this.status = 413;
    this.code = code;
  }
}

module.exports = { ForbiddenError, QuotaExceededError };
