// tests/clean-test-db.js
// يُشغَّل تلقائيًا قبل كل جلسة اختبارات (عبر playwright.config.js) لحذف قاعدة بيانات
// الاختبار السابقة إن وُجدت، حتى تبدأ كل جلسة اختبار ببيانات نظيفة تمامًا.
//
// ⚠️ هذا السكربت لا يلمس إطلاقًا data/sallehly.sqlite (قاعدة البيانات الحقيقية) —
// فقط مجلد data-test/ المستقل المخصص للاختبارات فقط (راجع DATA_DIR في playwright.config.js).

const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, '..', 'data-test');

if (fs.existsSync(TEST_DATA_DIR)) {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  console.log('[tests] تم حذف قاعدة بيانات الاختبار السابقة:', TEST_DATA_DIR);
} else {
  console.log('[tests] لا توجد قاعدة بيانات اختبار سابقة، بداية نظيفة.');
}
