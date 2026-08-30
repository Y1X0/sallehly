#!/usr/bin/env node
// scripts/check-chat-content-chokepoint.js
// [SEC-FIX-CHATACCESS-CHOKEPOINT-01] راجع DECISIONS.md — بديل رخيص عن قاعدة
// ESLint حقيقية (المشروع لا يملك ESLint أصلاً؛ تبنّيه فقط لهذا الفحص كان
// استثماراً غير متناسب مع الحجم الفعلي للمشكلة). هذا سكربت فحص نصّي بسيط:
// يفشل CI لو ظهر استعلام SQL مباشر على جدول messages (`FROM messages`) بأي
// ملف خارج utils/db-helpers.js (نقطة الوصول الوحيدة المفروضة لقراءة محتوى
// محادثة — راجع getMessages/getChatsList/getMessageForReport هناك) أو
// القائمة المسموحة صراحة أدناه. ليس تحليلاً حقيقياً لشجرة الكود (AST) — مجرد
// grep نصّي، يمكن خداعه بإعادة صياغة SQL بشكل غريب — لكنه يمنع الحالة
// الشائعة الفعلية: مطوّر يكتب `db.prepare('SELECT ... FROM messages ...')`
// مباشرة براوت جديد بدل استدعاء الدالة المشتركة، بلا الحاجة لتذكّر أي قاعدة
// غير مكتوبة بأي مكان.
//
// أي إضافة لهذه القائمة تتطلب تعديل هذا الملف نفسه بسبب موثَّق مكتوب — لا
// تجاوز صامت عبر تعليق ignore متفرّق بملف آخر.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SELF = path.relative(ROOT, __filename).split(path.sep).join('/');
const PATTERN = /FROM\s+messages\b/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'tests']);

const ALLOWLIST = {
  'utils/db-helpers.js':
    'نقطة الوصول الوحيدة المقصودة لقراءة محتوى messages — كل استعلام هنا يفرض ' +
    'canAccessRequestChat داخلياً (getMessages) أو بجملة WHERE + فلتر إضافي ' +
    '(getChatsList) أو مقيَّد فعلياً بفحص المُستدعي الوحيد (getMessageForReport).',
  'config/db.js':
    'مهمة صيانة دورية (تنظيف ملفات يتيمة، إصلاح مسار خاطئ) تعمل بمعزل تام عن ' +
    'أي طلب مستخدم — تستخرج أسماء ملفات من body، لا تُعيد أي محتوى لأي عميل.',
  'scripts/loadtest/run.js':
    'سكربت اختبار حمل تشغيلي محلي، خارج مسار الإنتاج بالكامل.',
  'scripts/restore-db.js':
    'سكربت استرجاع نسخة احتياطية يدوي (CLI)، خارج مسار الإنتاج بالكامل.',
  'routes/protected-uploads.routes.js':
    'يجلب request_id فقط (SELECT request_id، لا body) لربط ملف مرفوع بطلبه — ' +
    'لا يُعيد أي محتوى رسالة لأي عميل، فحص الصلاحية الفعلي يقع بعدها مباشرة ' +
    'عبر canAccessRequestChat على الطلب المُستخرَج.',
};

function walk(dir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), files);
    } else if (entry.name.endsWith('.js')) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

const violations = [];
for (const file of walk(ROOT, [])) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (rel === SELF || ALLOWLIST[rel]) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (PATTERN.test(line)) violations.push(`${rel}:${i + 1}: ${line.trim()}`);
  });
}

if (violations.length) {
  console.error('[SEC-FIX-CHATACCESS-CHOKEPOINT-01] استعلام مباشر على جدول messages خارج نقطة الوصول المفروضة:');
  violations.forEach(v => console.error('  ' + v));
  console.error(
    '\nأي قراءة لمحتوى محادثة يجب أن تمر عبر utils/db-helpers.js ' +
    '(getMessages / getChatsList / getMessageForReport) — راجع DECISIONS.md، ' +
    'SEC-FIX-CHATACCESS-CHOKEPOINT-01. استثناء شرعي جديد؟ أضِفه صراحة بقائمة ' +
    'ALLOWLIST بهذا الملف مع سبب مكتوب، لا بتعليق ignore متفرّق.'
  );
  process.exit(1);
} else {
  console.log('[SEC-FIX-CHATACCESS-CHOKEPOINT-01] OK — لا استعلام على messages خارج نقطة الوصول المفروضة.');
}
