#!/usr/bin/env node
// scripts/restore-db.js
// [DR-FIX-01] راجع DECISIONS.md — أداة استعادة فعلية (لا اختبار فقط) لتشغيلها
// يدوياً أثناء كارثة حقيقية: قرص Render فُقد/تلف، والنسخة الاحتياطية المحلية
// (config/db.js) ضاعت معه. تدعم الاستعادة من ملف محلي (لو نجا) أو من نسخة
// خارجية على GitHub Releases (services/offsite-backup.js).
//
// الاستخدام:
//   node scripts/restore-db.js --list
//     يسرد كل النسخ المتاحة (محلية + خارجية إن كانت مُعدَّة) بتواريخها.
//
//   node scripts/restore-db.js --source <مسار_محلي_أو_وسم_خارجي> --target <مسار>
//     يستعيد نسخة محدَّدة لمسار مُختار. --source إما مسار ملف .sqlite محلي
//     موجود فعلاً، أو وسم (tag) نسخة خارجية (مثال: backup-2026-08-29T12-00-00-000Z)
//     — إن لم يكن الأول موجوداً كملف محلي، يُحاول تحميله من GitHub Releases.
//
//   إضافة --target يساوي مسار القاعدة الحيّة فعلياً (DATA_DIR/sallehly.sqlite)
//   يتطلّب --force صراحة، ولا يحذف أي شيء أبداً بصمت: الملف الحالي بذلك
//   المسار (إن وُجد) يُنسَخ احتياطياً أولاً إلى <target>.pre-restore-<وقت>.bak
//   قبل أي استبدال. لا يعيد تشغيل السيرفر تلقائياً — استعادة ملف القاعدة
//   بينما عملية Node حيّة تحمل اتصالاً مفتوحاً بالملف القديم لن يظهر أثرها
//   حتى إعادة تشغيل تلك العملية يدوياً.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DATA_DIR } = require('../config/env');
const { listOffsiteBackups } = require('../services/offsite-backup');

function log(...args) { console.log('[restore-db]', ...args); }
function fail(msg) { console.error(`[restore-db] خطأ: ${msg}`); process.exit(1); }

function parseArgs(argv) {
  const args = { list: false, source: null, target: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--list') args.list = true;
    else if (argv[i] === '--source') args.source = argv[++i];
    else if (argv[i] === '--target') args.target = argv[++i];
    else if (argv[i] === '--force') args.force = true;
  }
  return args;
}

async function listLocalBackups() {
  const backupDir = path.join(DATA_DIR, 'backups');
  try {
    const files = await fs.promises.readdir(backupDir);
    const rows = [];
    for (const f of files) {
      if (!f.startsWith('sallehly-') || !f.endsWith('.sqlite')) continue;
      const full = path.join(backupDir, f);
      const stat = await fs.promises.stat(full);
      rows.push({ path: full, name: f, mtime: stat.mtime });
    }
    return rows.sort((a, b) => b.mtime - a.mtime);
  } catch (e) { return []; }
}

async function cmdList() {
  const local = await listLocalBackups();
  log(`نسخ محلية (${local.length}):`);
  for (const b of local) log(`  ${b.mtime.toISOString()}  ${b.path}`);

  const offsite = await listOffsiteBackups().catch(e => {
    log(`تعذّر جلب النسخ الخارجية: ${e.message}`);
    return [];
  });
  log(`نسخ خارجية (${offsite.length}):`);
  for (const b of offsite) log(`  ${b.createdAt}  وسم: ${b.tag}`);

  if (local.length === 0 && offsite.length === 0) {
    log('لا توجد أي نسخة احتياطية متاحة — لا محلياً ولا خارجياً.');
  }
}

