require('dotenv').config?.();
const { Resend } = require('resend');
// resend@6 throws synchronously in its constructor when no API key is given,
// which previously crashed the whole process at startup (before Express even
// bound the port) on any deployment where RESEND_API_KEY wasn't set. Build it
// lazily so a missing key only disables OTP email sending (see sendOtpEmail),
// matching the same graceful-degradation style already used below for
// JWT_SECRET/ADMIN_EMAIL/ADMIN_PASSWORD.
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const express = require('express');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const validator = require('validator');
const Database = require('better-sqlite3');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? (()=>{ throw new Error('JWT_SECRET is required in production'); })() : 'local_development_secret_change_me');
// [FIX-COOKIE-SECURE-01] الكوكي لم يكن يحمل Secure، فلو تم الوصول للسيرفر
// يوماً عبر HTTP عادي (مثلاً قبل تفعيل إعادة التوجيه لـHTTPS بمنصة الاستضافة)
// كان التوكن سينتقل بنص صريح. مقيّد بـNODE_ENV=production فقط كي لا يكسر
// تسجيل الدخول محلياً على http://localhost وقت التطوير.
const AUTH_COOKIE_OPTS = { httpOnly:true, sameSite:'strict', secure: process.env.NODE_ENV === 'production' };
const BASE = __dirname;
const DATA_DIR = path.join(BASE, 'data');
const UPLOAD_DIR = path.join(BASE, 'public', 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(path.join(UPLOAD_DIR, 'payments'), { recursive: true });
fs.mkdirSync(path.join(UPLOAD_DIR, 'avatars'), { recursive: true });
fs.mkdirSync(path.join(UPLOAD_DIR, 'audios'), { recursive: true });
fs.mkdirSync(path.join(UPLOAD_DIR, 'requests'), { recursive: true });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300 }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(BASE, 'public')));

// [FIX-UPLOAD-EXT-01] الامتداد كان يُؤخذ من اسم الملف الأصلي الذي يرسله
// العميل بالكامل، رغم أن fileFilter يتحقق فقط من Content-Type (mimetype) —
// قيمة يسهل تزويرها من أي عميل HTTP مباشر (خارج تطبيق فلاتر) بإرسال
// mimetype صورة صحيح مع اسم ملف مثل "x.svg" أو "x.html". express.static كان
// سيخدم هذا الملف المرفوع لاحقاً باستخدام نفس امتداده الأصلي، أي احتمال
// تنفيذ HTML/SVG مخزَّن (Stored XSS) عبر رابط رفع يُفترض أنه "صورة فقط".
// الآن الامتداد المخزَّن يُشتق حصراً من mimetype الذي تحقق منه fileFilter
// أعلاه/أدناه فعلياً، بغض النظر عن اسم الملف الأصلي.
const IMAGE_EXT_BY_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const AUDIO_EXT_BY_MIME = { 'audio/webm': '.webm', 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg' };

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const folder = file.fieldname === 'receipt' ? 'payments' : (file.fieldname === 'problem_image' ? 'requests' : 'avatars');
    cb(null, path.join(UPLOAD_DIR, folder));
  },
  filename: (req, file, cb) => {
    const ext = IMAGE_EXT_BY_MIME[file.mimetype] || '.jpg';
    cb(null, Date.now() + '-' + Math.random().toString(16).slice(2) + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('نوع الملف غير مسموح'), ok);
  }
});

const audioStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(UPLOAD_DIR, 'audios')),
  filename: (req, file, cb) => {
    const ext = AUDIO_EXT_BY_MIME[file.mimetype] || '.webm';
    cb(null, Date.now() + '-' + Math.random().toString(16).slice(2) + ext);
  }
});
const uploadAudio = multer({
  storage: audioStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['audio/webm', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg'].includes(file.mimetype);
    cb(ok ? null : new Error('نوع التسجيل الصوتي غير مسموح'), ok);
  }
});

const db = new Database(path.join(DATA_DIR, 'sallehly.sqlite'));
db.pragma('journal_mode = WAL');

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
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS service_categories(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, icon TEXT DEFAULT '🔧');
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
  commission_charged REAL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS otp_codes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS pending_users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  national_number TEXT,
  avatar_url TEXT,
  city TEXT,
  areas TEXT,
  services TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS support_tickets(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  type TEXT DEFAULT 'عام',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT DEFAULT 'open',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

try { db.prepare('ALTER TABLE requests ADD COLUMN lat REAL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE requests ADD COLUMN lng REAL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE requests ADD COLUMN problem_image_url TEXT').run(); } catch(e) {}

const services = ['كهربائي','سباك','فني تكييف','نجار','فني أجهزة كهربائية','دهان','صيانة عامة','حداد','فني كاميرات مراقبة','فني شبكات','فني إنترنت','صيانة حواسيب','صيانة لابتوبات','صيانة هواتف','تنظيف منازل','تنظيف خزانات','مكافحة حشرات','تركيب ستالايت','تركيب أثاث','صيانة أبواب','صيانة ألمنيوم','صيانة مطابخ','صيانة سخانات','صيانة غسالات','صيانة ثلاجات','صيانة أفران','تركيب زجاج','عزل أسطح','تنسيق حدائق'];
const icons = ['⚡','🚰','❄️','🪚','🔌','🎨','🔧','⚙️','📹','🌐','📡','💻','🖥️','📱','🧹','🚿','🐜','📺','🪑','🚪','🪟','🍳','🔥','🧺','🧊','♨️','🪞','🏠','🌿'];
services.forEach((s,i)=>db.prepare('INSERT OR IGNORE INTO service_categories(name,icon) VALUES(?,?)').run(s, icons[i]||'🔧'));
if (db.prepare('SELECT COUNT(*) c FROM packages').get().c === 0) {
  [['باقة البداية',10,0,2],['باقة العمل',20,2,2],['باقة المحترف',50,7,2],['باقة الشركات',100,20,2]].forEach(p=>db.prepare('INSERT INTO packages(name,amount,bonus,commission_per_order) VALUES(?,?,?,?)').run(...p));
}
if (db.prepare('SELECT COUNT(*) c FROM payment_methods').get().c === 0) {
  db.prepare('INSERT INTO payment_methods(bank_name,account_name,account_number,phone,instructions) VALUES(?,?,?,?,?)')
    .run('البنك العربي','شركة صلّحلي للخدمات','JO00 ARAB 0000 0000 0000 0000 00','0790000000','حوّل قيمة الباقة كاملة ثم ارفع صورة إثبات الدفع. سيتم مراجعتها من الإدارة.');
}
if (!db.prepare('SELECT id FROM users WHERE role=?').get('admin')) {
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const pass = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12);
    db.prepare('INSERT INTO users(role,name,email,phone,password_hash,is_active) VALUES(?,?,?,?,?,1)')
      .run('admin','مدير صلّحلي',process.env.ADMIN_EMAIL,'0799999999',pass);
    console.log('Admin account created from environment variables.');
  } else {
    console.warn('No admin account created. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env, then restart.');
  }
}

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
} catch(e) { console.warn('demo tech seed skipped', e.message); }

