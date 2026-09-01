// routes/auth.routes.js — /api/auth/*, /api/me, /api/me/profile, /api/me/password
const express = require('express');
const fs = require('fs');
const path = require('path');
const validator = require('validator');
// [PERF-05] bcryptjs -> bcrypt (native, N-API, libuv threadpool) — [PERF-04]'s
// async chunking (setImmediate) stopped one slow bcrypt call from freezing
// *other* request types, but concurrent bcrypt calls still fully serialized
// against each other on the single JS thread (load-tested: 300 concurrent
// logins -> 0 completed within 60s+, while SQLite reads/writes handled
// 900-4800 req/s in the same run). Native bcrypt offloads the actual hashing
// to libuv's worker threads, so concurrent calls run genuinely in parallel
// instead of time-slicing one thread. Hash format unaffected — bcrypt is
// bcrypt regardless of implementation; verified directly (not assumed) that
// bcryptjs-produced $2a$ hashes already in the database still verify
// correctly via native bcrypt.compare(), so no rehash/migration is needed.
// Same require-name (`bcrypt`) keeps every call site below (`.hash`,
// `.compare`, cost factor 12) completely unchanged.
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/env');

module.exports = function (deps) {
  const { db } = deps;
  const { io } = deps.realtime;
  const { auth, upload, verifyImageMagicBytes } = deps.middleware;
  const { sign, sendOtpEmail } = deps.services;
  const { clean, userPublic, anonymizeUser } = deps.utils;
  const { COOKIE_OPTS, BASE, BLOCKING_REQUEST_STATUSES_SQL, FREE_TIER_QUOTA } = deps.constants;
  const { registerLimiter, loginLimiter, passwordResetLimiter } = deps.limiters;
  const router = express.Router();

  // ── STEP 1: تقبّل البيانات، تحقق منها، ابعث OTP ──────────────────────────
  // [PERF-HARDEN-03] راجع نفس تعليق FIX-DELETE-CRASH-01 بـutils/db-helpers.js:
  // أي راوت async بلا try/catch يحيط الجسم كاملاً، لو رمى استثناءً غير متوقّع
  // (خطأ قاعدة بيانات نادر، قرص ممتلئ...) يصبح "unhandled promise rejection"
  // يُسقط عملية Node بأكملها فوراً — يقطع اتصال كل المستخدمين المتصلين حينها،
  // وليس فقط هذا الطلب. أُثبت هذا فعلياً بتجربة مباشرة (Audit إنتاجية
  // 2026-07-19)، وهو نفس السبب الجذري الذي ضرب DELETE /me سابقاً بالضبط، لم
  // يكن قد طُبِّق بعد على باقي راوتات async المشابهة بهذا الملف. try/catch هنا
  // لا يغيّر أي مسار نجاح أو رسالة خطأ حالية (كل return res.status(...)
  // الموجودة تبقى كما هي تماماً) — يضيف فقط شبكة أمان لحالة الفشل غير المتوقّع.
  router.post('/auth/register', registerLimiter, upload.single('avatar'), verifyImageMagicBytes, async (req, res) => {
   try {
    const role = clean(req.body.role);
    const name = clean(req.body.name || req.body.full_name || req.body.fullName || req.body.username);
    const email = clean(req.body.email).toLowerCase();
    const phone = clean(req.body.phone);
    const password = String(req.body.password || '');
    const national_number = clean(req.body.national_number || req.body.nationalNumber);
    const city = clean(req.body.city);
    const services = Array.isArray(req.body.services) ? req.body.services.join(',') : clean(req.body.services);
    const areas = Array.isArray(req.body.areas) ? req.body.areas.join(',') : clean(req.body.areas);
    const avatar_filename = req.file ? req.file.filename : '';

    if (!['customer', 'technician'].includes(role)) return res.status(400).json({ error: 'نوع الحساب غير صحيح', code: 'REGISTER_INVALID_ROLE' });
    if (name.length < 2) return res.status(400).json({ error: 'الرجاء إدخال الاسم الكامل', code: 'REGISTER_NAME_TOO_SHORT' });
    if (name.length > 60) return res.status(400).json({ error: 'الاسم طويل جداً، الحد الأقصى 60 حرف', code: 'NAME_TOO_LONG_60' });
    if (role === 'technician' && !avatar_filename) return res.status(400).json({ error: 'الصورة الشخصية مطلوبة للفني فقط', code: 'REGISTER_TECH_AVATAR_REQUIRED' });
    // [SEC-FIX-EMPTYSERVICES-01] راجع DECISIONS.md — services لم تكن إلزامية
    // إطلاقاً للفني، بعكس avatar/national_number أعلاه/أسفل. فني يسجّل بلا أي
    // خدمة مسجَّلة يدخل بحساب لا يمكنه أبداً تلقي أي طلب متطابق (كل مطابقة
    // بالمنصة تعتمد على تقاطع services)، بلا أي تنبيه له وقت التسجيل بالسبب.
    if (role === 'technician' && !services) return res.status(400).json({ error: 'يجب اختيار خدمة واحدة على الأقل', code: 'REGISTER_TECH_SERVICES_REQUIRED' });
    if (!validator.isEmail(email)) return res.status(400).json({ error: 'البريد غير صحيح', code: 'EMAIL_INVALID' });
    if (email.length > 100) return res.status(400).json({ error: 'البريد الإلكتروني طويل جداً', code: 'REGISTER_EMAIL_TOO_LONG' });
    if (!/^07\d{8}$/.test(phone)) return res.status(400).json({ error: 'رقم الهاتف يجب أن يبدأ 07 ويتكون من 10 أرقام', code: 'PHONE_INVALID_FORMAT' });
    if (password.length < 8) return res.status(400).json({ error: 'كلمة السر يجب أن تكون 8 أحرف على الأقل', code: 'PASSWORD_TOO_SHORT_8' });
    if (password.length > 72) return res.status(400).json({ error: 'كلمة السر طويلة جداً، الحد الأقصى 72 حرف', code: 'PASSWORD_TOO_LONG_72' });
    if (role === 'technician' && !/^\d{10}$/.test(national_number)) return res.status(400).json({ error: 'الرقم الوطني يجب أن يكون 10 أرقام', code: 'REGISTER_INVALID_NATIONAL_NUMBER' });
    if (city.length > 50) return res.status(400).json({ error: 'اسم المدينة طويل جداً', code: 'CITY_TOO_LONG' });
    if (services.length > 500) return res.status(400).json({ error: 'الخدمات طويلة جداً', code: 'REGISTER_SERVICES_TOO_LONG' });
    if (areas.length > 500) return res.status(400).json({ error: 'المناطق طويلة جداً', code: 'REGISTER_AREAS_TOO_LONG' });

    if (db.prepare('SELECT id FROM users WHERE email=?').get(email))
      return res.status(409).json({ error: 'البريد الإلكتروني مستخدم مسبقاً', code: 'REGISTER_EMAIL_TAKEN' });
    if (db.prepare('SELECT id FROM users WHERE phone=?').get(phone))
      return res.status(409).json({ error: 'رقم الهاتف مستخدم مسبقاً', code: 'REGISTER_PHONE_TAKEN' });

    // [PERF-04] bcrypt.hashSync كانت تحجز حلقة الحدث بالكامل (~350ms لكل
    // استدعاء عند cost=12) — أي طلب آخر لأي مستخدم آخر على المنصة يتوقف
    // تماماً خلال هذه المدة. bcrypt.hash غير المتزامنة (bcryptjs) تُقسّم
    // نفس الحساب على دفعات عبر setImmediate داخلياً، فتسمح لحلقة الحدث
    // بمعالجة طلبات أخرى بينها — نفس النتيجة الأمنية والتكلفة الحسابية
    // تماماً (cost factor 12 بلا تغيير)، فقط بدون حجز العملية بأكملها.
    const hash = await bcrypt.hash(password, 12);
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const otp_expires = Date.now() + 10 * 60 * 1000;

    db.prepare('DELETE FROM pending_users WHERE email=?').run(email);
    db.prepare('INSERT INTO pending_users(email,otp,otp_expires,data,avatar_filename) VALUES(?,?,?,?,?)')
      .run(email, otp, otp_expires, JSON.stringify({ role, name, email, phone, hash, national_number, city, services, areas }), avatar_filename);

    const sent = await sendOtpEmail(email, otp, name);
    if (!sent) return res.status(500).json({ error: 'تعذر إرسال البريد، حاول مرة أخرى', code: 'EMAIL_SEND_FAILED' });

    res.json({ ok: true, step: 'verify', message: 'تم إرسال كود التحقق إلى بريدك الإلكتروني', email });
   } catch (e) {
     console.error('register failed:', e.message);
     res.status(500).json({ error: 'تعذر إنشاء الحساب، حاول مرة أخرى', code: 'REGISTER_FAILED' });
   }
  });

  // ── STEP 2: التحقق من OTP وإنشاء الحساب ─────────────────────────────────
  // [PERF-HARDEN-04] الوحيد بين مسارات هذا الملف بلا أي حد طلبات على مستوى
  // IP — بعكس /auth/login و/auth/register و/auth/forgot-password و
  // /auth/reset-password (جميعها محمية أدناه). الحماية الحالية (5 محاولات
  // لكل سجل معلَّق قبل حذفه) تبقى كما هي دون تغيير؛ loginLimiter هنا حد
  // إضافي على مستوى IP بنفس شكل تهديد محاولات تخمين متكررة — نفس المحدِّد
  // المُستخدَم أصلاً لتسجيل الدخول بهذا الملف بالذات، وليس registerLimiter
  // (مصمَّم لمعدّل إنشاء حسابات بالساعة، لا لتخمين كود).
  router.post('/auth/verify-otp', loginLimiter, (req, res) => {
    const email = clean(req.body.email).toLowerCase();
    const otp = clean(req.body.otp);

    // [PERF-HARDEN-03] ORDER BY id DESC — بلا هذا، لو وُجد أكثر من صف معلّق
    // بنفس الإيميل (نافذة تسابق ضيقة: طلبَي تسجيل/إعادة تعيين متزامنَين
    // فعلياً لنفس الإيميل، بينهما نقطة await واحدة بجسم /auth/register تسمح
    // لطلب آخر بالتنفيذ في المنتصف)، .get() بلا ترتيب صريح قد يُرجع أقدم صف
    // بدل آخر محاولة فعلية للمستخدم — فيُقارَن الكود المُدخَل بكود قديم مختلف.
    // DELETE-ثم-INSERT بمسار /auth/register يمنع هذا بالمسار الطبيعي المتسلسل؛
    // هذا فقط يجعل الحالة النادرة المتبقية سلوكها صحيحاً (يأخذ الأحدث دائماً)
    // بدل الاعتماد على ترتيب غير مضمون بمحرك SQLite.
    const pending = db.prepare('SELECT * FROM pending_users WHERE email=? ORDER BY id DESC LIMIT 1').get(email);
    if (!pending) return res.status(400).json({ error: 'لا يوجد طلب تسجيل لهذا البريد، أعد التسجيل', code: 'OTP_NO_PENDING_REGISTER' });

    if (Date.now() > pending.otp_expires) {
      db.prepare('DELETE FROM pending_users WHERE email=?').run(email);
      return res.status(400).json({ error: 'انتهت صلاحية الكود، أعد التسجيل', code: 'OTP_EXPIRED_REGISTER' });
    }

    if (pending.attempts >= 5) {
      db.prepare('DELETE FROM pending_users WHERE email=?').run(email);
      return res.status(400).json({ error: 'محاولات كثيرة، أعد التسجيل', code: 'OTP_TOO_MANY_ATTEMPTS_REGISTER' });
    }

    if (pending.otp !== otp) {
      db.prepare('UPDATE pending_users SET attempts=attempts+1 WHERE email=?').run(email);
      const left = 5 - (pending.attempts + 1);
      return res.status(400).json({ error: `الكود غير صحيح. تبقى لك ${left} محاولات`, code: 'OTP_INCORRECT', params: { left } });
    }

    try {
      const d = JSON.parse(pending.data);
      const avatar_url = pending.avatar_filename ? '/uploads/avatars/' + pending.avatar_filename : '';
      const info = db.prepare('INSERT INTO users(role,name,email,phone,password_hash,national_number,city,services,areas,avatar_url,is_active) VALUES(?,?,?,?,?,?,?,?,?,?,1)')
        .run(d.role, d.name, d.email, d.phone, d.hash, d.role === 'technician' ? d.national_number : null, d.city, d.services, d.areas, avatar_url);
      db.prepare('DELETE FROM pending_users WHERE email=?').run(email);
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
      const token = sign(user);
      res.cookie('token', token, COOKIE_OPTS);
      res.json({ user: userPublic(user), token, message: 'تم إنشاء الحساب بنجاح' });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'البريد أو رقم الهاتف مستخدم مسبقاً', code: 'REGISTER_DUPLICATE' });
      res.status(500).json({ error: 'تعذر إنشاء الحساب', code: 'ACCOUNT_CREATE_FAILED' });
    }
  });

  // [PERF-HARDEN-03] راجع تعليق [PERF-HARDEN-03] أعلى /auth/register — نفس
  // شبكة الأمان بالضبط، وهذا أكثر مسار بالتطبيق كله استدعاءً (كل محاولة دخول)،
  // فأي استثناء غير متوقّع هنا كان أخطر ما يمكن أن يُسقط الخادم بأكمله.
  router.post('/auth/login', loginLimiter, async (req, res) => {
   try {
    const email = clean(req.body.email).toLowerCase();
    const password = String(req.body.password || '');
    if (password.length > 72) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة', code: 'AUTH_INVALID_CREDENTIALS' });
    const DUMMY_HASH = '$2a$12$dummyhashtopreventtimingattacksonnonexistentaccounts111';
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    // Always run bcrypt to prevent user enumeration via timing difference
    const hashToCheck = user ? user.password_hash : DUMMY_HASH;
    // [PERF-04] هذا تحديداً أهم موقع بالكامل: bcrypt يُشغَّل على كل محاولة
    // دخول (بما فيها الفاشلة، عمداً لمنع timing attack) — كان يحجز الخادم
    // بأكمله لكل مستخدم آخر ~350ms لكل محاولة دخول تحدث على المنصة.
    const valid = await bcrypt.compare(password, hashToCheck);
    if (!user || !valid) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة', code: 'AUTH_INVALID_CREDENTIALS' });
    if (!user.is_active) return res.status(403).json({ error: 'الحساب موقوف', code: 'AUTH_ACCOUNT_SUSPENDED' });
    const token = sign(user); res.cookie('token', token, COOKIE_OPTS); res.json({ user: userPublic(user), token });
   } catch (e) {
     console.error('login failed:', e.message);
     res.status(500).json({ error: 'تعذر تسجيل الدخول، حاول مرة أخرى', code: 'LOGIN_FAILED' });
   }
  });
  // [SEC-FIX-09] لا يشترط auth() صراحة (يبقى نفس السلوك السابق تماماً حتى لو
  // كان التوكن منتهياً/غير صالح أصلاً — يرجع {ok:true} دائماً)، لكن لو كان
  // التوكن قابلاً لفك تشفيره فعلاً، نُبطل كل نسخه فوراً عبر token_version
  // (يشمل أي نسخة مسروقة كانت لا تزال صالحة حتى الآن) ونقطع أي اتصال
  // Socket.IO حي بهذا الحساب، بدل الانتظار حتى انتهاء صلاحية التوكن (7 أيام).
  router.post('/auth/logout', (req, res) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : req.cookies.token;
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id=?').run(decoded.id);
        io.in(`user-${decoded.id}`).disconnectSockets(true);
      } catch (e) {}
    }
    res.clearCookie('token');
    res.json({ ok: true });
  });

  // ── Forgot Password: خطوة 1 — إرسال OTP لإعادة التعيين ──────────────────
  // [PERF-HARDEN-03] راجع تعليق [PERF-HARDEN-03] أعلى /auth/register.
  router.post('/auth/forgot-password', passwordResetLimiter, async (req, res) => {
   try {
    const email = clean(req.body.email || '').toLowerCase();
    if (!validator.isEmail(email)) return res.status(400).json({ error: 'البريد الإلكتروني غير صحيح', code: 'FORGOT_PASSWORD_INVALID_EMAIL' });
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    // [SEC-FIX-04] No User Enumeration — always return the same message
    if (!user) {
      // Constant-time delay to prevent timing-based enumeration
      await new Promise(r => setTimeout(r, 350 + Math.floor(Math.random() * 200)));
      return res.json({ ok: true, message: 'إذا كان البريد مسجلاً لدينا، ستصلك رسالة التحقق خلال دقيقة' });
    }
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const otp_expires = Date.now() + 10 * 60 * 1000;
    db.prepare('DELETE FROM pending_users WHERE email=?').run(email);
    db.prepare('INSERT INTO pending_users(email,otp,otp_expires,data,avatar_filename) VALUES(?,?,?,?,?)')
      .run(email, otp, otp_expires, JSON.stringify({ type: 'reset', userId: user.id }), '');
    const sent = await sendOtpEmail(email, otp, user.name);
    if (!sent) return res.status(500).json({ error: 'تعذر إرسال البريد، حاول مرة أخرى', code: 'EMAIL_SEND_FAILED' });
    res.json({ ok: true, message: 'تم إرسال كود التحقق على بريدك الإلكتروني' });
   } catch (e) {
     console.error('forgot-password failed:', e.message);
     res.status(500).json({ error: 'تعذر إرسال البريد، حاول مرة أخرى', code: 'EMAIL_SEND_FAILED' });
   }
  });

  // ── Forgot Password: خطوة 2 — التحقق وإعادة التعيين ─────────────────────
  router.post('/auth/reset-password', passwordResetLimiter, async (req, res) => {
    const email = clean(req.body.email || '').toLowerCase();
    const otp = clean(req.body.otp || '');
    const newPassword = String(req.body.new_password || '');
    if (!validator.isEmail(email)) return res.status(400).json({ error: 'البريد غير صحيح', code: 'EMAIL_INVALID' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'كلمة السر يجب أن تكون 8 أحرف على الأقل' });
    if (newPassword.length > 72) return res.status(400).json({ error: 'كلمة السر طويلة جداً', code: 'RESET_PASSWORD_TOO_LONG' });
    // [PERF-HARDEN-03] ORDER BY id DESC — بلا هذا، لو وُجد أكثر من صف معلّق
    // بنفس الإيميل (نافذة تسابق ضيقة: طلبَي تسجيل/إعادة تعيين متزامنَين
    // فعلياً لنفس الإيميل، بينهما نقطة await واحدة بجسم /auth/register تسمح
    // لطلب آخر بالتنفيذ في المنتصف)، .get() بلا ترتيب صريح قد يُرجع أقدم صف
    // بدل آخر محاولة فعلية للمستخدم — فيُقارَن الكود المُدخَل بكود قديم مختلف.
    // DELETE-ثم-INSERT بمسار /auth/register يمنع هذا بالمسار الطبيعي المتسلسل؛
    // هذا فقط يجعل الحالة النادرة المتبقية سلوكها صحيحاً (يأخذ الأحدث دائماً)
    // بدل الاعتماد على ترتيب غير مضمون بمحرك SQLite.
    const pending = db.prepare('SELECT * FROM pending_users WHERE email=? ORDER BY id DESC LIMIT 1').get(email);
    if (!pending) return res.status(400).json({ error: 'انتهت صلاحية الكود أو لم تطلبه، أعد المحاولة', code: 'RESET_NO_PENDING' });
    if (Date.now() > pending.otp_expires) {
      db.prepare('DELETE FROM pending_users WHERE email=?').run(email);
      return res.status(400).json({ error: 'انتهت صلاحية الكود، اطلب كوداً جديداً', code: 'RESET_OTP_EXPIRED' });
    }
    if (pending.attempts >= 5) {
      db.prepare('DELETE FROM pending_users WHERE email=?').run(email);
      return res.status(400).json({ error: 'محاولات كثيرة، اطلب كوداً جديداً', code: 'RESET_TOO_MANY_ATTEMPTS' });
    }
    if (pending.otp !== otp) {
      db.prepare('UPDATE pending_users SET attempts=attempts+1 WHERE email=?').run(email);
      const left = 5 - (pending.attempts + 1);
      return res.status(400).json({ error: `الكود غير صحيح. تبقى لك ${left} محاولات`, code: 'OTP_INCORRECT', params: { left } });
    }
    try {
      const d = JSON.parse(pending.data);
      if (d.type !== 'reset') return res.status(400).json({ error: 'طلب غير صحيح', code: 'RESET_INVALID_REQUEST_TYPE' });
      const hash = await bcrypt.hash(newPassword, 12);
      // [SEC-FIX-RESETTOKENVER-01] راجع DECISIONS.md — بعكس /me/password
      // (SEC-FIX-09، يزيد token_version+1)، هذا المسار كان يعدّل password_hash
      // فقط بلا لمس token_version إطلاقاً. أي JWT صادر قبل إعادة التعيين (مثلاً
      // نسخة مسروقة كانت السبب الفعلي في لجوء صاحب الحساب لـ"نسيت كلمة السر"
      // أصلاً) يبقى صالحاً بالكامل حتى انتهاء صلاحيته الطبيعية (7 أيام)، رغم
      // تغيّر كلمة السر — يُبطل بالضبط الهدف الأمني الذي صُمِّم هذا التدفّق
      // لتحقيقه (استرجاع التحكّم بحساب قد يكون تعرّض لاختراق). token_version+1
      // هنا يُبطل أي توكن قائم فوراً؛ لا حاجة لإصدار توكن جديد (بعكس
      // /me/password) لأن هذا المسار غير مصادَق أصلاً — المستخدم سيسجّل دخولاً
      // جديداً بكلمة سره الجديدة كما تقول رسالة النجاح "يمكنك الدخول الآن".
      db.prepare('UPDATE users SET password_hash=?, token_version=token_version+1 WHERE id=?').run(hash, d.userId);
      db.prepare('DELETE FROM pending_users WHERE email=?').run(email);
      // token_version+1 وحدها لا تقطع أي اتصال Socket.IO حي فوراً (يُعاد
      // التحقق فقط عند اتصال جديد — راجع نطاق متروك عمداً بـ
      // SEC-FIX-CHATSCOPE-03) — نفس نمط toggle/role/DELETE (routes/admin.routes.js)
      // وDELETE /me المجاور تماماً بهذا الملف: قطع صريح لأي جلسة حيّة الآن.
      try { io.in(`user-${d.userId}`).disconnectSockets(true); } catch (e2) {}
      res.json({ ok: true, message: 'تم تغيير كلمة السر بنجاح. يمكنك الدخول الآن.' });
    } catch (e) {
      res.status(500).json({ error: 'تعذر تحديث كلمة السر', code: 'RESET_UPDATE_FAILED' });
    }
  });

  router.get('/me', auth, (req, res) => {
    const user = userPublic(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id));
    if (user && user.role === 'technician') {
      const oc = db.prepare('SELECT COUNT(DISTINCT request_id) c FROM offers WHERE technician_id=?').get(user.id).c || 0;
      user.offer_count = oc;
      // [FIX-OFFERQUOTA-01] free_quota_used يعكس الآن free_offers_used الدائم
      // (لا يتأثر بسحب العروض) بدل الحساب الحي القديم القابل للتلاعب — نفس
      // اسم الحقل أُبقي للتوافق الرجعي مع أي طرف كان يقرأه سابقاً.
      user.free_offers_used = Number(user.free_offers_used || 0);
      user.free_offers_remaining = Math.max(0, FREE_TIER_QUOTA - user.free_offers_used);
      user.free_quota_used = user.free_offers_used;
    }
    res.json({ user });
  });

  router.post('/me/profile', auth, upload.single('avatar'), verifyImageMagicBytes, (req, res) => {
    // [FIX-UPLOAD-01] أي ملف وصل عبر multer ولم يُستخدم فعلياً (رُفض بسبب
    // فشل تحقق آخر، أو لأن الدور ليس "فني") يُحذف فوراً من القرص عند انتهاء
    // الطلب — بغض النظر عن أي مسار Return تم أخذه. هذا يمنع بقاء ملفات
    // يتيمة بمجلد uploads دون الحاجة لتعديل أي منطق تحقق موجود.
    let fileConsumed = false;
    res.on('finish', () => {
      if (req.file && !fileConsumed) {
        try { fs.unlinkSync(req.file.path); } catch (e) {}
      }
    });

    const name = clean(req.body.name);
    const phone = clean(req.body.phone);
    const city = clean(req.body.city);
    const areas = clean(req.body.areas || req.body.area);
    // [SEC-FIX-EMPTYSERVICES-01] راجع DECISIONS.md — `req.body.services ? ... : null`
    // كانت تعامل نصاً فارغاً "" (الحقل مُرسَل صراحة، بمعنى "امسح كل خدماتي")
    // بالضبط كأن الحقل لم يُرسَل إطلاقاً (كلاهما null) — نية الفني بمسح خدماته
    // تُتجاهَل بصمت (UPDATE يتخطى العمود تماماً أسفل بسبب `services !== null`)،
    // لا تُرفَض ولا تُطبَّق، فني قد يظن أنه صفّر خدماته بينما القديمة لا تزال فعّالة.
    const services = (req.body.services !== undefined && req.body.services !== null)
      ? (Array.isArray(req.body.services) ? req.body.services.join(',') : clean(req.body.services))
      : null;
    if (name.length < 2) return res.status(400).json({ error: 'الاسم قصير', code: 'PROFILE_NAME_TOO_SHORT' });
    if (name.length > 60) return res.status(400).json({ error: 'الاسم طويل جداً، الحد الأقصى 60 حرف', code: 'NAME_TOO_LONG_60' });
    if (city.length > 50) return res.status(400).json({ error: 'اسم المدينة طويل جداً', code: 'CITY_TOO_LONG' });
    if (areas.length > 500) return res.status(400).json({ error: 'المناطق طويلة جداً، الحد الأقصى 500 حرف', code: 'PROFILE_AREAS_TOO_LONG' });
    if (services && services.length > 500) return res.status(400).json({ error: 'الخدمات طويلة جداً، الحد الأقصى 500 حرف', code: 'PROFILE_SERVICES_TOO_LONG' });
    // [SEC-FIX-EMPTYSERVICES-01] فني يرسل services صراحة كنص/مصفوفة فارغة —
    // الآن تُرفَض بوضوح بدل التجاهل الصامت أعلاه أو ترك الحساب بلا أي خدمة
    // (نفس متطلَّب التسجيل أعلاه: REGISTER_TECH_SERVICES_REQUIRED).
    if (req.user.role === 'technician' && services !== null && !services) return res.status(400).json({ error: 'يجب أن تحتفظ بخدمة واحدة على الأقل', code: 'PROFILE_SERVICES_REQUIRED' });
    if (!/^07\d{8}$/.test(phone)) return res.status(400).json({ error: 'رقم الهاتف يجب أن يبدأ 07 ويتكون من 10 أرقام', code: 'PHONE_INVALID_FORMAT' });
    // معالجة الصورة الجديدة
    // [FIX-AVATAR-01] كان مقصوراً على الفنيين فقط — العميل لم يكن يقدر يضيف
    // أو يغيّر صورته الشخصية إطلاقاً من التطبيق، رغم أن التسجيل نفسه يسمح
    // برفعها اختيارياً للعميل أيضاً (فقط إلزامية للفني). أي دور الآن يقدر يحدّثها.
    let avatarUpdate = '';
    let avatarParams = [];
    if (req.file) {
      fileConsumed = true;
      const newAvatarUrl = '/uploads/avatars/' + req.file.filename;
      // حذف الصورة القديمة
      const oldUser = db.prepare('SELECT avatar_url FROM users WHERE id=?').get(req.user.id);
      if (oldUser?.avatar_url) {
        try { fs.unlinkSync(path.join(BASE, 'public', oldUser.avatar_url)); } catch (e) {}
      }
      avatarUpdate = ', avatar_url=?';
      avatarParams = [newAvatarUrl];
    }
    if (req.user.role === 'technician' && services !== null) {
      db.prepare(`UPDATE users SET name=?, phone=?, city=?, areas=?, services=?${avatarUpdate} WHERE id=?`).run(name, phone, city, areas, services, ...avatarParams, req.user.id);
    } else {
      db.prepare(`UPDATE users SET name=?, phone=?, city=?, areas=?${avatarUpdate} WHERE id=?`).run(name, phone, city, areas, ...avatarParams, req.user.id);
    }
    res.json({ user: userPublic(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)) });
  });

  // [PERF-HARDEN-03] راجع تعليق [PERF-HARDEN-03] أعلى /auth/register.
  router.post('/me/password', auth, async (req, res) => {
   try {
    const current = String(req.body.current_password || '');
    const next = String(req.body.new_password || '');
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if (!(await bcrypt.compare(current, user.password_hash))) return res.status(400).json({ error: 'كلمة السر الحالية غير صحيحة', code: 'PASSWORD_CURRENT_INCORRECT' });
    if (next.length < 8) return res.status(400).json({ error: 'كلمة السر الجديدة يجب أن تكون 8 أحرف على الأقل', code: 'PASSWORD_NEW_TOO_SHORT' });
    if (next.length > 72) return res.status(400).json({ error: 'كلمة السر طويلة جداً، الحد الأقصى 72 حرف' });
    // [SEC-FIX-09] token_version+1 يُبطل فوراً أي توكن آخر صادر قبل هذه اللحظة
    // (مثلاً نسخة مسروقة، أو جهاز آخر مسجَّل دخوله بنفس الحساب) — لكن نُصدر
    // توكناً جديداً لهذا الجهاز نفسه فوراً حتى لا يُسجَّل خروجه هو أيضاً بعد
    // تغيير كلمة سره بنجاح (تجربة مستخدم سيئة لولا هذا).
    db.prepare('UPDATE users SET password_hash=?, token_version=token_version+1 WHERE id=?')
      .run(await bcrypt.hash(next, 12), req.user.id);
    const updated = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    const token = sign(updated);
    res.cookie('token', token, COOKIE_OPTS);
    // [SEC-FIX-MEPWSOCKET-01] راجع DECISIONS.md — كان الوحيد بين كل مسارات
    // تغيير token_version (logout، reset-password SEC-FIX-RESETTOKENVER-01،
    // admin toggle/role/DELETE) بلا قطع صريح لأي اتصال Socket.IO حي بهذا
    // الحساب. token_version+1 وحدها لا تقطع سوكتاً قائماً فوراً (يُعاد التحقق
    // فقط عند اتصال جديد) — أي نسخة مسروقة كانت متصلة بسوكت حي وقت تغيير
    // كلمة السر (السيناريو الفعلي الذي يدفع مستخدماً لتغييرها أصلاً) تبقى
    // متصلة وتستقبل كل التحديثات اللحظية (رسائل شات، تحديثات طلبات...) رغم
    // إبطال توكنها بالكامل على مستوى REST.
    try { io.in(`user-${req.user.id}`).disconnectSockets(true); } catch (e2) {}
    res.json({ ok: true, token });
   } catch (e) {
     console.error('password change failed:', e.message);
     res.status(500).json({ error: 'تعذر تغيير كلمة السر، حاول مرة أخرى', code: 'PASSWORD_CHANGE_FAILED' });
   }
  });

  // ── حذف الحساب الذاتي (متطلّب سياسة Google Play لحذف الحساب) ──────────
  // نفس شرطَي حذف الأدمن اليدوي بالضبط (routes/admin.routes.js): لا حذف
  // بوجود طلب نشط أو رصيد متبقٍّ — لحماية الطرف الآخر (فني/عميل) من انقطاع
  // مفاجئ بمنتصف عمل، ولحماية المستخدم نفسه من فقدان رصيد لم يُصرف.
  // بالإضافة لذلك: نطلب كلمة السر الحالية للتأكيد (مثل /me/password تماماً)
  // لأن هذا إجراء نهائي لا رجعة فيه.
  // [PERF-HARDEN-03] الحماية الأصلية (FIX-DELETE-CRASH-01) كانت مقصورة على
  // anonymizeUser فقط — الفحوصات قبلها (bcrypt.compare، استعلامَي SELECT)
  // كانت لا تزال بلا شبكة أمان خارجية. try/catch خارجي هنا يغطيها أيضاً، مع
  // إبقاء try/catch الداخلي كما هو تماماً (رسالته الخاصة أدق لحالة القيد
  // الخارجي المعروفة تحديداً).
  router.delete('/me', auth, async (req, res) => {
   try {
    const id = req.user.id;
    const password = String(req.body.password || '');
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!u) return res.status(404).json({ error: 'الحساب غير موجود', code: 'DELETE_ACCOUNT_NOT_FOUND' });
    if (!(await bcrypt.compare(password, u.password_hash))) {
      return res.status(401).json({ error: 'كلمة السر غير صحيحة', code: 'DELETE_ACCOUNT_WRONG_PASSWORD' });
    }
    const activeRequest = db.prepare(
      `SELECT id FROM requests WHERE (customer_id=? OR technician_id=?) AND status IN (${BLOCKING_REQUEST_STATUSES_SQL}) LIMIT 1`
    ).get(id, id);
    if (activeRequest) {
      return res.status(409).json({
        error: `لا يمكن حذف حسابك حالياً — عندك طلب نشط رقم ${activeRequest.id}. أنهِ أو ألغِ الطلب أولاً.`,
        code: 'DELETE_ACCOUNT_ACTIVE_REQUEST',
        params: { id: activeRequest.id },
      });
    }
    // [FIX-PENDINGOFFER-01] راجع DECISIONS.md — نفس الفحص المُضاف بمسارَي
    // الأدمن المقابلين (توقيف/حذف)، لنفس السبب: عرض pending لا يظهر بفحص
    // activeRequest أعلاه (requests.technician_id لا يزال NULL طالما لم
    // يُقبَل العرض بعد) لكنه يبقى قابلاً للقبول من العميل بعد حذف الحساب.
    const pendingOffer = db.prepare("SELECT id FROM offers WHERE technician_id=? AND status='pending' LIMIT 1").get(id);
    if (pendingOffer) {
      return res.status(409).json({
        error: `لا يمكن حذف حسابك حالياً — لديك عرض معلَّق رقم ${pendingOffer.id} بانتظار قرار عميل. اسحبه أو انتظر حسمه أولاً.`,
        code: 'DELETE_ACCOUNT_PENDING_OFFER',
        params: { id: pendingOffer.id },
      });
    }
    // [SEC-FIX-PENDINGTOPUP-01] راجع DECISIONS.md وتعليق /admin/users/:id
    // المقابل — نفس الفحص، نفس السبب: طلب شحن pending يبقى قابلاً لموافقة
    // الأدمن لاحقاً حتى بعد حذف الحساب، فيضيف رصيداً لحساب محذوف بلا رجعة.
    const pendingTopup = db.prepare("SELECT id FROM topups WHERE technician_id=? AND status='pending' LIMIT 1").get(id);
    if (pendingTopup) {
      return res.status(409).json({
        error: `لا يمكن حذف حسابك حالياً — لديك طلب شحن رصيد معلَّق رقم ${pendingTopup.id} بانتظار مراجعة الأدمن. انتظر حسمه أولاً.`,
        code: 'DELETE_ACCOUNT_PENDING_TOPUP',
        params: { id: pendingTopup.id },
      });
    }
    // [SEC-FIX-DELETETOCTOU-01] راجع DECISIONS.md — u.balance أعلاه قُرئ قبل
    // await bcrypt.compare()، وهو نقطة التعليق الوحيدة بهذا المعالج (كل ما
    // بعدها متزامن بالكامل بلا أي await آخر حتى anonymizeUser). أي رصيد
    // يُضاف لهذا الحساب (مراجعة أدمن لطلب شحن، تعديل رصيد يدوي) بالضبط أثناء
    // تلك النافذة كان يمر بلا أن يعكسه هذا الفحص، لأنه يعتمد على القيمة
    // القديمة المحفوظة بمتغيّر u بدل قراءة حيّة. قراءة مباشرة الآن بدل u.balance.
    const freshBalance = Number(db.prepare('SELECT balance FROM users WHERE id=?').get(id)?.balance || 0);
    if (freshBalance > 0) {
      return res.status(409).json({
        error: `لا يمكن حذف حسابك حالياً — رصيدك الحالي ${freshBalance} د.أ. تواصل مع الدعم لتصفيته أولاً.`,
        code: 'DELETE_ACCOUNT_BALANCE_REMAINING',
        params: { balance: freshBalance },
      });
    }
    // [FIX-DELETE-CRASH-01] كانت DELETE FROM users هنا ترمي SqliteError
    // (FOREIGN KEY constraint failed) لأي حساب له سجل واحد فعلي بـrequests/
    // offers/topups/support_tickets/support_messages — وبما أن هذا الراوت
    // async بلا try/catch، الاستثناء غير الملتقَط كان يُسقط عملية Node بأكملها
    // (انظر utils/db-helpers.js لتفاصيل السبب والحل الكامل).
    try {
      anonymizeUser(id);
    } catch (e) {
      console.error('account deletion failed:', e.message);
      return res.status(500).json({ error: 'تعذر حذف الحساب، حاول لاحقاً', code: 'DELETE_ACCOUNT_FAILED' });
    }
    // اقطع أي اتصال Socket.IO حي بهذا الحساب فوراً (بدل انتظار انقطاعه لحاله).
    try { io.in(`user-${id}`).disconnectSockets(); } catch (e) {}
    res.clearCookie('token');
    res.json({ ok: true, message: 'تم حذف حسابك بنجاح' });
   } catch (e) {
     console.error('account deletion failed (outer):', e.message);
     res.status(500).json({ error: 'تعذر حذف الحساب، حاول لاحقاً', code: 'DELETE_ACCOUNT_FAILED' });
   }
  });

  return router;
};