// يحمّل نسخة خارجية بوسمها إلى ملف مؤقت، يرجع مسار الملف المؤقت.
async function downloadOffsiteBackup(tag, tmpPath) {
  const backups = await listOffsiteBackups();
  const match = backups.find(b => b.tag === tag);
  if (!match || !match.assetUrl) fail(`لا توجد نسخة خارجية بالوسم "${tag}"`);
  const { BACKUP_GITHUB_TOKEN } = require('../config/env');
  const res = await fetch(match.assetUrl, {
    headers: {
      Authorization: `Bearer ${BACKUP_GITHUB_TOKEN}`,
      Accept: 'application/octet-stream'
    }
  });
  if (!res.ok) fail(`فشل تحميل النسخة الخارجية: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.promises.writeFile(tmpPath, buffer);
  return tmpPath;
}

// [DR-FIX-01] الفحص الحقيقي الذي يجعل هذا "استعادة مُختبَرة" لا مجرّد نسخ ملف:
// PRAGMA integrity_check، ثم طباعة عدد صفوف الجداول الجوهرية حتى يتأكّد
// المُشغِّل بعينه أن البيانات فعلاً موجودة ومنطقية قبل اعتماد الاستعادة.
function verifyBackupFile(filePath) {
  const testDb = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = testDb.prepare('PRAGMA integrity_check').get();
    if (integrity.integrity_check !== 'ok') {
      fail(`فشل فحص سلامة النسخة (PRAGMA integrity_check): ${integrity.integrity_check}`);
    }
    const counts = {};
    for (const table of ['users', 'requests', 'offers', 'messages', 'ledger']) {
      try { counts[table] = testDb.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c; }
      catch (e) { counts[table] = 'غير موجود'; }
    }
    log('فحص السلامة: ok. عدد الصفوف بالجداول الجوهرية:');
    for (const [table, count] of Object.entries(counts)) log(`  ${table}: ${count}`);
    return counts;
  } finally {
    testDb.close();
  }
}

async function cmdRestore(source, target, force) {
  if (!source) fail('--source مطلوب (مسار ملف محلي أو وسم نسخة خارجية)');
  if (!target) fail('--target مطلوب (المسار الذي سيُكتَب فيه ملف القاعدة المُستعادة)');

  const liveDbPath = path.join(DATA_DIR, 'sallehly.sqlite');
  if (path.resolve(target) === path.resolve(liveDbPath) && !force) {
    fail(`--target يطابق مسار القاعدة الحيّة (${liveDbPath}) — أضف --force صراحة للتأكيد. ` +
      'الملف الحالي (إن وُجد) سيُنسَخ احتياطياً أولاً قبل أي استبدال، لكن هذا إجراء حسّاس يتطلّب تأكيداً صريحاً.');
  }

  let sourcePath = source;
  const isLocalFile = await fs.promises.access(source).then(() => true).catch(() => false);
  if (!isLocalFile) {
    log(`"${source}" ليس ملفاً محلياً موجوداً — أحاول تحميله كنسخة خارجية بهذا الوسم...`);
    const tmpPath = path.join(require('os').tmpdir(), `restore-download-${Date.now()}.sqlite`);
    sourcePath = await downloadOffsiteBackup(source, tmpPath);
    log(`تم التحميل: ${sourcePath}`);
  }

  log(`فحص سلامة النسخة قبل تثبيتها: ${sourcePath}`);
  verifyBackupFile(sourcePath);

  const targetExists = await fs.promises.access(target).then(() => true).catch(() => false);
  if (targetExists) {
    const backupOfTarget = `${target}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
    await fs.promises.copyFile(target, backupOfTarget);
    log(`الملف الموجود بالمسار الهدف نُسخ احتياطياً أولاً إلى: ${backupOfTarget}`);
  }

  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.copyFile(sourcePath, target);
  log(`تمت الاستعادة بنجاح إلى: ${target}`);
  if (path.resolve(target) === path.resolve(liveDbPath)) {
    log('تنبيه: هذا مسار القاعدة الحيّة — أعد تشغيل عملية السيرفر يدوياً الآن حتى يقرأ الملف الجديد (اتصال better-sqlite3 الحالي، إن كان يعمل، لا يزال يشير للملف القديم بالذاكرة).');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) return cmdList();
  return cmdRestore(args.source, args.target, args.force);
}

main().catch(e => fail(e.message));
