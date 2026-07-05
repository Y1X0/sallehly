// tests/helpers/db.js
// يفتح اتصالاً منفصلاً بقاعدة بيانات الاختبار (data-test/sallehly.sqlite) فقط —
// لا علاقة له إطلاقاً بقاعدة بيانات الإنتاج/التطوير الحقيقية.
// يُستخدم لاستخراج كود الـ OTP مباشرة بدل الاعتماد على بريد إلكتروني حقيقي أثناء الاختبار.

const path = require('path');
const Database = require('better-sqlite3');

const TEST_DB_PATH = path.join(__dirname, '..', '..', 'data-test', 'sallehly.sqlite');

function openTestDb() {
  return new Database(TEST_DB_PATH, { readonly: false, fileMustExist: true });
}

/**
 * يرجع آخر كود OTP مُرسَل لهذا الإيميل من جدول pending_users.
 * يرمي خطأ واضح لو لم يوجد طلب تسجيل معلّق (يساعد بتشخيص فشل الاختبار بسرعة).
 */
function getPendingOtp(email) {
  const db = openTestDb();
  try {
    const row = db
      .prepare('SELECT otp FROM pending_users WHERE email=? ORDER BY id DESC LIMIT 1')
      .get(email.toLowerCase());
    if (!row) {
      throw new Error(`لا يوجد طلب تسجيل معلّق لهذا الإيميل: ${email} — تأكد أن /auth/register نجح فعلاً قبل استدعاء هذه الدالة`);
    }
    return row.otp;
  } finally {
    db.close();
  }
}

/**
 * تشخيصية فقط: ترجع صف حساب الأدمن كما هو موجود فعلياً بقاعدة بيانات الاختبار
 * (بدون كلمة السر المشفّرة). تُستخدم لمعرفة سبب فشل دخول الأدمن بدل التخمين.
 */
function getAdminDebugInfo() {
  const db = openTestDb();
  try {
    return db.prepare("SELECT id, email, is_active, created_at FROM users WHERE role='admin'").all();
  } finally {
    db.close();
  }
}

module.exports = { openTestDb, getPendingOtp, getAdminDebugInfo, TEST_DB_PATH };
