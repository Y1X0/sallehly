// tests/scheduled-jobs-boot.spec.js
// [SCHED-FIX-BOOTRUN-01] راجع DECISIONS.md — config/db.js's أربع مهام دورية
// (نسخ احتياطي 6 ساعات، تنظيف ملفات يتيمة 6 ساعات، تنظيف تسجيلات معلَّقة
// منتهية ساعة، تنظيف إشعارات قديمة 24 ساعة) كانت تنتظر أول فاصل زمني كامل
// قبل أول تنفيذ. على منصّة نشر تُعيد بناء الحاوية بمعدّل أسرع من 6 ساعات،
// هذا يعني أن النسخ الاحتياطي قد لا يُنفَّذ إطلاقاً طوال عمر أي نسخة من
// العملية. هذا الاختبار يثبت مباشرة أن الإصلاح يُشغِّل كل مهمة مرة واحدة
// فور الإقلاع بالإنتاج، لا فقط عند أول فاصل زمني.
//
// اختبار وحدة مباشر (لا يستخدم سيرفر الاختبارات المشترك — webServer بملف
// playwright.config.js يشغّل NODE_ENV=test دائماً، حيث IS_PROD=false ولا
// تُنفَّذ أي من هذه المهام إطلاقاً). يستورد config/db.js طازجاً مرتين على
// قاعدة بيانات مؤقتة معزولة تماماً: مرة بـNODE_ENV=test لتجهيز المخطّط
// وزرع بيانات اختبار (بلا تشغيل أي مهمة — IS_PROD=false)، ثم مرة ثانية
// بـNODE_ENV=production (تحاكي إعادة تشغيل حقيقية) للتحقق من أن كل مهمة
// نُفِّذت فوراً — بنفس أسلوب tests/email-prod-safety.spec.js.

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshRequireDb(envOverrides) {
  delete require.cache[require.resolve('../config/db')];
  delete require.cache[require.resolve('../config/env')];
  delete require.cache[require.resolve('../config/migrate')];

  const prev = {};
  for (const [k, v] of Object.entries(envOverrides)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  const mod = require('../config/db');

  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  return mod;
}

function restoreRealEnv() {
  delete require.cache[require.resolve('../config/db')];
  delete require.cache[require.resolve('../config/env')];
  delete require.cache[require.resolve('../config/migrate')];
}

async function waitUntil(predicate, { timeoutMs = 4000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

test.describe('[SCHED-FIX-BOOTRUN-01] المهام الدورية تُنفَّذ مرة فوراً عند الإقلاع بالإنتاج', () => {
  test('نسخ احتياطي + تنظيف تسجيلات معلَّقة منتهية: تعملان فوراً بلا انتظار الفاصل الزمني (6 ساعات / ساعة)', async () => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sallehly-sched-boot-test-'));

    // المرحلة ١: تجهيز المخطّط + زرع بيانات اختبار — NODE_ENV=test فـIS_PROD
    // تبقى false، فلا تُنفَّذ أي مهمة دورية هنا (نريد الحالة الأولية فقط).
    const first = freshRequireDb({
      NODE_ENV: 'test',
      DATA_DIR: tmpDataDir,
    });

    // تسجيل معلَّق انتهت صلاحية OTP خاصته منذ ساعة — الهدف الفعلي لـ
    // cleanupExpiredPendingUsers().
    first.db.prepare(
      "INSERT INTO pending_users(email, otp, otp_expires, data) VALUES (?, ?, ?, ?)"
    ).run('expired-test@example.com', '123456', Date.now() - 60 * 60 * 1000, '{}');

    const stillThere = first.db.prepare(
      "SELECT COUNT(*) c FROM pending_users WHERE email = ?"
    ).get('expired-test@example.com');
    expect(stillThere.c).toBe(1);

    first.db.close();

    // المرحلة ٢: "إعادة تشغيل" حقيقية بالإنتاج — نفس ملف القاعدة، NODE_ENV=production.
    const second = freshRequireDb({
      NODE_ENV: 'production',
      DATA_DIR: tmpDataDir,
      JWT_SECRET: 'test_only_prod_env_secret_1234567890ABCDEFGH',
    });

    try {
      // [SCHED-FIX-BOOTRUN-01] cleanupExpiredPendingUsers() متزامنة — يجب أن
      // يكون التسجيل المنتهي قد حُذف فوراً، بلا انتظار الفاصل الزمني (ساعة).
      const afterBoot = second.db.prepare(
        "SELECT COUNT(*) c FROM pending_users WHERE email = ?"
      ).get('expired-test@example.com');
      expect(afterBoot.c).toBe(0);

      // [SCHED-FIX-BOOTRUN-01] createDbBackup() غير متزامنة (fire-and-forget) —
      // يجب أن يظهر ملف نسخة احتياطية خلال ثوانٍ قليلة، بلا انتظار الفاصل
      // الزمني (6 ساعات).
      const backupDir = path.join(tmpDataDir, 'backups');
      const backupAppeared = await waitUntil(async () => {
        if (!fs.existsSync(backupDir)) return false;
        const files = await fs.promises.readdir(backupDir);
        return files.some((f) => f.startsWith('sallehly-') && f.endsWith('.sqlite'));
      });
      expect(backupAppeared, 'لم يظهر أي ملف نسخة احتياطية خلال المهلة — createDbBackup() لم تُنفَّذ عند الإقلاع').toBe(true);
    } finally {
      second.db.close();
      restoreRealEnv();
      require('../config/env');
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    }
  });
});

// [SCHED-FIX-CRONSTAGGER-01] راجع DECISIONS.md — النسخ الاحتياطي وتنظيف
// الرفوعات اليتيمة كانا مسجَّلين بنفس فاصل الـ6 ساعات، وكلاهما يُشغَّل فوراً
// عند الإقلاع (SCHED-FIX-BOOTRUN-01 أعلاه) — فيصطدمان بنفس اللحظة، للأبد.
// هذا الاختبار يثبت الجانب السلبي مباشرة: لا يمكن انتظار 30 دقيقة فعلية
// بالاختبار، لكن يمكن إثبات أن تنظيف الرفوعات **لا يُنفَّذ فوراً** عند
// الإقلاع كما كان قبل الإصلاح — ملف يتيم يبقى موجوداً بعد الإقلاع مباشرة
// رغم أنه هدف مضمون للحذف لو نُفِّذت الدالة بنفس لحظة الإقلاع.
test.describe('[SCHED-FIX-CRONSTAGGER-01] تنظيف الرفوعات اليتيمة لا يصطدم بالنسخ الاحتياطي عند الإقلاع', () => {
  test('عند الإقلاع بالإنتاج: النسخ الاحتياطي يظهر فوراً، لكن تنظيف الرفوعات اليتيمة مؤجَّل ولا يُنفَّذ بنفس اللحظة', async () => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sallehly-sched-stagger-test-'));

    const first = freshRequireDb({ NODE_ENV: 'test', DATA_DIR: tmpDataDir });
    first.db.close();

    // ملف يتيم بمجلد avatars/ لا مرجع له بقاعدة البيانات، وعمره أكثر من يوم —
    // هدف مضمون لـcleanupOrphanUploads() لو نُفِّذت.
    const avatarsDir = path.join(tmpDataDir, 'uploads', 'avatars');
    fs.mkdirSync(avatarsDir, { recursive: true });
    const orphanFile = path.join(avatarsDir, 'orphan-test.png');
    fs.writeFileSync(orphanFile, 'x');
    const twoDaysAgoSec = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(orphanFile, twoDaysAgoSec, twoDaysAgoSec);

    const second = freshRequireDb({
      NODE_ENV: 'production',
      DATA_DIR: tmpDataDir,
      JWT_SECRET: 'test_only_prod_env_secret_1234567890ABCDEFGH',
    });

    try {
      const backupDir = path.join(tmpDataDir, 'backups');
      const backupAppeared = await waitUntil(async () => {
        if (!fs.existsSync(backupDir)) return false;
        const files = await fs.promises.readdir(backupDir);
        return files.some((f) => f.startsWith('sallehly-') && f.endsWith('.sqlite'));
      });
      expect(backupAppeared, 'لم يظهر أي ملف نسخة احتياطية خلال المهلة — createDbBackup() لم تُنفَّذ عند الإقلاع').toBe(true);

      // مهلة قصيرة إضافية بعد ظهور النسخة الاحتياطية — كافية لأي عملية
      // متزامنة اللحظة كانت لتُنهي حذف الملف اليتيم لو لم يكن مؤجَّلاً.
      await new Promise((r) => setTimeout(r, 500));
      expect(
        fs.existsSync(orphanFile),
        'تنظيف الرفوعات اليتيمة نُفِّذ فوراً عند الإقلاع بدل أن يكون مؤجَّلاً — التباعد عن النسخ الاحتياطي غير فعّال'
      ).toBe(true);
    } finally {
      second.db.close();
      restoreRealEnv();
      require('../config/env');
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    }
  });
});