async function sendOtpEmail(email, code, name) {
  if (!resend) {
    console.warn('RESEND_API_KEY not set — OTP email not sent (code still stored for verification).');
    return false;
  }
  try {
    await resend.emails.send({
      from: 'تحقق من صلّحلي <no-reply@sallehly.com>',
      to: email,
      subject: 'كود التحقق من حسابك في صلّحلي',
      html: `
        <div dir="rtl" style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;background:#0d0d1a;color:#fff;border-radius:12px;">
          <h2 style="color:#8B5CF6;text-align:center;">صلّحلي 🔧</h2>
          <p>مرحباً <strong>${name}</strong>،</p>
          <p>كود التحقق من بريدك الإلكتروني هو:</p>
          <div style="text-align:center;margin:24px 0;">
            <span style="font-size:36px;font-weight:bold;letter-spacing:12px;color:#06B6D4;">${code}</span>
          </div>
          <p style="color:#aaa;font-size:13px;">صالح لمدة 10 دقائق فقط. لا تشاركه مع أحد.</p>
        </div>
      `
    });
    return true;
  } catch(e) {
    console.error('Email send error:', e.message);
    return false;
  }
}

function sign(user){ return jwt.sign({ id:user.id, role:user.role, name:user.name }, JWT_SECRET, { expiresIn:'7d' }); }
function auth(req,res,next){
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : req.cookies.token;
  if(!token) return res.status(401).json({error:'يرجى تسجيل الدخول'});
  try { req.user = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({error:'جلسة غير صالحة'}); }
  // [FIX-SUSPEND-AUTH-01] كان توكن JWT صالحاً لمدة 7 أيام كاملة بغض النظر عن
  // حالة الحساب — إيقاف حساب من لوحة الإدارة (users/:id/toggle) لم يكن يمنع
  // من يملك توكناً صادراً مسبقاً من الاستمرار باستخدام كل الـ API لغاية 7
  // أيام لاحقة رغم إيقافه. الآن يُتحقق من is_active الفعلي بقاعدة البيانات
  // مع كل طلب مصادَق، بنفس فحص تسجيل الدخول أعلاه بالضبط.
  const u = db.prepare('SELECT is_active FROM users WHERE id=?').get(req.user.id);
  if(!u) return res.status(401).json({error:'جلسة غير صالحة'});
  if(!u.is_active) return res.status(403).json({error:'الحساب موقوف'});
  next();
}
function requireRole(...roles){ return (req,res,next)=> roles.includes(req.user.role) ? next() : res.status(403).json({error:'لا تملك صلاحية'}); }
function clean(s){ return String(s||'').trim(); }
function userPublic(u){ if(!u) return null; const {password_hash, ...x}=u; return x; }
function calcRating(techId){
  const r = db.prepare('SELECT AVG(stars) avg, COUNT(*) c FROM ratings WHERE technician_id=?').get(techId);
  db.prepare('UPDATE users SET rating_avg=?, rating_count=? WHERE id=?').run(Number(r.avg||0).toFixed(2), r.c||0, techId);
}

function safeEmit(room, event, payload){ try{ io.to(String(room)).emit(event, payload); }catch(e){} }
function getMessages(requestId){ return db.prepare('SELECT m.*,u.name sender_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE request_id=? ORDER BY id').all(requestId); }
function markChatRead(requestId, userId){
  const row = db.prepare('SELECT COALESCE(MAX(id),0) max_id FROM messages WHERE request_id=?').get(requestId);
  const last = Number(row?.max_id || 0);
  db.prepare(`INSERT INTO chat_reads(request_id,user_id,last_read_message_id,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(request_id,user_id) DO UPDATE SET last_read_message_id=excluded.last_read_message_id, updated_at=CURRENT_TIMESTAMP`).run(requestId, userId, last);
}

io.on('connection', (socket)=>{
  socket.on('join-request', (requestId)=>{ if(requestId) socket.join(String(requestId)); });
  socket.on('leave-request', (requestId)=>{ if(requestId) socket.leave(String(requestId)); });
});

app.get('/api/meta', (req,res)=>{
  res.json({
    services: db.prepare('SELECT * FROM service_categories ORDER BY name').all(),
    packages: db.prepare('SELECT * FROM packages WHERE is_active=1 ORDER BY amount').all(),
    paymentMethods: db.prepare('SELECT * FROM payment_methods').all(),
    cities: ['عمان','الزرقاء','إربد','البلقاء','المفرق','جرش','عجلون','مادبا','الكرك','الطفيلة','معان','العقبة']
  });
});

