// config/migrate.js
// شكل الجداول + البيانات الابتدائية (seed) فقط. db.js يستدعي migrate(db) مرة وحدة عند الإقلاع.
// أي تعديل على الأعمدة أو بيانات seed مكانه هون بس — بدون ما تلمس منطق الاتصال بقاعدة البيانات.

// [PERF-05] bcryptjs -> bcrypt (native) — see routes/auth.routes.js for the
// full rationale. hashSync() signature/behavior unchanged; only used here at
// startup (admin/reviewer/demo-account seeding), never on the request path.
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { IS_PROD } = require('./env');

function migrate(db) {
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK(role IN ('customer','technician','admin')),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  national_number TEXT UNIQUE,
  avatar_url TEXT,
  city TEXT,
  areas TEXT,
  services TEXT,
  is_active INTEGER DEFAULT 1,
  balance REAL DEFAULT 0,
  free_orders_used INTEGER DEFAULT 0,
  rating_avg REAL DEFAULT 0,
  rating_count INTEGER DEFAULT 0,
  completed_jobs INTEGER DEFAULT 0,
  active_commission REAL DEFAULT 2,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS service_categories(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, icon TEXT DEFAULT '🔧');
CREATE TABLE IF NOT EXISTS pending_users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  otp TEXT NOT NULL,
  otp_expires INTEGER NOT NULL,
  attempts INTEGER DEFAULT 0,
  data TEXT NOT NULL,
  avatar_filename TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS packages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  amount REAL NOT NULL,
  bonus REAL DEFAULT 0,
  commission_per_order REAL DEFAULT 2,
  is_active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS payment_methods(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_name TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  phone TEXT NOT NULL,
  instructions TEXT
);
CREATE TABLE IF NOT EXISTS topups(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  technician_id INTEGER NOT NULL,
  package_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  bonus REAL DEFAULT 0,
  commission_per_order REAL,
  receipt_url TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  admin_note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT,
  FOREIGN KEY(technician_id) REFERENCES users(id),
  FOREIGN KEY(package_id) REFERENCES packages(id)
);
CREATE TABLE IF NOT EXISTS requests(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  technician_id INTEGER,
  service TEXT NOT NULL,
  city TEXT NOT NULL,
  area TEXT,
  lat REAL,
  lng REAL,
  description TEXT NOT NULL,
  preferred_time TEXT,
  problem_image_url TEXT,
  status TEXT DEFAULT 'new',
  offer_price REAL,
  arrival_time TEXT,
  commission_charged REAL DEFAULT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(customer_id) REFERENCES users(id),
  FOREIGN KEY(technician_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS offers(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  technician_id INTEGER NOT NULL,
  price REAL NOT NULL,
  duration TEXT NOT NULL,
  note TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(request_id, technician_id),
  FOREIGN KEY(request_id) REFERENCES requests(id),
  FOREIGN KEY(technician_id) REFERENCES users(id)
);
-- [DATA-INTEGRITY-02] راجع DECISIONS.md — الجداول الثمانية أدناه (messages
-- حتى complaints) تحمل الآن FOREIGN KEY صريحة على كل عمود يشير لـ
-- users/requests/messages. هذا يخدم فقط تنصيباً جديداً بالكامل (لا صف
-- موجود بعد) — قاعدة بيانات قائمة فعلياً على هذا الجدول تتجاهل هذا التعريف
-- تماماً بفضل IF NOT EXISTS، وتُرحَّل بدالة migrateTableAddForeignKeys
-- أدناه (إعادة بناء آمنة، لا ALTER — SQLite لا يدعم إضافة قيد FK لجدول قائم).
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(request_id) REFERENCES requests(id),
  FOREIGN KEY(sender_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS chat_violations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'مفتوح',
  FOREIGN KEY(request_id) REFERENCES requests(id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS chat_reads(
  request_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  last_read_message_id INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(request_id,user_id),
  FOREIGN KEY(request_id) REFERENCES requests(id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);
-- [FIX-UGC-01] الإبلاغ عن رسالة مسيئة (Google Play User Generated Content policy)
CREATE TABLE IF NOT EXISTS message_reports(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  message_id INTEGER,
  reporter_id INTEGER NOT NULL,
  reported_user_id INTEGER,
  reason TEXT NOT NULL,
  message_body TEXT,
  status TEXT DEFAULT 'قيد المراجعة',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(request_id) REFERENCES requests(id),
  FOREIGN KEY(message_id) REFERENCES messages(id),
  FOREIGN KEY(reporter_id) REFERENCES users(id),
  FOREIGN KEY(reported_user_id) REFERENCES users(id)
);
-- [FIX-UGC-01] حظر مستخدم لمستخدم آخر — يمنع التراسل بالاتجاهين بمجرد وجود
-- سجل حظر من أي طرف (راجع الفحص بـ routes/chat.routes.js).
CREATE TABLE IF NOT EXISTS user_blocks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blocker_id INTEGER NOT NULL,
  blocked_id INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(blocker_id, blocked_id),
  FOREIGN KEY(blocker_id) REFERENCES users(id),
  FOREIGN KEY(blocked_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS ratings(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL UNIQUE,
  technician_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(request_id) REFERENCES requests(id),
  FOREIGN KEY(technician_id) REFERENCES users(id),
  FOREIGN KEY(customer_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS ledger(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  balance_after REAL NOT NULL,
  note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS complaints(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  request_id INTEGER,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT DEFAULT 'open',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(request_id) REFERENCES requests(id)
);
CREATE TABLE IF NOT EXISTS support_tickets(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT DEFAULT 'عام',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT DEFAULT 'open' CHECK(status IN ('open','closed')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS support_messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(ticket_id) REFERENCES support_tickets(id),
  FOREIGN KEY(sender_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS audit_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  details TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
-- [NOTIF-PHASE1] أساس تخزين دائم للإشعارات — راجع utils/notification.js.
-- طبقة تخزين فقط بهذه المرحلة: لا يوجد أي مسار حالياً يكتب لهذا الجدول
-- (notify() موجودة كدالة معزولة، غير مربوطة بأي route أو socket/push بعد)،
-- ولا يوجد أي endpoint قراءة (GET) بعد — كلاهما بمراحل لاحقة. request_id/
-- ticket_id اختياريان (NULL) لأن أنواع إشعارات مستقبلية (مثلاً 'service')
-- لا ترتبط بطلب أو تذكرة دعم محددة؛ SQLite لا يفرض قيد FOREIGN KEY على قيمة NULL.
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  data TEXT,
  request_id INTEGER,
  ticket_id INTEGER,
  is_read INTEGER NOT NULL DEFAULT 0,
  read_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(request_id) REFERENCES requests(id),
  FOREIGN KEY(ticket_id) REFERENCES support_tickets(id)
);
`);

// تحديث قواعد البيانات القديمة بدون حذف البيانات
try { db.prepare('ALTER TABLE requests ADD COLUMN lat REAL').run(); } catch (e) {}
try { db.prepare('ALTER TABLE requests ADD COLUMN lng REAL').run(); } catch (e) {}
try { db.prepare('ALTER TABLE requests ADD COLUMN problem_image_url TEXT').run(); } catch (e) {}
try { db.prepare("ALTER TABLE support_tickets ADD COLUMN status TEXT DEFAULT 'open'").run(); } catch (e) {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_requests_technician ON requests(technician_id)').run(); } catch (e) {}
try { db.prepare('ALTER TABLE users ADD COLUMN active_commission REAL DEFAULT 2').run(); } catch (e) {}
try { db.prepare('ALTER TABLE users ADD COLUMN fcm_token TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE requests ADD COLUMN cancel_reason TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE requests ADD COLUMN cancelled_by INTEGER').run(); } catch (e) {}
try { db.prepare('ALTER TABLE requests ADD COLUMN cancelled_at TEXT').run(); } catch (e) {}
// [FIX-SERVICES-01] يسمح للأدمن بتعطيل مهنة دون حذفها نهائياً — القيمة
// الافتراضية 1 تحافظ على كل المهن الموجودة فعّالة كما كانت قبل هذا التعديل.
try { db.prepare('ALTER TABLE service_categories ADD COLUMN is_active INTEGER DEFAULT 1').run(); } catch (e) {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at)').run(); } catch (e) {}
// [SEC-FIX-09] عدّاد يُستخدم لإبطال كل توكنات JWT الصادرة قبل لحظة معيّنة فوراً
// (تسجيل خروج أو تغيير كلمة سر) دون انتظار انتهاء صلاحية التوكن (7 أيام).
// القيمة الافتراضية 0 تُبقي كل التوكنات الحالية صالحة كما هي (توافق رجعي كامل).
try { db.prepare('ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0').run(); } catch (e) {}
// [FIX-OFFERQUOTA-01] عدّاد منفصل تماماً عن free_orders_used (الذي يبقى بلا أي
// تعديل ويحكم فقط "أول طلبين مكتملين بلا عمولة" كما كان تماماً). هذا العدّاد
// الجديد يتتبّع عدد "محاولات تقديم عرض" الفعلية بشكل دائم — بعكس الحساب القديم
// (COUNT(DISTINCT request_id) من جدول offers الحيّ، بملف routes/offers.routes.js)
// الذي كان يتناقص فور حذف عرض مسحوب (DELETE /offers/:id)، فيسمح بتجاوز حد
// الفرصتين المجانيتين بتكرار تقديم/سحب العرض بلا نهاية.
try {
  db.prepare('ALTER TABLE users ADD COLUMN free_offers_used INTEGER NOT NULL DEFAULT 0').run();
  // يُنفَّذ هذا السطر فقط أول مرة يُضاف فيها العمود أعلاه (بفضل نجاح ALTER ضمن
  // نفس try — لو كان العمود موجوداً مسبقاً لرمى ALTER خطأً ولما وصلنا هنا إطلاقاً).
  // نُهيّئ كل فني موجود مسبقاً بعدد عروضه الحالية الفعلية (COUNT(DISTINCT
  // request_id)) كأفضل تقدير متاح لتاريخه — توافق رجعي آمن، لا يُصفّر أحداً
  // ظلماً. ملاحظة: لا يمكن استرجاع تاريخ عروض سُحبت وحُذفت فعلياً قبل هذا
  // الإصلاح، فأي فني استغل هذه الثغرة سابقاً قد يحصل على فرص إضافية قليلة
  // لمرة واحدة فقط بعد الترحيل — هذا تقصير معروف ومقصود بدل تخمين غير آمن.
  db.prepare(`
    UPDATE users SET free_offers_used = (
      SELECT COUNT(DISTINCT request_id) FROM offers WHERE offers.technician_id = users.id
    ) WHERE role = 'technician'
  `).run();
} catch (e) {}

// [FIX-SUPERADMIN-01] طبقة صلاحية أعلى من 'admin' العادي، بدون إضافة قيمة جديدة
// لعمود role (كان سيتطلب إعادة بناء الجدول كاملاً بسبب قيد CHECK في SQLite —
// خطر غير ضروري على بيانات إنتاج حقيقية). عمود منفصل بسيط بدلاً من ذلك: أي
// حساب role='admin' يبقى يعمل بكل صلاحياته الحالية تماماً كما هي (لا رجعة أو
// تعطيل لأي شيء موجود)؛ is_super_admin فقط يفتح صلاحيات جديدة أشد حساسية
// (تغيير الأدوار). الحساب الوحيد الحالي (المُهيَّأ من .env) يصبح super admin
// تلقائياً — لا يوجد اليوم أي طريقة لإنشاء أكثر من حساب admin واحد أصلاً
// (POST /auth/register يرفض role='admin' صراحة)، فهذا لا يغيّر أي صلاحية
// فعلية موجودة، فقط يُسمّي الحساب الوحيد الموجود بدقة أكبر.
try {
  db.prepare('ALTER TABLE users ADD COLUMN is_super_admin INTEGER NOT NULL DEFAULT 0').run();
  db.prepare("UPDATE users SET is_super_admin=1 WHERE role='admin'").run();
} catch (e) {}

// [FIX-VERIFY-01] حالة توثيق الفني — عرض/تصفية فقط بلوحة الأدمن، لا تمنع أي
// فني موجود أو جديد من العمل (القرار: لا حجب — راجع نقاش الجلسة). كل الحسابات
// الموجودة مسبقاً (بكل الأدوار) تُعتبر "موثّقة" فوراً حتى لا يظهر أي فني يعمل
// فعلاً بشارة "قيد المراجعة" بالخطأ؛ فقط من يسجّل بعد هذا التحديث يبدأ pending.
try {
  db.prepare("ALTER TABLE users ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'pending'").run();
  db.prepare("UPDATE users SET verification_status='verified'").run();
} catch (e) {}

// [FIX-SUSPEND-01] بيانات إضافية فقط تُرفَق مع is_active=0 الحالي (السبب/الوقت/
// من أوقف) — لا تُضاف كآلية إنفاذ موازية. كل فحص is_active الحالي (auth.js،
// socket، ظهور الفني بالبحث) يبقى بلا أي تعديل؛ suspended يبقى NULL دائماً
// لحساب فعّال، فلا فرق سلوكي عن اليوم لأي شيء غير شاشة الأدمن نفسها.
try { db.prepare('ALTER TABLE users ADD COLUMN suspension_reason TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE users ADD COLUMN suspended_at TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE users ADD COLUMN suspended_by INTEGER').run(); } catch (e) {}

// [FIX-MODERATION-01] مخالفات الشات لم يكن لها أي حالة متابعة (بعكس complaints
// و message_reports اللذين لديهما status أصلاً) — الأدمن يقدر يشوفها بس مش
// يوثّق أنه راجعها أو اتخذ إجراء. DEFAULT يُطبَّق تلقائياً على كل الصفوف
// الموجودة (سلوك ADD COLUMN القياسي بـ SQLite)، فلا حاجة لـUPDATE إضافي.
try { db.prepare("ALTER TABLE chat_violations ADD COLUMN status TEXT NOT NULL DEFAULT 'مفتوح'").run(); } catch (e) {}

// [FIX-DELETE-CRASH-01] راجع utils/db-helpers.js (anonymizeUser) وDECISIONS.md.
// تُترَك NULL لكل حساب عادي (لا تغيير سلوكي على أي شيء موجود)؛ تُضبَط فقط عند
// حذف/إخفاء حساب (DELETE /me أو DELETE /admin/users/:id) لتمييزه عن حساب
// موقوف عادي (is_active=0 لوحده لا يفرّق بين "موقوف مؤقتاً" و"محذوف نهائياً").
try { db.prepare('ALTER TABLE users ADD COLUMN deleted_at TEXT').run(); } catch (e) {}

// [FEAT-UPLOADQUOTA-01] راجع DECISIONS.md — عدّاد تراكمي (لا يُخفَّض أبداً،
// حتى لو حُذف الملف لاحقاً بتنظيف دوري أو استبدال صورة) لمجموع بايتات الملفات
// التي رفعها هذا المستخدم عبر حياة الحساب كلها. الهدف سقف صلب على أقصى ما
// يقدر مستخدم واحد أن "يكتبه" للقرص إجمالاً، لا تتبّع حي لمساحته الفعلية
// المشغولة الآن (تعمّد التبسيط — راجع middleware/upload.js's enforceUploadQuota
// ونطاق هذا البند بـDECISIONS.md).
try { db.prepare('ALTER TABLE users ADD COLUMN total_upload_bytes INTEGER NOT NULL DEFAULT 0').run(); } catch (e) {}

// [FIX-COMMISSIONSNAPSHOT-01] راجع DECISIONS.md — قبل هذا الإصلاح، عمولة كل
// شحن رصيد كانت تُقرأ حيّة من packages.commission_per_order وقت مراجعة الأدمن
// (POST /admin/topups/:id/review)، لا وقت تقديم الطلب. لو عدّل الأدمن عمولة
// الباقة بين تقديم الفني للطلب (يرفع إثبات دفع، ينتظر المراجعة — قد يستغرق
// أياماً) وموافقته عليه، الفني يُطبَّق عليه معدّل مختلف تماماً عمّا كان سارياً
// فعلياً لحظة دفعه. الأعمدة الجديدة تُملأ NULL لكل صف موجود مسبقاً (سلوك ADD
// COLUMN القياسي بـ SQLite) — سطر المراجعة بأسفل يتعامل معها بـfallback صريح
// للتوافق مع أي طلب شحن قديم قُدِّم قبل هذا الإصلاح.
try { db.prepare('ALTER TABLE topups ADD COLUMN commission_per_order REAL').run(); } catch (e) {}

// [DATA-INTEGRITY-02] راجع DECISIONS.md — الجداول الثمانية أدناه (messages،
// chat_violations، chat_reads، message_reports، user_blocks، ratings،
// ledger، complaints) كانت تشير لـusers/requests/messages بمعرّف رقمي بلا
// أي FOREIGN KEY مُصرَّح، فلا شيء كان يمنع صفاً يتيماً لو حُذف الصف المُشار
// إليه مستقبلاً. SQLite لا يدعم ALTER TABLE ADD CONSTRAINT — الطريقة
// الوحيدة لإضافة قيد FK لجدول قائم فعلياً هي إعادة بناء كامل: تسمية الجدول
// القديم مؤقتاً، إنشاء الجديد (نفس الأعمدة بالضبط + FK)، نسخ الصفوف، حذف
// القديم. هذا يُنفَّذ داخل db.transaction() واحدة لكل جدول — لو فشل أي جزء
// (خصوصاً INSERT الأخير، الذي يفشل تلقائياً لو وُجد صف يتيم فعلي بما أن
// foreign_keys=ON افتراضياً بـbetter-sqlite3، تحقَّق مباشرة) يتراجع كل شيء
// تلقائياً (rollback) والجدول القديم يبقى تماماً كما كان — لا خطر تلف أو
// حالة منتصفة أبداً، مهما حدث.
//
// idempotent فعلياً بلا أي عمود/جدول إضافي لتتبّع الحالة: فحص
// `PRAGMA foreign_key_list(table)` قبل أي محاولة — تنصيب جديد بالكامل يحصل
// على FK مباشرة من CREATE TABLE أعلاه فتكون القائمة غير فارغة فوراً
// (تخطٍّ تلقائي)، وقاعدة بيانات مُرحَّلة مسبقاً (تشغيلة سابقة لهذا الكود)
// لن تُعاد هجرتها مرة ثانية. يُنفَّذ بعد كل ALTER ADD COLUMN المذكورة أعلاه
// (تحديداً بعد إضافة chat_violations.status) عمداً — أعمدة الجدول القديم
// يجب أن تكون مكتملة أولاً حتى يطابق INSERT الصريح أدناه كل عمود موجود
// فعلياً؛ ويُنفَّذ قبل أي CREATE INDEX يخص هذه الجداول تحديداً (أدناه
// مباشرة) لأن حذف الجدول القديم يحذف فهارسه معه — تلك الفهارس تُعاد
// إنشاؤها فوراً بعدها بفضل IF NOT EXISTS الموجودة أصلاً بكل واحدة.
function migrateTableAddForeignKeys(db, table, createSql, columns) {
  try {
    const existingFks = db.pragma(`foreign_key_list(${table})`);
    if (existingFks.length > 0) return; // مُهاجَر مسبقاً أو تنصيب جديد بالفعل

    const tmpTable = `${table}_pre_fk_migration`;
    const colList = columns.join(',');
    const rebuild = db.transaction(() => {
      db.exec(`ALTER TABLE ${table} RENAME TO ${tmpTable}`);
      db.exec(createSql);
      db.exec(`INSERT INTO ${table} (${colList}) SELECT ${colList} FROM ${tmpTable}`);
      db.exec(`DROP TABLE ${tmpTable}`);
    });
    rebuild();
    console.log(`[DATA-INTEGRITY-02] ${table}: أُضيفت قيود FOREIGN KEY بنجاح`);
  } catch (e) {
    // لا تُسقط الإقلاع أبداً — الجدول يبقى بحالته القديمة (بلا FK) بفضل
    // rollback التلقائي، تماماً كأن هذا السطر لم يُنفَّذ إطلاقاً هذه المرة.
    console.error(`[DATA-INTEGRITY-02] فشل ترحيل ${table} — الجدول بقي كما كان (لا بيانات ضائعة، تراجع تلقائي):`, e.message);
  }
}

migrateTableAddForeignKeys(db, 'messages',
  `CREATE TABLE messages(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(request_id) REFERENCES requests(id),
    FOREIGN KEY(sender_id) REFERENCES users(id)
  )`,
  ['id', 'request_id', 'sender_id', 'body', 'created_at']);

migrateTableAddForeignKeys(db, 'chat_violations',
  `CREATE TABLE chat_violations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'مفتوح',
    FOREIGN KEY(request_id) REFERENCES requests(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`,
  ['id', 'request_id', 'user_id', 'body', 'reason', 'created_at', 'status']);

migrateTableAddForeignKeys(db, 'chat_reads',
  `CREATE TABLE chat_reads(
    request_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    last_read_message_id INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(request_id,user_id),
    FOREIGN KEY(request_id) REFERENCES requests(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`,
  ['request_id', 'user_id', 'last_read_message_id', 'updated_at']);

migrateTableAddForeignKeys(db, 'message_reports',
  `CREATE TABLE message_reports(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL,
    message_id INTEGER,
    reporter_id INTEGER NOT NULL,
    reported_user_id INTEGER,
    reason TEXT NOT NULL,
    message_body TEXT,
    status TEXT DEFAULT 'قيد المراجعة',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(request_id) REFERENCES requests(id),
    FOREIGN KEY(message_id) REFERENCES messages(id),
    FOREIGN KEY(reporter_id) REFERENCES users(id),
    FOREIGN KEY(reported_user_id) REFERENCES users(id)
  )`,
  ['id', 'request_id', 'message_id', 'reporter_id', 'reported_user_id', 'reason', 'message_body', 'status', 'created_at']);

migrateTableAddForeignKeys(db, 'user_blocks',
  `CREATE TABLE user_blocks(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    blocker_id INTEGER NOT NULL,
    blocked_id INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(blocker_id, blocked_id),
    FOREIGN KEY(blocker_id) REFERENCES users(id),
    FOREIGN KEY(blocked_id) REFERENCES users(id)
  )`,
  ['id', 'blocker_id', 'blocked_id', 'created_at']);

migrateTableAddForeignKeys(db, 'ratings',
  `CREATE TABLE ratings(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL UNIQUE,
    technician_id INTEGER NOT NULL,
    customer_id INTEGER NOT NULL,
    stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),
    comment TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(request_id) REFERENCES requests(id),
    FOREIGN KEY(technician_id) REFERENCES users(id),
    FOREIGN KEY(customer_id) REFERENCES users(id)
  )`,
  ['id', 'request_id', 'technician_id', 'customer_id', 'stars', 'comment', 'created_at']);

migrateTableAddForeignKeys(db, 'ledger',
  `CREATE TABLE ledger(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    balance_after REAL NOT NULL,
    note TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`,
  ['id', 'user_id', 'type', 'amount', 'balance_after', 'note', 'created_at']);

migrateTableAddForeignKeys(db, 'complaints',
  `CREATE TABLE complaints(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    request_id INTEGER,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT DEFAULT 'open',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(request_id) REFERENCES requests(id)
  )`,
  ['id', 'user_id', 'request_id', 'subject', 'body', 'status', 'created_at']);

// [FEAT-REFUND-01] راجع DECISIONS.md وتعليق FEAT-ADMINREQUESTDETAIL-01 بـ
// routes/admin.routes.js — ledger لم يحمل قط عمود يربطها بالطلب المسبِّب
// لها، فكان مستحيلاً تتبّع أي قيد مالي لسبب حدوثه دون قراءة note كنص حر.
// عمود بسيط قابل لـNULL بلا FOREIGN KEY (لا إعادة بناء جدول، بعكس الثمانية
// أعلاه) — نفس نمط cancel_reason/cancelled_by/cancelled_at بـrequests
// بالضبط: ALTER TABLE ADD COLUMN لعمود قابل لـNULL بلا DEFAULT محسوب هو
// عملية meta-data فقط بـSQLite بصرف النظر عن حجم الجدول، لا تنسخ أو تعيد
// كتابة أي صف — مُنفَّذ بعد استدعاءات migrateTableAddForeignKeys أعلاه
// عمداً (لا قبلها) حتى لو أعاد أحدها بناء الجدول لأي سبب مستقبلي، هذا
// العمود يُضاف بعد اكتمال ذلك دائماً.
//
// NULL له معنيان مختلفان تماماً حسب type، وهذا مقصود لا نقص موحَّد:
// (1) "لا علاقة بطلب أصلاً" لنوعي 'شحن رصيد' و'تعديل يدوي من الإدارة' —
// الأول مرتبط بطلب شحن (topups)، الثاني عام بلا سياق طلب إطلاقاً؛ يبقى
// NULL للأبد بتصميم متعمَّد لكلا النوعين، وليس فجوة ترحيل.
// (2) "كان يمكن ربطه لكن تعذّر استرجاعه من صفوف قديمة" لنوع 'طلب مجاني'
// فقط تحديداً — راجع سبب ذلك بالترحيل أدناه.
// الأسطر الجديدة (INSERT) بـrequests.routes.js تمرّر request_id مباشرة من
// كود التطبيق نفسه من الآن فصاعداً لكلا نوعي 'طلب مجاني' و'خصم عمولة طلب' —
// لا نص حر يُقرأ لاحقاً لاستنتاجه إطلاقاً لأي قيد جديد يُكتَب بعد هذا التعديل.
try { db.prepare('ALTER TABLE ledger ADD COLUMN request_id INTEGER').run(); } catch (e) {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_ledger_request ON ledger(request_id)').run(); } catch (e) {}
// [FEAT-REFUND-01] راجع DECISIONS.md — يميّز طلباً استُردَّت عمولته إدارياً
// (POST /admin/requests/:id/refund-commission، routes/admin.routes.js) عن
// طلب لم تُخصَم عليه عمولة قط بعد (commission_charged لا يزال NULL) أو
// خُصمت ولم تُسترَد (commission_charged رقم، هذا العمود NULL). يمنع استرداداً
// مزدوجاً على نفس الطلب — commission_charged نفسه يبقى بلا أي تعديل حتى بعد
// الاسترداد (سجل تاريخي لما خُصم فعلياً لحظة الإكمال، لا يُصفَّر أو يُعاد
// كتابته)، بنفس فلسفة عدم لمس أي عمود تاريخي موجود مسبقاً بهذا الملف.
try { db.prepare('ALTER TABLE requests ADD COLUMN commission_refunded_at TEXT').run(); } catch (e) {}

// [FEAT-COMPLAINTOUTCOME-01] راجع DECISIONS.md — POST /complaints/:id/status
// كان يسمح بـstatus='resolved'/'rejected' بلا أي وصف لما حدث فعلياً؛ "شكوى
// مُعلَّمة كمحلولة بلا أي إجراء مرفَق سجل كاذب" (قرار صاحب المنتج). عمودان
// قابلان لـNULL — نفس نمط ALTER TABLE ADD COLUMN المُستخدَم بكل هذا الملف.
// outcome enum ثابت (لا نص حر) يشمل 'no_action' كقيمة أولى-درجة صريحة —
// شكوى غير مؤسَّسة تُغلَق بصدق ("رُوجعت، لا إجراء") بدل الضغط نحو استرداد
// غير مستحق فقط لإغلاق التذكرة (قرار صاحب المنتج صراحة). NULL لكل الصفوف
// القديمة المغلقة مسبقاً قبل هذا الإصلاح — لا محاولة استرجاع تاريخي هنا
// (بعكس FEAT-REFUND-01 أعلاه)، لأن لا حقل موجود مسبقاً يحمل هذه المعلومة
// إطلاقاً لأي صف قديم؛ عرضها كـ"لا يوجد سجل" أصدق من أي تخمين.
try { db.prepare('ALTER TABLE complaints ADD COLUMN outcome TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE complaints ADD COLUMN outcome_note TEXT').run(); } catch (e) {}

// [FEAT-REFUND-01] ترحيل صفوف تاريخية — فقط نوع 'خصم عمولة طلب' قابل
// للاسترجاع فعلياً من بيانات موجودة: ملاحظته (note) مُولَّدة آلياً بالكامل
// (لا نص مستخدم مطلقاً — راجع routes/requests.routes.js) وتتبع قالباً
// ثابتاً `خصم عمولة الطلب رقم ${r.id}` لم يتغيّر شكله إطلاقاً منذ إدخاله
// أول مرة (تحقَّقنا من تاريخ الملف الكامل عبر git log -p — لا نخمّن).
// نوع 'طلب مجاني' يبقى NULL عمداً لكل الصفوف القديمة — ملاحظته النصية عامة
// بلا أي رقم طلب مضمَّن إطلاقاً ("تم احتساب الطلب ضمن أول طلبين مجانيين")،
// ولا يوجد أي حقل آخر بالجدول يفكّ الغموض (فني واحد قد يُنجز عدة طلبات
// مجانية متتالية بفارق ثوانٍ) — مطابقة بالتوقيت الأقرب كانت ستكون تخميناً
// لا استرجاعاً، بالضبط ما طُلب تجنّبه صراحةً؛ تُترَك NULL بصراحة بدل تخمين.
//
// يتحقّق أيضاً أن صف الطلب المُستخرَج فعلياً موجود بجدول requests قبل
// الكتابة (دفاعي بحت، احتياط ضد بيانات تالفة نظرياً) — لا يكتب أبداً
// معرّفاً لا وجود له. الشرط WHERE request_id IS NULL يجعل هذا idempotent
// فعلياً: تكرار الإقلاع لا يعيد المحاولة على صفوف رُحِّلت مسبقاً (أو تُركت
// NULL بالفحص السابق لعدم مطابقة القالب). كل الترحيل داخل معاملة واحدة
// (all-or-nothing — فشل أي جزء غير متوقَّع يُرجع كل الصفوف لحالتها قبل
// المحاولة، لا حالة نصف-مكتملة أبداً)، ومُغلَّف بـtry/catch خارجي لا يُسقط
// الإقلاع مهما حدث — نفس نمط ترحيل free_offers_used أعلاه بالضبط.
try {
  const unlinkedCharges = db.prepare(
    "SELECT id, note FROM ledger WHERE type='خصم عمولة طلب' AND request_id IS NULL"
  ).all();
  const backfillOne = db.prepare('UPDATE ledger SET request_id=? WHERE id=?');
  const requestExists = db.prepare('SELECT 1 FROM requests WHERE id=?');
  let backfilled = 0;
  const runBackfill = db.transaction(() => {
    for (const row of unlinkedCharges) {
      const match = /رقم\s+(\d+)\s*$/.exec(row.note || '');
      if (!match) continue;
      const requestId = Number(match[1]);
      if (!requestExists.get(requestId)) continue;
      backfillOne.run(requestId, row.id);
      backfilled++;
    }
  });
  runBackfill();
  if (unlinkedCharges.length > 0) {
    console.log(`[FEAT-REFUND-01] ترحيل ledger.request_id: ${backfilled}/${unlinkedCharges.length} صف "خصم عمولة طلب" رُبط بنجاح (الباقي تُرك NULL — قالب note غير مطابق أو الطلب المشار إليه غير موجود).`);
  }
} catch (e) {
  console.error('[FEAT-REFUND-01] فشل ترحيل ledger.request_id — العمود موجود وتبقى الصفوف غير المُرحَّلة NULL كما كانت (تراجع تلقائي، لا بيانات تالفة)، سيُعاد المحاولة بالإقلاع القادم:', e.message);
}

// [FIX-CLEANUP-01] كان هنا سابقاً تعريف ثانٍ لجدول complaints بأعمدة مختلفة
// (customer_id/technician_id بدل user_id/subject/status). بفضل IF NOT EXISTS
// لم يكن له أي أثر فعلي إطلاقاً — الجدول الحقيقي المُستخدَم فعلياً بكل أرجاء
// الكود (routes/support.routes.js) هو التعريف الأول أعلاه بعمود user_id.
// أُزيل التعريف المكرر لأنه كود ميت ومضلِّل فقط، وليس له أي أثر وظيفي حالي.
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id)').run(); } catch (e) {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_message_reports_created ON message_reports(created_at)').run(); } catch (e) {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON user_blocks(blocker_id)').run(); } catch (e) {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id)').run(); } catch (e) {}
// [PERF-03] الثلاثة أدناه أُضيفت بعد تحقيق فعلي أثبت أنها الأعمدة الأكثر
// تأثراً بغياب أي فهرس: messages.request_id يُستخدَم بكل استعلامات الشات
// (getMessages، والاستعلامات الفرعية المترابطة الثلاثة بـGET /chats لكل صف)
// — بلا فهرس، كل واحدة منها تفحص كامل جدول الرسائل. requests.customer_id
// كانت فجوة غير متماثلة: النظير الخاص بالفني (technician_id) كان مفهرساً
// أصلاً منذ زمن، أما جهة العميل ("طلباتي") فلا. ledger.user_id يُستخدَم
// بكل من /api/ledger الشخصي و/admin/ledger الشامل للمنصة. إضافية بالكامل،
// idempotent (IF NOT EXISTS)، لا تُغيّر أي بيانات موجودة ولا تحذف شيئاً.
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_messages_request ON messages(request_id)').run(); } catch (e) {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_requests_customer ON requests(customer_id)').run(); } catch (e) {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id)').run(); } catch (e) {}
// [PERF-HARDEN-01] offers.request_id/technician_id كانا بلا أي فهرس رغم
// كونهما من أكثر الأعمدة استخداماً بشرط WHERE بكل المشروع (تحقَّق فعلياً:
// 13+ استدعاءً منفصلاً). الأهم: chat.routes.js يُنفّذ
// "WHERE request_id=? AND technician_id=?" على offers عند كل رسالة/صورة/صوت
// يرسلها أي طرف (فحص hasOffer، 6 مواقع منفصلة) — أي هذا الفهرس يُلمَس عملياً
// على كل تفاعل شات تقريباً، وليس فقط شاشات العروض نفسها. request_id له أيضاً
// استخدام منفرد (offers.routes.js: عرض/عدّ عروض طلب معيّن)، وtechnician_id
// له استخدام منفرد آخر (admin/auth: عدّ/عرض عروض فني معيّن) — فهرسان منفصلان
// بنفس نمط requests.customer_id/technician_id أعلاه بالضبط، بدل فهرس مركّب
// واحد لا يخدم إلا أحد الاتجاهين بكفاءة.
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_offers_request ON offers(request_id)').run(); } catch (e) {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_offers_technician ON offers(technician_id)').run(); } catch (e) {}
// [PERF-HARDEN-01] ratings.technician_id بلا فهرس — يُستخدَم بـ
// utils/db-helpers.js:calcRating() التي تُنفَّذ synchronously عند كل تقييم
// جديد (POST /requests/:id/rate) لحساب المعدّل الجديد فوراً، وبـ
// GET /technicians/:id/profile (بروفايل الفني العام، قد يُفتح كثيراً من
// عملاء متعدّدين). request_id به بالفعل UNIQUE (مفهرس ضمنياً)، لا حاجة لفهرس إضافي عليه.
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_ratings_technician ON ratings(technician_id)').run(); } catch (e) {}
// [PERF-HARDEN-02] users.role بلا فهرس رغم استخدامه بشرط WHERE بمواقع حرجة:
// بحث الفنيين (GET /technicians، WHERE role='technician')، وبحثين منفصلين عن
// حساب الأدمن لإرسال Push (routes/support.routes.js، WHERE role='admin').
// قِيس فعلياً (Audit إنتاجية 2026-07-19، 8000 مستخدم صناعي): 2.88ms → 2.03ms
// لنفس استعلام بحث الفنيين (خطة EXPLAIN تحوّلت من SCAN كامل لـSEARCH بالفهرس).
// تحسّن متواضع بحجم البيانات الحالي، لكنه ينمو خطياً مع عدد المستخدمين —
// role عمود منخفض التفرّع لكنه يُفلتَر أولاً بكل هذه الاستعلامات، فالفهرس
// يمنع فحص كامل جدول users (بما فيه كل العملاء) لإيجاد الفنيين/الأدمن فقط.
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)').run(); } catch (e) {}
// [PERF-HARDEN-02] support_messages.ticket_id بلا أي فهرس إطلاقاً — بنفس نمط
// messages.request_id أعلاه بالضبط (نفس المشكلة، نفس الحل): GET و POST
// /support/:id/messages كلاهما يُنفّذ "WHERE ticket_id=?" على جدول يجمع رسائل
// كل تذاكر الدعم على المنصة كلها، وليس تذكرة واحدة — بلا فهرس، كل فتح أو رد
// على أي تذكرة دعم يفحص كامل تاريخ رسائل الدعم عبر كل المستخدمين. إضافي
// بالكامل، idempotent، لا يُغيّر أي بيانات أو سلوك.
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON support_messages(ticket_id)').run(); } catch (e) {}
// [NOTIF-PHASE1] فهرسان لجدول notifications الجديد أعلاه — نفس نمط
// idx_support_messages_ticket تماماً (عمود أجنبي كثير الاستخدام بشرط WHERE).
// user_id+created_at يخدم "أحدث إشعاراتي أولاً" (المرحلة القادمة، GET
// /notifications)، وuser_id+is_read يخدم عدّاد/تصفية غير المقروء لاحقاً.
// إضافيان بالكامل، idempotent، لا يُغيّران أي بيانات أو سلوك حالي.
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at)').run(); } catch (e) {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read)').run(); } catch (e) {}
// [PERF-HARDEN-04] topups.technician_id/package_id كانا بلا أي فهرس منذ
// إنشاء الجدول، رغم استخدامهما بشرط WHERE بمواقع متكررة: فحص عدد طلبات
// الشحن المعلّقة عند كل محاولة شحن جديدة (POST /topups)، وGET /topups لفرع
// الفني (كل فتح لشاشة المحفظة). نفس نمط idx_offers_request/idx_offers_technician
// أعلاه بالضبط — فهرسان منفصلان بدل فهرس مركّب واحد لا يخدم إلا اتجاهاً واحداً.
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_topups_technician ON topups(technician_id)').run(); } catch (e) {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_topups_package ON topups(package_id)').run(); } catch (e) {}
// [PERF-HARDEN-05] راجع DECISIONS.md — GET /admin/stats ينفّذ نحو 10
// استعلامات منفصلة بكل طلب (routes/admin.routes.js)، منها WHERE
// status='ملغي'/'مكتمل' وGROUP BY service على requests، وWHERE
// created_at >= datetime(...) على كلٍّ من requests وusers (نُسخة يومية/
// أسبوعية/شهرية منفصلة لكل منهما)، وWHERE is_active=0 وWHERE
// verification_status='pending' على users — كلها بلا أي فهرس، فتفحص كامل
// الجدولين بكل استدعاء للوحة الأدمن الرئيسية. أداء فقط، لا صحة بيانات —
// كل استعلام يعمل بشكل صحيح اليوم، يتدهور تدريجياً مع نمو الجدولين.
// إضافية بالكامل، idempotent، لا تُغيّر أي بيانات أو سلوك حالي.
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status)').run(); } catch (e) {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_requests_created ON requests(created_at)').run(); } catch (e) {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_requests_service ON requests(service)').run(); } catch (e) {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at)').run(); } catch (e) {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active)').run(); } catch (e) {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_users_verification ON users(verification_status)').run(); } catch (e) {}
// تمت إزالة سطر إعادة تفعيل الفنيين الموقوفين تلقائياً عند كل تشغيل للسيرفر.
// كان هذا السطر يلغي قرار إيقاف أي فني من الإدارة (بسبب شكوى أو مخالفة) في كل مرة يعاد تشغيل السيرفر أو يتم نشر تحديث جديد.
// إيقاف/تفعيل الفنيين أصبح بالكامل بيد الإدارة فقط عبر /api/admin/users/:id/toggle.

const services = ['كهربائي','سباك','فني تكييف','نجار','فني أجهزة كهربائية','دهان','صيانة عامة','حداد','فني كاميرات مراقبة','فني شبكات','فني إنترنت','صيانة حواسيب','صيانة لابتوبات','صيانة هواتف','تنظيف منازل','تنظيف خزانات','مكافحة حشرات','تركيب ستالايت','تركيب أثاث','صيانة أبواب','صيانة ألمنيوم','صيانة مطابخ','صيانة سخانات','صيانة غسالات','صيانة ثلاجات','صيانة أفران','تركيب زجاج','عزل أسطح','تنسيق حدائق'];
const icons = ['⚡','🚰','❄️','🪚','🔌','🎨','🔧','⚙️','📹','🌐','📡','💻','🖥️','📱','🧹','🚿','🐜','📺','🪑','🚪','🪟','🍳','🔥','🧺','🧊','♨️','🪞','🏠','🌿'];
services.forEach((s, i) => db.prepare('INSERT OR IGNORE INTO service_categories(name,icon) VALUES(?,?)').run(s, icons[i] || '🔧'));
if (db.prepare('SELECT COUNT(*) c FROM packages').get().c === 0) {
  [['باقة البداية',10,0,2],['باقة العمل',20,2,2],['باقة المحترف',50,7,2],['باقة الشركات',100,20,2]].forEach(p => db.prepare('INSERT INTO packages(name,amount,bonus,commission_per_order) VALUES(?,?,?,?)').run(...p));
}
if (db.prepare('SELECT COUNT(*) c FROM payment_methods').get().c === 0) {
  db.prepare('INSERT INTO payment_methods(bank_name,account_name,account_number,phone,instructions) VALUES(?,?,?,?,?)')
    .run('البنك العربي','شركة صلّحلي للخدمات','JO00 ARAB 0000 0000 0000 0000 00','0790000000','حوّل قيمة الباقة كاملة ثم ارفع صورة إثبات الدفع. سيتم مراجعتها من الإدارة.');
}
// إنشاء/تحديث حساب الإدارة من ملف .env بطريقة آمنة بدون حذف قاعدة البيانات أو الطلبات.
// غيّر ADMIN_EMAIL و ADMIN_PASSWORD داخل .env ثم أعد تشغيل السيرفر.
// [FIX-12] بيئة الاختبار الآلي (NODE_ENV=test) تحصل على قيم افتراضية ثابتة تلقائياً —
// لا نعتمد على نجاح تمرير متغيرات البيئة من أداة الاختبار (ثبت عمليًا أنه غير موثوق على بعض الأنظمة)،
// هذا الفرع لا يُفعَّل إطلاقاً خارج NODE_ENV=test فلا يؤثر على التطوير أو الإنتاج بأي شكل.
const isTestEnv = process.env.NODE_ENV === 'test';
const resolvedAdminEmail = process.env.ADMIN_EMAIL || (isTestEnv ? 'admin-test@example.com' : null);
const resolvedAdminPassword = process.env.ADMIN_PASSWORD || (isTestEnv ? 'AdminTestPass123' : null);

// [FIX-ADMINENVRESET-01] راجع DECISIONS.md — قبل هذا الإصلاح، كل إقلاع
// (يعني كل إعادة نشر بالإنتاج، حدث شائع جداً بدورة نشر نشطة) كان يعيد كتابة
// email/password_hash من .env بلا شرط، حتى لو الأدمن غيّر كلمة سره فعلياً
// من داخل التطبيق (مسار مقصود وسليم) بعد آخر إقلاع — يعود صامتاً للقيمة
// القديمة بمتغيرات البيئة، بلا أي تنبيه. النية الأصلية للكود («غيّر .env ثم
// أعد التشغيل») هي آلية استرجاع صريحة عند فقدان الوصول، لا إعادة ضبط دورية.
// الحل: بصمة (fingerprint) لقيمتَي .env المُطبَّقتين آخر مرة، مخزَّنة على
// صف الأدمن نفسه. email/password_hash يُعادان الكتابة فقط لو تغيّرت قيم
// .env فعلياً عن آخر بصمة مسجَّلة (يعني: المُشغِّل غيّر .env عمداً) — لا
// لمجرد إعادة تشغيل عادية. is_active/is_super_admin يبقيان يُفرَضان بكل
// إقلاع بلا شرط كما كانا (نفس منطق FIX-SUPERADMIN-01 الأصلي، لا علاقة له
// بمشكلة كلمة السر). أول إقلاع بعد نشر هذا الإصلاح (بلا بصمة مخزَّنة بعد)
// يُسجِّل البصمة الحالية فقط دون لمس كلمة السر الحية — يحافظ على أي تغيير
// يدوي سابق بدل فرض إعادة ضبط إضافية غير متوقَّعة عند الترقية.
try {
  db.prepare('ALTER TABLE users ADD COLUMN env_admin_fingerprint TEXT').run();
} catch (e) {}

if (resolvedAdminEmail && resolvedAdminPassword) {
  const adminEmail = String(resolvedAdminEmail).trim().toLowerCase();
  const adminPass = bcrypt.hashSync(String(resolvedAdminPassword), 12);
  const envFingerprint = crypto.createHash('sha256')
    .update(adminEmail + ' ' + String(resolvedAdminPassword)).digest('hex');
  const existingAdmin = db.prepare('SELECT id, env_admin_fingerprint FROM users WHERE role=?').get('admin');
  if (existingAdmin) {
    // [FIX-SUPERADMIN-01] يبقى الحساب المُهيَّأ من .env super admin دائماً حتى
    // لو تصفّرت is_super_admin بأي طريقة يدوية — نفس منطق فرض is_active=1 هنا تماماً.
    if (existingAdmin.env_admin_fingerprint === envFingerprint) {
      // .env لم يتغيّر منذ آخر مزامنة — لا نلمس email/password_hash الحيَّين
      // (قد يكونا تغيّرا فعلاً من داخل التطبيق)، نفرض فقط الصلاحيات كالمعتاد.
      db.prepare('UPDATE users SET is_active=1, is_super_admin=1 WHERE id=?').run(existingAdmin.id);
      console.log('Admin account role enforced (env credentials unchanged, live password preserved)');
    } else if (existingAdmin.env_admin_fingerprint == null) {
      // أول إقلاع بعد نشر هذا الإصلاح — لا بصمة مسجَّلة بعد على حساب موجود
      // أصلاً. نسجّل البصمة الحالية فقط لبدء التتبّع من الآن، بلا لمس
      // email/password_hash الحيَّين — تفادياً لإعادة ضبط غير متوقَّعة عند
      // الترقية لحساب قد يكون كلمة سره تغيّرت فعلاً منذ آخر مزامنة قديمة.
      db.prepare('UPDATE users SET is_active=1, is_super_admin=1, env_admin_fingerprint=? WHERE id=?')
        .run(envFingerprint, existingAdmin.id);
      console.log('Admin env fingerprint baseline recorded (live password preserved, not reset)');
    } else {
      // .env تغيّر فعلاً عن آخر مزامنة معروفة — تغيير متعمَّد من المُشغِّل،
      // نطبّق القيمة الجديدة ونسجّل بصمتها.
      db.prepare('UPDATE users SET email=?, password_hash=?, is_active=1, is_super_admin=1, env_admin_fingerprint=? WHERE id=?')
        .run(adminEmail, adminPass, envFingerprint, existingAdmin.id);
      console.log('Admin account updated' + (isTestEnv ? ' (test defaults)' : ' from .env'));
    }
  } else {
    // [FIX-VERIFY-01] على تنصيب جديد (لا يوجد مستخدمون أصلاً وقت الترحيل أعلاه)،
    // verification_status الافتراضي بالعمود هو 'pending' — لا معنى له لحساب
    // الإدارة نفسه، فنحدّده صراحة هنا بدل تركه 'pending' بالخطأ.
    db.prepare("INSERT INTO users(role,name,email,phone,password_hash,is_active,is_super_admin,verification_status,env_admin_fingerprint) VALUES(?,?,?,?,?,1,1,'verified',?)")
      .run('admin','مدير صلّحلي',adminEmail,'0799999999',adminPass,envFingerprint);
    console.log('Admin account created' + (isTestEnv ? ' (test defaults)' : ' from .env'));
  }
} else {
  console.warn('No admin account created/updated. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env, then restart.');
}

// [FIX-REVIEW-01] حسابات مراجعة اختيارية لمراجعي Google Play (عميل + فني).
// لا تُنشأ إطلاقاً إلا لو حددت متغيرات البيئة صراحة — آمنة تماماً حتى
// بالإنتاج (لا تؤثر على أي مستخدم حقيقي، ولا تُنشأ بدون قرار واعٍ منك).
// اضبط بلوحة Render: REVIEWER_CUSTOMER_EMAIL/PASSWORD وREVIEWER_TECH_EMAIL/PASSWORD.
function seedReviewerAccount(role, emailEnvVar, passwordEnvVar, name) {
  const email = process.env[emailEnvVar];
  const password = process.env[passwordEnvVar];
  if (!email || !password) return;

  const normalizedEmail = String(email).trim().toLowerCase();
  const passHash = bcrypt.hashSync(String(password), 12);
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(normalizedEmail);

  if (existing) {
    db.prepare('UPDATE users SET password_hash=?, role=?, is_active=1 WHERE id=?')
      .run(passHash, role, existing.id);
    console.log(`Reviewer ${role} account updated (${emailEnvVar})`);
    return;
  }

  const phone = role === 'technician' ? '0798888802' : '0798888801';
  if (role === 'technician') {
    db.prepare(`INSERT INTO users(role,name,email,phone,password_hash,city,services,areas,is_active) VALUES(?,?,?,?,?,?,?,?,1)`)
      .run(role, name, normalizedEmail, phone, passHash, 'عمان', 'كهربائي,سباك,فني تكييف,صيانة عامة', 'عمان');
  } else {
    db.prepare(`INSERT INTO users(role,name,email,phone,password_hash,city,is_active) VALUES(?,?,?,?,?,?,1)`)
      .run(role, name, normalizedEmail, phone, passHash, 'عمان');
  }
  console.log(`Reviewer ${role} account created (${emailEnvVar})`);
}

seedReviewerAccount('customer', 'REVIEWER_CUSTOMER_EMAIL', 'REVIEWER_CUSTOMER_PASSWORD', 'حساب مراجعة - عميل');
seedReviewerAccount('technician', 'REVIEWER_TECH_EMAIL', 'REVIEWER_TECH_PASSWORD', 'حساب مراجعة - فني');

// V9 demo technicians: ONLY in development. Never seeded in production.
if (!IS_PROD) {
  try {
    const demoPass = bcrypt.hashSync('Tech@12345', 12);
    const demoTechs = [
      ['فني تكييف عمان - محمد', 'tech.ac.amman@sallehly.jo', '0791111101', 'عمان', 'فني تكييف,صيانة أجهزة كهربائية,صيانة عامة', 'القويسمة,الجبيهة,طبربور,صويلح,خلدا,تلاع العلي,مرج الحمام', 4.8, 37, 91, '/uploads/avatar-tech-1.png'],
      ['كهربائي عمان - أحمد', 'tech.elec.amman@sallehly.jo', '0791111102', 'عمان', 'كهربائي,صيانة سخانات,صيانة غسالات', 'القويسمة,ماركا,النصر,الهاشمي الشمالي,عبدون,وادي السير', 4.7, 29, 75, '/uploads/avatar-tech-2.png'],
      ['سباك عمان - خالد', 'tech.plumb.amman@sallehly.jo', '0791111103', 'عمان', 'سباك,تنظيف خزانات,صيانة مطابخ', 'الجبيهة,أبو نصير,شفا بدران,صويلح,خلدا,البيادر', 4.6, 22, 63, '/uploads/avatar-tech-3.png'],
      ['فني تكييف الزرقاء - سامر', 'tech.ac.zarqa@sallehly.jo', '0791111104', 'الزرقاء', 'فني تكييف,صيانة ثلاجات,صيانة غسالات', 'الزرقاء الجديدة,الرصيفة,ياجوز,حي الأمير محمد', 4.5, 18, 52, '/uploads/avatar-tech-4.png'],
      ['نجار وتركيب أثاث - عمر', 'tech.carp.amman@sallehly.jo', '0791111105', 'عمان', 'نجار,تركيب أثاث,صيانة أبواب,صيانة مطابخ', 'القويسمة,المقابلين,اليادودة,سحاب,مرج الحمام', 4.9, 41, 108, '/uploads/avatar-tech-5.png']
    ];
    const ins = db.prepare(`INSERT OR IGNORE INTO users(role,name,email,phone,password_hash,city,services,areas,avatar_url,rating_avg,rating_count,completed_jobs,balance,is_active) VALUES('technician',?,?,?,?,?,?,?,?,?,?,?,?,1)`);
    demoTechs.forEach(t => ins.run(t[0], t[1], t[2], demoPass, t[3], t[4], t[5], t[9], t[6], t[7], t[8], 20));
  } catch (e) { console.warn('demo tech seed skipped', e.message); }
}
}

module.exports = { migrate };
