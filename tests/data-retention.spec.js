// tests/data-retention.spec.js
// [FEAT-RETENTION-01] راجع DECISIONS.md وconfig/db.js — يثبت مباشرة سلوك ثلاث
// دوال تنظيف دورية جديدة (messages بعد أسبوع من إغلاق الطلب، audit_logs بعد
// 6 أشهر، chat_violations بعد سنتين ما عدا المفتوحة)، كل واحدة بحدّها الفاصل
// بالضبط (يُحذَف/لا يُحذَف). نفس أسلوب tests/scheduled-jobs-boot.spec.js
// (require طازج لـconfig/db.js على قاعدة بيانات مؤقتة معزولة، مرة بـNODE_ENV=test
// لتجهيز المخطّط وزرع بيانات، ثم مرة بـNODE_ENV=production لتشغيل التنظيف
// الفوري عند الإقلاع فعلياً — SCHED-FIX-BOOTRUN-01).

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

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

test.describe('[FEAT-RETENTION-01] تنظيف دوري لـ messages/audit_logs/chat_violations حسب مدد احتفاظ صريحة', () => {
  test('رسائل طلب مغلق منذ أكثر من أسبوع تُحذَف؛ رسائل طلب مغلق حديثاً أو لا يزال نشطاً تبقى', async () => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sallehly-retention-messages-'));

    const first = freshRequireDb({ NODE_ENV: 'test', DATA_DIR: tmpDataDir });
    first.db.prepare("INSERT INTO users(id,role,name,email,phone,password_hash) VALUES(999,'customer','ع','c@example.com','0790000001','x')").run();

    // طلب مكتمل منذ 8 أيام (أكثر من حد الأسبوع) — رسائله هدف مضمون للحذف.
    first.db.prepare("INSERT INTO requests(id,customer_id,service,city,description,status,updated_at) VALUES(1,999,'كهربائي','عمان','د',?,?)")
      .run('مكتمل', daysAgoIso(8));
    first.db.prepare("INSERT INTO messages(request_id,sender_id,body) VALUES(1,999,'رسالة طلب قديم مغلق')").run();

    // طلب مكتمل منذ يوم واحد فقط (دون حد الأسبوع) — رسائله يجب أن تبقى.
    first.db.prepare("INSERT INTO requests(id,customer_id,service,city,description,status,updated_at) VALUES(2,999,'كهربائي','عمان','د',?,?)")
      .run('مكتمل', daysAgoIso(1));
    first.db.prepare("INSERT INTO messages(request_id,sender_id,body) VALUES(2,999,'رسالة طلب مغلق حديثاً')").run();

    // طلب لا يزال نشطاً (بانتظار العروض) رغم أن created_at قديم افتراضياً —
    // رسائله يجب أن تبقى بغض النظر عن عمرها.
    first.db.prepare("INSERT INTO requests(id,customer_id,service,city,description,status,updated_at) VALUES(3,999,'كهربائي','عمان','د','بانتظار العروض',?)")
      .run(daysAgoIso(30));
    first.db.prepare("INSERT INTO messages(request_id,sender_id,body) VALUES(3,999,'رسالة طلب لا يزال نشطاً')").run();

    first.db.close();

    const second = freshRequireDb({
      NODE_ENV: 'production',
      DATA_DIR: tmpDataDir,
      JWT_SECRET: 'test_only_prod_env_secret_1234567890ABCDEFGH',
    });

    try {
      const settled = await waitUntil(() => {
        const remaining = second.db.prepare('SELECT COUNT(*) c FROM messages WHERE request_id=1').get().c;
        return remaining === 0;
      });
      expect(settled, 'رسائل الطلب المغلق منذ أكثر من أسبوع لم تُحذَف عند الإقلاع').toBe(true);

      expect(second.db.prepare('SELECT COUNT(*) c FROM messages WHERE request_id=2').get().c).toBe(1);
      expect(second.db.prepare('SELECT COUNT(*) c FROM messages WHERE request_id=3').get().c).toBe(1);
    } finally {
      second.db.close();
      restoreRealEnv();
      require('../config/env');
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    }
  });

  test('سجل تدقيق أقدم من 6 أشهر يُحذَف؛ الأحدث يبقى', async () => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sallehly-retention-audit-'));

    const first = freshRequireDb({ NODE_ENV: 'test', DATA_DIR: tmpDataDir });
    first.db.prepare("INSERT INTO audit_logs(actor_name,action,created_at) VALUES('أدمن','old-action',?)").run(daysAgoIso(181));
    first.db.prepare("INSERT INTO audit_logs(actor_name,action,created_at) VALUES('أدمن','recent-action',?)").run(daysAgoIso(179));
    first.db.close();

    const second = freshRequireDb({
      NODE_ENV: 'production',
      DATA_DIR: tmpDataDir,
      JWT_SECRET: 'test_only_prod_env_secret_1234567890ABCDEFGH',
    });

    try {
      const settled = await waitUntil(() => {
        const remaining = second.db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='old-action'").get().c;
        return remaining === 0;
      });
      expect(settled, 'سجل تدقيق أقدم من 6 أشهر لم يُحذَف عند الإقلاع').toBe(true);
      expect(second.db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='recent-action'").get().c).toBe(1);
    } finally {
      second.db.close();
      restoreRealEnv();
      require('../config/env');
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    }
  });

  test('مخالفة شات مغلقة أقدم من سنتين تُحذَف؛ المفتوحة تبقى مهما قدُمت؛ الأحدث تبقى', async () => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sallehly-retention-violations-'));

    const first = freshRequireDb({ NODE_ENV: 'test', DATA_DIR: tmpDataDir });
    first.db.prepare("INSERT INTO users(id,role,name,email,phone,password_hash) VALUES(999,'customer','ع','c@example.com','0790000001','x')").run();
    first.db.prepare("INSERT INTO requests(id,customer_id,service,city,description,status) VALUES(1,999,'كهربائي','عمان','د','مكتمل')").run();

    first.db.prepare("INSERT INTO chat_violations(request_id,user_id,body,reason,status,created_at) VALUES(1,999,'x','y','مغلق',?)").run(daysAgoIso(731));
    first.db.prepare("INSERT INTO chat_violations(request_id,user_id,body,reason,status,created_at) VALUES(1,999,'x','y','مفتوح',?)").run(daysAgoIso(1000));
    first.db.prepare("INSERT INTO chat_violations(request_id,user_id,body,reason,status,created_at) VALUES(1,999,'x','y','مغلق',?)").run(daysAgoIso(10));
    first.db.close();

    const second = freshRequireDb({
      NODE_ENV: 'production',
      DATA_DIR: tmpDataDir,
      JWT_SECRET: 'test_only_prod_env_secret_1234567890ABCDEFGH',
    });

    try {
      const settled = await waitUntil(() => {
        const remaining = second.db.prepare("SELECT COUNT(*) c FROM chat_violations WHERE status='مغلق' AND reason='y'").get().c;
        return remaining === 1;
      });
      expect(settled, 'المخالفة المغلقة الأقدم من سنتين لم تُحذَف عند الإقلاع').toBe(true);

      // المفتوحة تبقى رغم أنها الأقدم بكثير (1000 يوم).
      expect(second.db.prepare("SELECT COUNT(*) c FROM chat_violations WHERE status='مفتوح'").get().c).toBe(1);
    } finally {
      second.db.close();
      restoreRealEnv();
      require('../config/env');
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    }
  });
});
