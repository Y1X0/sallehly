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
//
// [SEC-FIX-CHATCHOKEPOINT-SCANFIX-01] راجع DECISIONS.md — كان الفحص السابق
// (`FROM\s+messages\b` بمقارنة سطر-بسطر) يتجاوَز بصياغة SQL عادية جداً، لا
// حيلة تحايل متعمَّدة: (1) `JOIN messages` — لا يطابق النمط لأن الكلمة التي
// تلي FROM مباشرة اسم جدول آخر، لا messages، (2) استعلام مقسَّم على أكثر من
// سطر (FROM على سطر، messages على السطر التالي) — المقارنة سطر-بسطر لا تمنح
// \s+ فرصة مطابقة السطر التالي إطلاقاً. الحل: مطابقة FROM أو JOIN معاً، وفحص
// محتوى الملف كاملاً دفعة واحدة (لا سطراً سطراً) — \s+ بجافاسكربت يطابق أصلاً
// فواصل الأسطر، فيغطي الحالتين معاً بلا أي منطق إضافي.
const fs = require('fs');
const path = require('path');

const PATTERN = /\b(?:FROM|JOIN)\s+messages\b/gi;
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

// [SEC-FIX-CHATCHOKEPOINT-SCANFIX-01] راجع DECISIONS.md — منطق الفحص الأساسي
// مُستخرَج كدالة قابلة للاستدعاء المباشر من tests/chat-chokepoint-checker.spec.js
// (فحص شجرة ملفات مؤقتة معزولة، لا المستودع الحقيقي) بدل تنفيذه فوراً بمجرد
// require() لهذا الملف كما كان — ما جعله بلا أي اختبار مباشر إطلاقاً قبل هذا
// الإصلاح. السلوك كـCLI (فحص المستودع الحقيقي، طباعة، exit code) يبقى كما
// هو تماماً أسفل الملف، يعمل فقط عند تنفيذ الملف مباشرة لا عند require().
function scanForViolations(rootDir, selfRelPath) {
  const violations = [];
  for (const file of walk(rootDir, [])) {
    const rel = path.relative(rootDir, file).split(path.sep).join('/');
    if (rel === selfRelPath || ALLOWLIST[rel]) continue;
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    PATTERN.lastIndex = 0;
    let match;
    while ((match = PATTERN.exec(content))) {
      const lineNum = content.slice(0, match.index).split('\n').length;
      violations.push(`${rel}:${lineNum}: ${(lines[lineNum - 1] || '').trim()}`);
    }
  }
  return violations;
}

function printAndExit(violations) {
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
}

if (require.main === module) {
  const ROOT = path.join(__dirname, '..');
  const SELF = path.relative(ROOT, __filename).split(path.sep).join('/');
  printAndExit(scanForViolations(ROOT, SELF));
}

module.exports = { scanForViolations, ALLOWLIST, PATTERN };
