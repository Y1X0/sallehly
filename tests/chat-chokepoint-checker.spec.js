// tests/chat-chokepoint-checker.spec.js
// [SEC-FIX-CHATCHOKEPOINT-SCANFIX-01] راجع DECISIONS.md — scripts/check-chat-content-chokepoint.js
// (فحص CI يمنع قراءة محتوى الشات خارج utils/db-helpers.js) لم يكن له أي
// اختبار مباشر إطلاقاً قبل هذا الإصلاح. يثبت هذا الملف: (1) الثغرتين
// الموثَّقتين بجولة التدقيق العاشرة (`JOIN messages`، واستعلام مقسَّم على أكثر
// من سطر) أصبحتا تُكتشَفان بعد الإصلاح، (2) `FROM messages` العادي (السلوك
// الأصلي) لا يزال يُكتشَف، (3) ALLOWLIST لا يزال يُستثنى فعلياً، (4) ملف بلا
// أي مطابقة يمر بأمان بلا مخالفات.
//
// يستدعي scanForViolations() المُصدَّرة مباشرة على شجرة ملفات مؤقتة معزولة —
// لا المستودع الحقيقي — حتى لا يعتمد الاختبار على حالة الكود الفعلي الحالي.

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanForViolations } = require('../scripts/check-chat-content-chokepoint');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sallehly-chokepoint-test-'));
}

test.describe('[SEC-FIX-CHATCHOKEPOINT-SCANFIX-01] scanForViolations — فحص الثغرات الموثَّقة والسلوك الأصلي', () => {
  test('FROM messages بسطر واحد (السلوك الأصلي) لا يزال يُكتشَف', () => {
    const dir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'bad-route.js'), "db.prepare('SELECT body FROM messages WHERE id=?').get(id);\n");
      const violations = scanForViolations(dir, '');
      expect(violations.length).toBe(1);
      expect(violations[0]).toContain('bad-route.js:1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('JOIN messages (ثغرة موثَّقة بجولة التدقيق العاشرة) يُكتشَف الآن', () => {
    const dir = makeTmpDir();
    try {
      fs.writeFileSync(
        path.join(dir, 'bad-join.js'),
        "db.prepare('SELECT r.id FROM requests r JOIN messages m ON m.request_id=r.id').all();\n"
      );
      const violations = scanForViolations(dir, '');
      expect(violations.length).toBe(1);
      expect(violations[0]).toContain('bad-join.js:1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('استعلام مقسَّم على أكثر من سطر (ثغرة موثَّقة بجولة التدقيق العاشرة) يُكتشَف الآن', () => {
    const dir = makeTmpDir();
    try {
      fs.writeFileSync(
        path.join(dir, 'bad-multiline.js'),
        "db.prepare(`\n  SELECT body FROM\n  messages WHERE id=?\n`).get(id);\n"
      );
      const violations = scanForViolations(dir, '');
      expect(violations.length).toBe(1);
      // المطابقة تبدأ عند FROM (السطر 2: `  SELECT body FROM`) — match.index
      // يشير لبداية المطابقة، لا لموضع "messages" نفسها بالسطر التالي.
      expect(violations[0]).toContain('bad-multiline.js:2');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ملفات ALLOWLIST تبقى مستثناة رغم احتوائها على استعلام مباشر', () => {
    const dir = makeTmpDir();
    try {
      fs.mkdirSync(path.join(dir, 'utils'));
      fs.writeFileSync(
        path.join(dir, 'utils', 'db-helpers.js'),
        "db.prepare('SELECT body FROM messages WHERE id=?').get(id);\n"
      );
      const violations = scanForViolations(dir, '');
      expect(violations.length).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ملف بلا أي مطابقة يمر بأمان بلا مخالفات', () => {
    const dir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'unrelated.js'), "db.prepare('SELECT * FROM users WHERE id=?').get(id);\n");
      const violations = scanForViolations(dir, '');
      expect(violations.length).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
