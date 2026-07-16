// config/db.js
// الاتصال بقاعدة البيانات + النسخ الاحتياطي والتنظيف الدوري فقط.
// شكل الجداول والـ seed انتقلوا لملف config/migrate.js — لا تضيفهم هون.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { DATA_DIR, UPLOAD_DIR, IS_PROD } = require('./env');
const { migrate } = require('./migrate');

const db = new Database(path.join(DATA_DIR, 'sallehly.sqlite'));
db.pragma('journal_mode = WAL');

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

function createDbBackup() {
  try {
    const src = path.join(DATA_DIR, 'sallehly.sqlite');
    if (!fs.existsSync(src)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, `sallehly-${stamp}.sqlite`);
    fs.copyFileSync(src, dest);
    return dest;
  } catch (e) { console.error('backup failed:', e.message); return null; }
}
if (IS_PROD) setInterval(createDbBackup, 6 * 60 * 60 * 1000).unref();

// تنظيف دوري للملفات المرفوعة غير المستخدمة (orphan files) في public/uploads.
// لا تحذف أي شيء له مرجع في قاعدة البيانات؛ تحذف فقط الملفات التي لم يعد لها أي استخدام
// (مثل صور إيصالات دفع مرفوضة قديمة، أو ملفات تسجيل توقفت في منتصف الطريق)
// وتجاوزت 24 ساعة على الأقل لتجنب حذف ملف يُرفع حالياً وما زال قيد المعالجة.
function cleanupOrphanUploads() {
  try {
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const folders = [
      { dir: path.join(UPLOAD_DIR, 'avatars'), prefix: '/uploads/avatars/' },
      { dir: path.join(UPLOAD_DIR, 'payments'), prefix: '/uploads/payments/' },
      { dir: path.join(UPLOAD_DIR, 'requests'), prefix: '/uploads/requests/' },
      { dir: path.join(UPLOAD_DIR, 'audios'), prefix: '/uploads/audios/' }
    ];
    const usedAvatarFiles = new Set(
      db.prepare("SELECT avatar_url FROM users WHERE avatar_url IS NOT NULL AND avatar_url<>''").all()
        .map(r => path.basename(r.avatar_url))
    );
    const usedPendingAvatarFiles = new Set(
      db.prepare("SELECT avatar_filename FROM pending_users WHERE avatar_filename IS NOT NULL AND avatar_filename<>''").all()
        .map(r => r.avatar_filename)
    );
    const usedPaymentFiles = new Set(
      db.prepare("SELECT receipt_url FROM topups WHERE receipt_url IS NOT NULL AND receipt_url<>''").all()
        .map(r => path.basename(r.receipt_url))
    );
    const usedRequestImageFiles = new Set(
      db.prepare("SELECT problem_image_url FROM requests WHERE problem_image_url IS NOT NULL AND problem_image_url<>''").all()
        .map(r => path.basename(r.problem_image_url))
    );
    // [FIX-CHATIMG-01] صور الشات (messages.body بصيغة '[image]/uploads/requests/...')
    // تُحفَظ بنفس مجلد requests/ لكنها لم تكن محسوبة هون إطلاقاً — فكانت هذه
    // الدالة نفسها تحذفها كـ"غير مستخدمة" بعد أول 24 ساعة، بنفس نمط usedAudioFiles أدناه.
    const usedChatImageFiles = new Set(
      db.prepare("SELECT body FROM messages WHERE body LIKE '[image]%'").all()
        .map(r => path.basename(String(r.body).replace('[image]', '')))
    );
    // [FIX-AUDIODUR-01] الجسم الآن قد يحمل '|<duration>' بعد الرابط
    // (مثلاً '[audio]/uploads/audios/x.wav|42') — يجب قطعه قبل path.basename،
    // وإلا يظن هذا الفحص أن اسم الملف الحقيقي غير مُستخدَم فيحذفه لاحقاً.
    const usedAudioFiles = new Set(
      db.prepare("SELECT body FROM messages WHERE body LIKE '[audio]%'").all()
        .map(r => path.basename(String(r.body).replace('[audio]', '').split('|')[0]))
    );
    const usedByFolder = {
      avatars: new Set([...usedAvatarFiles, ...usedPendingAvatarFiles]),
      payments: usedPaymentFiles,
      requests: new Set([...usedRequestImageFiles, ...usedChatImageFiles]),
      audios: usedAudioFiles
    };
    folders.forEach(({ dir }) => {
      const folderName = path.basename(dir);
      const used = usedByFolder[folderName] || new Set();
      let files = [];
      try { files = fs.readdirSync(dir); } catch (e) { return; }
      files.forEach(file => {
        try {
          if (used.has(file)) return;
          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);
          if (!stat.isFile()) return;
          if (now - stat.mtimeMs < ONE_DAY_MS) return; // ملف حديث، قد يكون قيد الاستخدام الآن
          fs.unlinkSync(fullPath);
        } catch (e) { /* تجاهل أي ملف لا يمكن فحصه أو حذفه */ }
      });
    });
  } catch (e) { console.error('cleanup uploads failed:', e.message); }
}
if (IS_PROD) setInterval(cleanupOrphanUploads, 6 * 60 * 60 * 1000).unref();

