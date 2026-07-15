// config/migrate.js
// شكل الجداول + البيانات الابتدائية (seed) فقط. db.js يستدعي migrate(db) مرة وحدة عند الإقلاع.
// أي تعديل على الأعمدة أو بيانات seed مكانه هون بس — بدون ما تلمس منطق الاتصال بقاعدة البيانات.

const bcrypt = require('bcryptjs');
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
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS chat_violations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS chat_reads(
  request_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  last_read_message_id INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(request_id,user_id)
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
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
-- [FIX-UGC-01] حظر مستخدم لمستخدم آخر — يمنع التراسل بالاتجاهين بمجرد وجود
-- سجل حظر من أي طرف (راجع الفحص بـ routes/chat.routes.js).
CREATE TABLE IF NOT EXISTS user_blocks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blocker_id INTEGER NOT NULL,
  blocked_id INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(blocker_id, blocked_id)
);
CREATE TABLE IF NOT EXISTS ratings(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL UNIQUE,
  technician_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ledger(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  balance_after REAL NOT NULL,
  note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS complaints(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  request_id INTEGER,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT DEFAULT 'open',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
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

// [FIX-CLEANUP-01] كان هنا سابقاً تعريف ثانٍ لجدول complaints بأعمدة مختلفة
// (customer_id/technician_id بدل user_id/subject/status). بفضل IF NOT EXISTS
// لم يكن له أي أثر فعلي إطلاقاً — الجدول الحقيقي المُستخدَم فعلياً بكل أرجاء
// الكود (routes/support.routes.js) هو التعريف الأول أعلاه بعمود user_id.
// أُزيل التعريف المكرر لأنه كود ميت ومضلِّل فقط، وليس له أي أثر وظيفي حالي.
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id)').run(); } catch (e) {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_message_reports_created ON message_reports(created_at)').run(); } catch (e) {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON user_blocks(blocker_id)').run(); } catch (e) {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id)').run(); } catch (e) {}
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

if (resolvedAdminEmail && resolvedAdminPassword) {
  const adminEmail = String(resolvedAdminEmail).trim().toLowerCase();
  const adminPass = bcrypt.hashSync(String(resolvedAdminPassword), 12);
  const existingAdmin = db.prepare('SELECT id FROM users WHERE role=?').get('admin');
  if (existingAdmin) {
    db.prepare('UPDATE users SET email=?, password_hash=?, is_active=1 WHERE id=?')
      .run(adminEmail, adminPass, existingAdmin.id);
    console.log('Admin account updated' + (isTestEnv ? ' (test defaults)' : ' from .env'));
  } else {
    db.prepare('INSERT INTO users(role,name,email,phone,password_hash,is_active) VALUES(?,?,?,?,?,1)')
      .run('admin','مدير صلّحلي',adminEmail,'0799999999',adminPass);
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