// ✅ التسجيل — يحفظ في pending_users ويبعت OTP
app.post('/api/auth/register', upload.single('avatar'), async (req,res)=>{
  const role = clean(req.body.role);
  const name = clean(req.body.name || req.body.full_name || req.body.fullName || req.body.username);
  const email = clean(req.body.email).toLowerCase();
  const phone = clean(req.body.phone);
  const password = String(req.body.password||'');
  const national_number = clean(req.body.national_number || req.body.nationalNumber);
  const city = clean(req.body.city);
  const services = Array.isArray(req.body.services) ? req.body.services.join(',') : clean(req.body.services);
  const areas = Array.isArray(req.body.areas) ? req.body.areas.join(',') : clean(req.body.areas);
  const avatar_url = req.file ? '/uploads/avatars/' + req.file.filename : '';
  if(!['customer','technician'].includes(role)) return res.status(400).json({error:'نوع الحساب غير صحيح'});
  if(name.length < 2) return res.status(400).json({error:'الرجاء إدخال الاسم الكامل'});
  if(role==='technician' && !avatar_url) return res.status(400).json({error:'الصورة الشخصية مطلوبة للفني فقط'});
  if(!validator.isEmail(email)) return res.status(400).json({error:'البريد غير صحيح'});
  if(!/^07\d{8}$/.test(phone)) return res.status(400).json({error:'رقم الهاتف يجب أن يبدأ 07 ويتكون من 10 أرقام'});
  if(password.length < 8) return res.status(400).json({error:'كلمة السر يجب أن تكون 8 أحرف على الأقل'});
  if(role==='technician' && !/^\d{10}$/.test(national_number)) return res.status(400).json({error:'الرقم الوطني يجب أن يكون 10 أرقام'});
  const existUser = db.prepare('SELECT id FROM users WHERE email=? OR phone=?').get(email, phone);
  if(existUser) return res.status(409).json({error:'البريد أو رقم الهاتف مستخدم مسبقاً'});
  if(role==='technician' && national_number){
    const existNat = db.prepare('SELECT id FROM users WHERE national_number=?').get(national_number);
    if(existNat) return res.status(409).json({error:'الرقم الوطني مستخدم مسبقاً'});
  }
  try{
    const hash = bcrypt.hashSync(password, 12);
    db.prepare('INSERT OR REPLACE INTO pending_users(role,name,email,phone,password_hash,national_number,city,services,areas,avatar_url) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(role,name,email,phone,hash, role==='technician'?national_number:null, city, services, areas, avatar_url);
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires = Date.now() + 10 * 60 * 1000;
    db.prepare('DELETE FROM otp_codes WHERE email=?').run(email);
    db.prepare('INSERT INTO otp_codes(email,code,expires_at) VALUES(?,?,?)').run(email, code, expires);
    await sendOtpEmail(email, code, name);
    res.json({ok:true, message:'تم إرسال كود التحقق إلى بريدك الإلكتروني', email});
  } catch(e){
    console.error('Register error:', e.message);
    if(String(e.message).includes('UNIQUE')) return res.status(409).json({error:'البريد أو رقم الهاتف أو الرقم الوطني مستخدم مسبقاً'});
    res.status(500).json({error:'تعذر إنشاء الحساب'});
  }
});

// ✅ التحقق من OTP
app.post('/api/auth/verify', (req,res)=>{
  const email = clean(req.body.email).toLowerCase();
  const code = clean(req.body.code);
  if(!email || !code) return res.status(400).json({error:'البريد والكود مطلوبان'});
  const otp = db.prepare('SELECT * FROM otp_codes WHERE email=? AND used=0 ORDER BY id DESC LIMIT 1').get(email);
  if(!otp) return res.status(400).json({error:'لم يتم إرسال كود لهذا البريد، سجّل مجدداً'});
  if(Date.now() > otp.expires_at) return res.status(400).json({error:'انتهت صلاحية الكود، اضغط إعادة الإرسال'});
  if(otp.code !== code) return res.status(400).json({error:'الكود غير صحيح'});
  db.prepare('UPDATE otp_codes SET used=1 WHERE id=?').run(otp.id);
  const pending = db.prepare('SELECT * FROM pending_users WHERE email=?').get(email);
  if(!pending) return res.status(400).json({error:'بيانات التسجيل غير موجودة، سجّل مجدداً'});
  try{
    const info = db.prepare('INSERT INTO users(role,name,email,phone,password_hash,national_number,city,services,areas,avatar_url) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(pending.role,pending.name,pending.email,pending.phone,pending.password_hash,pending.national_number,pending.city,pending.services,pending.areas,pending.avatar_url);
    db.prepare('DELETE FROM pending_users WHERE email=?').run(email);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
    const token = sign(user);
    res.cookie('token', token, AUTH_COOKIE_OPTS);
    res.json({ok:true, token, user:userPublic(user)});
  }catch(e){
    if(String(e.message).includes('UNIQUE')) return res.status(409).json({error:'الحساب موجود مسبقاً'});
    res.status(500).json({error:'تعذر إنشاء الحساب'});
  }
});

// 🔄 إعادة إرسال OTP
app.post('/api/auth/resend-otp', async (req,res)=>{
  const email = clean(req.body.email).toLowerCase();
  const pending = db.prepare('SELECT * FROM pending_users WHERE email=?').get(email);
  if(!pending) return res.status(400).json({error:'لا يوجد طلب تسجيل لهذا البريد'});
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expires = Date.now() + 10 * 60 * 1000;
  db.prepare('DELETE FROM otp_codes WHERE email=?').run(email);
  db.prepare('INSERT INTO otp_codes(email,code,expires_at) VALUES(?,?,?)').run(email, code, expires);
  await sendOtpEmail(email, code, pending.name);
  res.json({ok:true, message:'تم إعادة إرسال الكود'});
});

app.post('/api/auth/login', (req,res)=>{
  const email = clean(req.body.email).toLowerCase(); const password = String(req.body.password||'');
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if(!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({error:'بيانات الدخول غير صحيحة'});
  if(!user.is_active) return res.status(403).json({error:'الحساب موقوف'});
  const token = sign(user); res.cookie('token', token, AUTH_COOKIE_OPTS); res.json({token,user:userPublic(user)});
});
app.post('/api/auth/logout', (req,res)=>{ res.clearCookie('token'); res.json({ok:true}); });
app.get('/api/me', auth, (req,res)=> res.json({user:userPublic(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id))}));

app.get('/api/technicians', auth, (req,res)=>{
  const service=clean(req.query.service), city=clean(req.query.city), area=clean(req.query.area), q=clean(req.query.q);
  let sql="SELECT id,name,phone,city,areas,services,avatar_url,rating_avg,rating_count,completed_jobs,balance,free_orders_used,is_active FROM users WHERE role='technician' AND is_active=1";
  const params=[];
  const wanted = service || q;
  if(wanted){ sql += " AND (services LIKE ? OR name LIKE ?)"; params.push('%'+wanted+'%', '%'+wanted+'%'); }
  if(city){ sql += " AND (city=? OR areas LIKE ?)"; params.push(city, '%'+city+'%'); }
  if(area){ sql += " AND (areas LIKE ? OR city=?)"; params.push('%'+area+'%', city||area); }
  sql += ' ORDER BY rating_avg DESC, completed_jobs DESC, created_at DESC';
  res.json({technicians: db.prepare(sql).all(...params)});
});

app.post('/api/requests', auth, requireRole('customer'), upload.single('problem_image'), (req,res)=>{
  const {service,city,area,description,preferred_time} = req.body;
  const lat = req.body.lat ? Number(req.body.lat) : null;
  const lng = req.body.lng ? Number(req.body.lng) : null;
  const problemImage = req.file ? '/uploads/requests/' + req.file.filename : '';
  if(!clean(service)||!clean(city)||clean(description).length<10) return res.status(400).json({error:'أكمل بيانات الطلب: الخدمة، المحافظة، ووصف لا يقل عن 10 أحرف'});
  const info = db.prepare('INSERT INTO requests(customer_id,service,city,area,lat,lng,description,preferred_time,problem_image_url,status) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(req.user.id, clean(service), clean(city), clean(area), lat, lng, clean(description), clean(preferred_time), problemImage, 'بانتظار العروض');
  const request = db.prepare('SELECT * FROM requests WHERE id=?').get(info.lastInsertRowid);
  io.emit('requests-updated', { request });
  safeEmit(request.id, 'request-status-updated', { request });
  res.json({request});
});
app.get('/api/requests', auth, (req,res)=>{
  let rows;
  if(req.user.role==='admin') rows = db.prepare('SELECT r.*, c.name customer_name, t.name technician_name FROM requests r JOIN users c ON c.id=r.customer_id LEFT JOIN users t ON t.id=r.technician_id ORDER BY r.id DESC').all();
  else if(req.user.role==='customer') rows = db.prepare('SELECT r.*, t.name technician_name FROM requests r LEFT JOIN users t ON t.id=r.technician_id WHERE customer_id=? ORDER BY r.id DESC').all(req.user.id);
  else rows = [];
  if(req.user.role==='technician') {
    const me = db.prepare('SELECT services,city,areas FROM users WHERE id=?').get(req.user.id);
    const sv = (me.services||'').split(',').filter(Boolean);
    rows = db.prepare('SELECT r.*, c.name customer_name FROM requests r JOIN users c ON c.id=r.customer_id ORDER BY r.id DESC').all()
      .filter(r => r.technician_id===req.user.id || (['بانتظار العروض','وصلت عروض'].includes(r.status) && sv.includes(r.service) && ((me.areas||'').includes(r.city) || me.city===r.city)));
  }
  res.json({requests: rows});
});
app.delete('/api/requests/:id', auth, requireRole('customer'), (req,res)=>{
  const r=db.prepare('SELECT * FROM requests WHERE id=? AND customer_id=?').get(req.params.id, req.user.id);
  if(!r) return res.status(404).json({error:'الطلب غير موجود'});
  if(['مكتمل'].includes(r.status)) return res.status(400).json({error:'لا يمكن حذف طلب مكتمل من السجل'});
  db.prepare("UPDATE offers SET status='rejected', updated_at=CURRENT_TIMESTAMP WHERE request_id=? AND status='pending'").run(r.id);
  db.prepare("UPDATE requests SET status='ملغي', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(r.id);
  const request=db.prepare('SELECT * FROM requests WHERE id=?').get(r.id);
  io.emit('requests-updated',{request});
  safeEmit(r.id,'request-status-updated',{request});
  res.json({request});
});
app.post('/api/requests/:id/offer', auth, requireRole('technician'), (req,res)=>{
  const r = db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
  if(!r) return res.status(404).json({error:'الطلب غير موجود'});
  if(r.status!=='بانتظار العروض') return res.status(400).json({error:'هذا الطلب لم يعد يستقبل عروضاً'});
  const active = db.prepare("SELECT id, service FROM requests WHERE technician_id=? AND status IN ('تم اختيار عرض','قيد التنفيذ','بانتظار تأكيد الدفع') AND id<>? ORDER BY id DESC LIMIT 1").get(req.user.id, r.id);
  if(active) return res.status(409).json({error:`لا يمكنك إرسال عرض جديد قبل إنهاء طلبك الحالي رقم ${active.id} - ${active.service}`});
  const price = Number(req.body.offer_price);
  const duration = clean(req.body.duration || req.body.arrival_time);
  const note = clean(req.body.note || '');
  if(!price || price<1) return res.status(400).json({error:'أدخل سعر صحيح'});
  if(!duration) return res.status(400).json({error:'أدخل مدة التنفيذ أو الوصول'});
  db.prepare(`INSERT INTO offers(request_id,technician_id,price,duration,note,status) VALUES(?,?,?,?,?,'pending')
    ON CONFLICT(request_id,technician_id) DO UPDATE SET price=excluded.price,duration=excluded.duration,note=excluded.note,status='pending',updated_at=CURRENT_TIMESTAMP`)
    .run(r.id, req.user.id, price, duration, note);
  db.prepare("UPDATE requests SET status='وصلت عروض', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='بانتظار العروض'").run(r.id);
  const request = db.prepare('SELECT * FROM requests WHERE id=?').get(r.id);
  io.emit('requests-updated', { request });
  safeEmit(r.id, 'request-status-updated', { request });
  res.json({request});
});

app.get('/api/requests/:id/offers', auth, (req,res)=>{
  const r = db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
  if(!r) return res.status(404).json({error:'الطلب غير موجود'});
  const allowed = req.user.role==='admin' || r.customer_id===req.user.id || r.technician_id===req.user.id || req.user.role==='technician';
  if(!allowed) return res.status(403).json({error:'غير مصرح'});
  let rows = db.prepare(`SELECT o.*, u.name technician_name, u.city technician_city, u.areas technician_areas, u.avatar_url, u.rating_avg, u.rating_count, u.completed_jobs
    FROM offers o JOIN users u ON u.id=o.technician_id WHERE o.request_id=? ORDER BY CASE o.status WHEN 'accepted' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, o.id DESC`).all(r.id);
  if(req.user.role==='technician' && r.customer_id!==req.user.id && r.technician_id!==req.user.id) rows = rows.filter(o=>o.technician_id===req.user.id);
  res.json({offers:rows, request:r});
});

app.post('/api/offers/:id/decision', auth, requireRole('customer'), (req,res)=>{
  const offer = db.prepare('SELECT o.*, r.customer_id, r.status request_status FROM offers o JOIN requests r ON r.id=o.request_id WHERE o.id=?').get(req.params.id);
  if(!offer) return res.status(404).json({error:'العرض غير موجود'});
  if(offer.customer_id!==req.user.id) return res.status(403).json({error:'هذا العرض لا يخصك'});
  const decision = clean(req.body.decision);
  if(!['accepted','rejected'].includes(decision)) return res.status(400).json({error:'قرار غير صحيح'});
  if(decision==='rejected'){
    db.prepare("UPDATE offers SET status='rejected', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(offer.id);
    const pending = db.prepare("SELECT COUNT(*) c FROM offers WHERE request_id=? AND status='pending'").get(offer.request_id).c;
    db.prepare("UPDATE requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND technician_id IS NULL").run(pending?'وصلت عروض':'بانتظار العروض', offer.request_id);
  } else {
    const active = db.prepare("SELECT id FROM requests WHERE technician_id=? AND status IN ('تم اختيار عرض','قيد التنفيذ','بانتظار تأكيد الدفع') LIMIT 1").get(offer.technician_id);
    if(active) return res.status(409).json({error:'الفني أصبح لديه طلب نشط حالياً، اختر عرضاً آخر'});
    db.prepare("UPDATE offers SET status='rejected', updated_at=CURRENT_TIMESTAMP WHERE request_id=?").run(offer.request_id);
    db.prepare("UPDATE offers SET status='accepted', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(offer.id);
    db.prepare("UPDATE requests SET technician_id=?, offer_price=?, arrival_time=?, status='تم اختيار عرض', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(offer.technician_id, offer.price, offer.duration, offer.request_id);
  }
  const request = db.prepare('SELECT * FROM requests WHERE id=?').get(offer.request_id);
  const offers = db.prepare('SELECT * FROM offers WHERE request_id=? ORDER BY id DESC').all(offer.request_id);
  io.emit('requests-updated', { request });
  safeEmit(offer.request_id, 'request-status-updated', { request });
  res.json({request, offers});
});
app.post('/api/requests/:id/status', auth, (req,res)=>{
  const r = db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
  if(!r) return res.status(404).json({error:'الطلب غير موجود'});
  const status = clean(req.body.status);
  const allowed=['قيد التنفيذ','بانتظار تأكيد الدفع','مكتمل','ملغي'];
  if(!allowed.includes(status)) return res.status(400).json({error:'حالة غير صحيحة'});
  if(req.user.role!=='admin' && req.user.id!==r.customer_id && req.user.id!==r.technician_id) return res.status(403).json({error:'لا تملك صلاحية'});
  if(status==='مكتمل' && req.user.role!=='admin' && req.user.id!==r.customer_id) return res.status(403).json({error:'إكمال الطلب يكون من العميل فقط'});
  if(status==='مكتمل' && r.technician_id && !r.commission_charged){
    const tech = db.prepare('SELECT * FROM users WHERE id=?').get(r.technician_id);
    let charge = 0;
    if(tech.free_orders_used < 2){
      db.prepare('UPDATE users SET free_orders_used=free_orders_used+1, completed_jobs=completed_jobs+1 WHERE id=?').run(tech.id);
      db.prepare('INSERT INTO ledger(user_id,type,amount,balance_after,note) VALUES(?,?,?,?,?)').run(tech.id,'طلب مجاني',0,tech.balance,'تم احتساب الطلب ضمن أول طلبين مجانيين');
    } else {
      charge = 2;
      if(tech.balance < charge) return res.status(400).json({error:'رصيد الفني غير كافٍ لإكمال الطلب. يجب شحن الرصيد أولاً.'});
      const after = Number((tech.balance - charge).toFixed(2));
      db.prepare('UPDATE users SET balance=?, completed_jobs=completed_jobs+1 WHERE id=?').run(after, tech.id);
      db.prepare('INSERT INTO ledger(user_id,type,amount,balance_after,note) VALUES(?,?,?,?,?)').run(tech.id,'خصم عمولة طلب',-charge,after,`خصم عمولة الطلب رقم ${r.id}`);
    }
    db.prepare('UPDATE requests SET commission_charged=? WHERE id=?').run(charge, r.id);
  }
  db.prepare('UPDATE requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, r.id);
  const request = db.prepare('SELECT * FROM requests WHERE id=?').get(r.id);
  io.emit('requests-updated', { request });
  safeEmit(r.id, 'request-status-updated', { request });
  res.json({request});
});

function normalizeChatText(input){
  let s=String(input||'').toLowerCase();
  const ar='٠١٢٣٤٥٦٧٨٩', fa='۰۱۲۳۴۵۶۷۸۹';
  s=s.replace(/[٠-٩]/g,ch=>String(ar.indexOf(ch))).replace(/[۰-۹]/g,ch=>String(fa.indexOf(ch))).replace(/[oO]/g,'0');
  s=s.replace(/[\u064B-\u065F\u0670ـ\s\-_.()\[\]{}|\\/,:;،]+/g,'');
  return s;
}
function chatViolationReason(body){
  const original=String(body||'');
  const lower=String(body||'').toLowerCase()
    .replace(/[٠-٩]/g,ch=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(ch)))
    .replace(/[۰-۹]/g,ch=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(ch)))
    .replace(/[oO]/g,'0');
  const compact=normalizeChatText(original);
  const groups=[
    {reason:'واتساب', words:['واتساب','واتس','وتساب','whatsapp','watsapp','wa.me','wa me']},
    {reason:'تيليجرام', words:['تيليجرام','تليجرام','تلجرام','telegram','t.me','t me']},
    {reason:'فيسبوك أو ماسنجر', words:['facebook','fb.com','fb com','messenger','فيسبوك','ماسنجر']},
    {reason:'إنستغرام أو سناب', words:['instagram','insta','انستا','إنستا','snapchat','سناب']},
    {reason:'بريد إلكتروني', words:['gmail.com','hotmail.com','outlook.com','yahoo.com','gmail','hotmail','outlook','yahoo']}
  ];
  for(const g of groups){
    for(const w of g.words){
      const wl=String(w).toLowerCase();
      const wc=normalizeChatText(w);
      if((wl && lower.includes(wl)) || (wc && compact.includes(wc))) return g.reason;
    }
  }
  if(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(original)) return 'بريد إلكتروني';
  const digits=lower.replace(/[^0-9+]/g,'');
  const separated=lower.replace(/[^0-9]/g,'');
  if(/(\+?962|00962)?0?7[789]\d{7}/.test(digits) || /(962|00962)?0?7[789]\d{7}/.test(separated)) return 'رقم هاتف';
  if(/\d{10,}/.test(separated)) return 'رقم هاتف';
  if(separated.length>=9 && /^(0?7|9627|009627)/.test(separated)) return 'رقم هاتف';
  return '';
}
function rejectBlockedChat(req,res,r,body){
  const reason=chatViolationReason(body);
  if(!reason) return false;
  db.prepare('INSERT INTO chat_violations(request_id,user_id,body,reason) VALUES(?,?,?,?)').run(r.id, req.user.id, String(body||'').slice(0,500), reason);
  return res.status(400).json({error:'⚠️ الرسائل العادية مسموحة. الممنوع فقط مشاركة رقم هاتف أو واتساب أو تيليجرام أو إيميل أو روابط تواصل خارجية.'});
}

app.post('/api/requests/:id/messages', auth, (req,res)=>{
  const r=db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
  if(!r) return res.status(404).json({error:'الطلب غير موجود'});
  const hasOffer = req.user.role==='technician' ? db.prepare('SELECT id FROM offers WHERE request_id=? AND technician_id=? LIMIT 1').get(r.id, req.user.id) : null;
  if(req.user.role!=='admin' && req.user.id!==r.customer_id && req.user.id!==r.technician_id && !hasOffer) return res.status(403).json({error:'لا تملك صلاحية'});
  const body=clean(req.body.body); if(body.length<1) return res.status(400).json({error:'الرسالة فارغة'});
  if(rejectBlockedChat(req,res,r,body)) return;
  db.prepare('INSERT INTO messages(request_id,sender_id,body) VALUES(?,?,?)').run(r.id,req.user.id,body);
  markChatRead(r.id, req.user.id);
  const messages = getMessages(r.id);
  safeEmit(r.id, 'messages-updated', { requestId:r.id, messages });
  io.emit('chat-badges-updated', { requestId:r.id });
  res.json({messages});
});

app.post('/api/requests/:id/audio', auth, uploadAudio.single('audio'), (req,res)=>{
  const r=db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
  if(!r) return res.status(404).json({error:'الطلب غير موجود'});
  const hasOffer = req.user.role==='technician' ? db.prepare('SELECT id FROM offers WHERE request_id=? AND technician_id=? LIMIT 1').get(r.id, req.user.id) : null;
  if(req.user.role!=='admin' && req.user.id!==r.customer_id && req.user.id!==r.technician_id && !hasOffer) return res.status(403).json({error:'لا تملك صلاحية'});
  if(!req.file) return res.status(400).json({error:'لم يتم استقبال التسجيل الصوتي'});
  const url='/uploads/audios/'+req.file.filename;
  const body='[audio]'+url;
  db.prepare('INSERT INTO messages(request_id,sender_id,body) VALUES(?,?,?)').run(r.id,req.user.id,body);
  markChatRead(r.id, req.user.id);
  const messages = getMessages(r.id);
  safeEmit(r.id, 'messages-updated', { requestId:r.id, messages });
  io.emit('chat-badges-updated', { requestId:r.id });
  res.json({messages});
});

app.get('/api/requests/:id/messages', auth, (req,res)=>{
  const r=db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
  if(!r) return res.status(404).json({error:'الطلب غير موجود'});
  const hasOffer = req.user.role==='technician' ? db.prepare('SELECT id FROM offers WHERE request_id=? AND technician_id=? LIMIT 1').get(r.id, req.user.id) : null;
  if(req.user.role!=='admin' && req.user.id!==r.customer_id && req.user.id!==r.technician_id && !hasOffer) return res.status(403).json({error:'لا تملك صلاحية'});
  markChatRead(r.id, req.user.id);
  io.emit('chat-badges-updated', { requestId:r.id });
  res.json({messages: getMessages(req.params.id)});
});
app.post('/api/requests/:id/rate', auth, requireRole('customer'), (req,res)=>{
  const r=db.prepare('SELECT * FROM requests WHERE id=? AND customer_id=? AND status=?').get(req.params.id, req.user.id, 'مكتمل');
  if(!r || !r.technician_id) return res.status(400).json({error:'لا يمكن تقييم هذا الطلب'});
  const stars=Number(req.body.stars); if(stars<1||stars>5) return res.status(400).json({error:'اختر تقييم من 1 إلى 5'});
  try{ db.prepare('INSERT INTO ratings(request_id,technician_id,customer_id,stars,comment) VALUES(?,?,?,?,?)').run(r.id,r.technician_id,req.user.id,stars,clean(req.body.comment)); calcRating(r.technician_id); safeEmit(r.id, 'rated', {requestId:r.id, stars}); res.json({ok:true}); }
  catch{ res.status(409).json({error:'تم تقييم هذا الطلب مسبقاً'}); }
});

app.post('/api/topups', auth, requireRole('technician'), upload.single('receipt'), (req,res)=>{
  const pkg = db.prepare('SELECT * FROM packages WHERE id=? AND is_active=1').get(req.body.package_id);
  if(!pkg) return res.status(404).json({error:'الباقة غير موجودة'});
  if(!req.file) return res.status(400).json({error:'يجب رفع صورة إثبات الدفع'});
  const receipt_url='/uploads/payments/'+req.file.filename;
  const info=db.prepare('INSERT INTO topups(technician_id,package_id,amount,bonus,receipt_url) VALUES(?,?,?,?,?)').run(req.user.id,pkg.id,pkg.amount,pkg.bonus,receipt_url);
  res.json({topup: db.prepare('SELECT * FROM topups WHERE id=?').get(info.lastInsertRowid)});
});
app.get('/api/topups', auth, (req,res)=>{
  if(req.user.role==='admin') return res.json({topups: db.prepare('SELECT tp.*,u.name technician_name,u.phone,p.name package_name FROM topups tp JOIN users u ON u.id=tp.technician_id JOIN packages p ON p.id=tp.package_id ORDER BY tp.id DESC').all()});
  res.json({topups: db.prepare('SELECT tp.*,p.name package_name FROM topups tp JOIN packages p ON p.id=tp.package_id WHERE technician_id=? ORDER BY id DESC').all(req.user.id)});
});
app.post('/api/admin/topups/:id/review', auth, requireRole('admin'), (req,res)=>{
  const t=db.prepare('SELECT * FROM topups WHERE id=?').get(req.params.id);
  if(!t || t.status!=='pending') return res.status(400).json({error:'طلب الشحن غير صالح'});
  const status=clean(req.body.status);
  if(!['approved','rejected'].includes(status)) return res.status(400).json({error:'قرار غير صحيح'});
  if(status==='approved'){
    const tech=db.prepare('SELECT * FROM users WHERE id=?').get(t.technician_id);
    const add=Number(t.amount)+Number(t.bonus||0); const after=Number((tech.balance+add).toFixed(2));
    db.prepare('UPDATE users SET balance=? WHERE id=?').run(after, tech.id);
    db.prepare('INSERT INTO ledger(user_id,type,amount,balance_after,note) VALUES(?,?,?,?,?)').run(tech.id,'شحن رصيد',add,after,`موافقة على طلب شحن رقم ${t.id}`);
  }
  db.prepare('UPDATE topups SET status=?, admin_note=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?').run(status, clean(req.body.admin_note), t.id);
  res.json({topup: db.prepare('SELECT * FROM topups WHERE id=?').get(t.id)});
});

app.get('/api/ledger', auth, (req,res)=>{
  const id = req.user.role==='admin' && req.query.user_id ? req.query.user_id : req.user.id;
  res.json({ledger: db.prepare('SELECT * FROM ledger WHERE user_id=? ORDER BY id DESC').all(id)});
});
app.post('/api/me/profile', auth, (req,res)=>{
  const name = clean(req.body.name);
  const phone = clean(req.body.phone);
  const city = clean(req.body.city);
  const areas = clean(req.body.areas || req.body.area);
  if(name.length < 2) return res.status(400).json({error:'الاسم قصير'});
  if(phone.length < 7) return res.status(400).json({error:'رقم الهاتف غير صحيح'});
  db.prepare('UPDATE users SET name=?, phone=?, city=?, areas=? WHERE id=?').run(name, phone, city, areas, req.user.id);
  res.json({user:userPublic(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id))});
});
app.post('/api/me/password', auth, (req,res)=>{
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if(!bcrypt.compareSync(current, user.password_hash)) return res.status(400).json({error:'كلمة السر الحالية غير صحيحة'});
  if(next.length < 8) return res.status(400).json({error:'كلمة السر الجديدة يجب أن تكون 8 أحرف على الأقل'});
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(next, 12), req.user.id);
  res.json({ok:true});
});

app.get('/api/admin/stats', auth, requireRole('admin'), (req,res)=>{
  const one = q => db.prepare(q).get().c;
  res.json({stats:{customers:one("SELECT COUNT(*) c FROM users WHERE role='customer'"), technicians:one("SELECT COUNT(*) c FROM users WHERE role='technician'"), requests:one('SELECT COUNT(*) c FROM requests'), pendingTopups:one("SELECT COUNT(*) c FROM topups WHERE status='pending'"), completed:one("SELECT COUNT(*) c FROM requests WHERE status='مكتمل'")}});
});
app.get('/api/admin/users', auth, requireRole('admin'), (req,res)=> res.json({users: db.prepare('SELECT id,role,name,email,phone,national_number,city,areas,services,is_active,balance,free_orders_used,rating_avg,rating_count,completed_jobs,created_at FROM users ORDER BY id DESC').all()}));
app.post('/api/admin/users/:id/toggle', auth, requireRole('admin'), (req,res)=>{ const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id); db.prepare('UPDATE users SET is_active=? WHERE id=?').run(u.is_active?0:1,u.id); res.json({ok:true}); });

app.post('/api/admin/services', auth, requireRole('admin'), (req,res)=>{
  const name = clean(req.body.name);
  const icon = clean(req.body.icon) || '🔧';
  if(name.length < 2) return res.status(400).json({error:'اسم المهنة قصير'});
  try{
    const info = db.prepare('INSERT INTO service_categories(name,icon) VALUES(?,?)').run(name, icon);
    res.json({service: db.prepare('SELECT * FROM service_categories WHERE id=?').get(info.lastInsertRowid)});
  }catch(e){
    if(String(e.message).includes('UNIQUE')) return res.status(409).json({error:'هذه المهنة موجودة مسبقاً'});
    res.status(500).json({error:'تعذر إضافة المهنة'});
  }
});

app.post('/api/admin/packages', auth, requireRole('admin'), (req,res)=>{ const {name,amount,bonus,commission_per_order}=req.body; const info=db.prepare('INSERT INTO packages(name,amount,bonus,commission_per_order) VALUES(?,?,?,?)').run(clean(name),Number(amount),Number(bonus||0),Number(commission_per_order||2)); res.json({package:db.prepare('SELECT * FROM packages WHERE id=?').get(info.lastInsertRowid)}); });

app.get('/api/chat-violations', auth, requireRole('admin'), (req,res)=>{
  const rows=db.prepare(`SELECT v.*,u.name user_name,u.email user_email,r.service,r.status FROM chat_violations v LEFT JOIN users u ON u.id=v.user_id LEFT JOIN requests r ON r.id=v.request_id ORDER BY v.id DESC LIMIT 200`).all();
  res.json({violations:rows});
});

app.get('/api/chats', auth, (req,res)=>{
  let rows=[];
  if(req.user.role==='customer'){
    rows=db.prepare(`SELECT r.id request_id,r.service,r.status,u.name other_name,
      (SELECT body FROM messages WHERE request_id=r.id ORDER BY id DESC LIMIT 1) last_body,
      (SELECT created_at FROM messages WHERE request_id=r.id ORDER BY id DESC LIMIT 1) last_at,
      (SELECT COUNT(*) FROM messages m LEFT JOIN chat_reads cr ON cr.request_id=m.request_id AND cr.user_id=? WHERE m.request_id=r.id AND m.sender_id<>? AND m.id>COALESCE(cr.last_read_message_id,0)) unread_count
      FROM requests r LEFT JOIN users u ON u.id=r.technician_id
      WHERE r.customer_id=? AND (r.technician_id IS NOT NULL OR EXISTS(SELECT 1 FROM messages m WHERE m.request_id=r.id))
      ORDER BY COALESCE(last_at,r.created_at) DESC`).all(req.user.id,req.user.id,req.user.id);
  }else if(req.user.role==='technician'){
    rows=db.prepare(`SELECT r.id request_id,r.service,r.status,u.name other_name,
      (SELECT body FROM messages WHERE request_id=r.id ORDER BY id DESC LIMIT 1) last_body,
      (SELECT created_at FROM messages WHERE request_id=r.id ORDER BY id DESC LIMIT 1) last_at,
      (SELECT COUNT(*) FROM messages m LEFT JOIN chat_reads cr ON cr.request_id=m.request_id AND cr.user_id=? WHERE m.request_id=r.id AND m.sender_id<>? AND m.id>COALESCE(cr.last_read_message_id,0)) unread_count
      FROM requests r JOIN users u ON u.id=r.customer_id
      WHERE r.technician_id=? OR EXISTS(SELECT 1 FROM offers o WHERE o.request_id=r.id AND o.technician_id=?)
      ORDER BY COALESCE(last_at,r.created_at) DESC`).all(req.user.id,req.user.id,req.user.id,req.user.id);
  }
  const total=rows.reduce((a,b)=>a+Number(b.unread_count||0),0);
  res.json({chats:rows,total_unread:total});
});

app.post('/api/support', auth, (req,res)=>{
  const {type,title,body}=req.body||{};
  if(!title || !body || String(body).length<10) return res.status(400).json({error:'اكتب عنوان وتفاصيل واضحة للدعم'});
  const info=db.prepare('INSERT INTO support_tickets(user_id,type,title,body) VALUES(?,?,?,?)').run(req.user.id, clean(type||'عام'), clean(title), clean(body));
  res.json({ticket:db.prepare('SELECT * FROM support_tickets WHERE id=?').get(info.lastInsertRowid)});
});
app.get('/api/support', auth, requireRole('admin'), (req,res)=>{
  res.json({tickets:db.prepare(`SELECT t.*,u.name user_name,u.role user_role,u.email FROM support_tickets t LEFT JOIN users u ON u.id=t.user_id ORDER BY t.id DESC`).all()});
});

app.use((err, req, res, next)=>{
  if(err){
    const msg = err.message || 'حدث خطأ في الخادم';
    if(String(msg).includes('File too large')) return res.status(400).json({error:'حجم الصورة كبير، الحد الأقصى 3MB'});
    return res.status(400).json({error:msg});
  }
  next();
});

app.get('*', (req,res)=> res.sendFile(path.join(BASE,'public','index.html')));
server.listen(PORT, ()=> console.log(`صلّحلي يعمل على http://localhost:${PORT}`));