// تنظيف دوري لطلبات التسجيل التي انتهت صلاحية كود التحقق (OTP) خاصتها ولم يكمل
// صاحبها التحقق ولا عاد إليها، بدل أن تبقى محفوظة في قاعدة البيانات إلى الأبد.
function cleanupExpiredPendingUsers() {
  try {
    db.prepare('DELETE FROM pending_users WHERE otp_expires < ?').run(Date.now());
  } catch (e) { console.error('cleanup pending_users failed:', e.message); }
}
if (IS_PROD) setInterval(cleanupExpiredPendingUsers, 60 * 60 * 1000).unref();


migrate(db);

// [FIX-CHATIMG-01] إصلاح تلقائي لمرة واحدة عند الإقلاع: أي صورة شات أُرسلت قبل
// إصلاح middleware/upload.js انحفظت فعلياً بمجلد avatars/ بينما رابطها المُخزَّن
// بقاعدة البيانات يشير لـ requests/ (فتفشل بـ404 دائماً). ننقل أي ملف ما زال
// موجوداً لمكانه الصحيح تلقائياً هنا حتى تعمل الصور القديمة من جديد بدون أي
// تدخل يدوي على السيرفر. لا يمس أي ملف غير مرتبط برسالة صورة، ولا يكرر النقل
// إن كان الملف موجوداً بالفعل بمكانه الصحيح.
function repairMisplacedChatImages() {
  try {
    const avatarsDir = path.join(UPLOAD_DIR, 'avatars');
    const requestsDir = path.join(UPLOAD_DIR, 'requests');
    const rows = db.prepare("SELECT body FROM messages WHERE body LIKE '[image]/uploads/requests/%'").all();
    let moved = 0;
    for (const row of rows) {
      const filename = path.basename(String(row.body).replace('[image]', ''));
      const wrongPath = path.join(avatarsDir, filename);
      const rightPath = path.join(requestsDir, filename);
      try {
        if (fs.existsSync(wrongPath) && !fs.existsSync(rightPath)) {
          fs.renameSync(wrongPath, rightPath);
          moved++;
        }
      } catch (e) { /* تجاهل ملفاً واحداً فشل نقله ولا توقف البقية */ }
    }
    if (moved > 0) console.log(`[FIX-CHATIMG-01] تم إصلاح ${moved} صورة شات كانت محفوظة بمكان خاطئ.`);
  } catch (e) { console.error('repair misplaced chat images failed:', e.message); }
}
repairMisplacedChatImages();

module.exports = { db, createDbBackup };
