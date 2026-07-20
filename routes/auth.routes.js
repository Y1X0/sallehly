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
  const { auth, upload } = deps.middleware;
  const { sign, sendOtpEmail } = deps.services;
  const { clean, userPublic, anonymizeUser } = deps.utils;
  const { COOKIE_OPTS, BASE } = deps.constants;
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
  router.post('/auth/register', registerLimiter, upload.single('avatar'), async (req, res) => {
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

    if (!['customer', 'technician'].includes(role)) return res.status(400).json({ error: 'نوع الحساب غير صحيح' });
    if (name.length < 2) return res.status(400).json({ error: 'الرجاء إدخال الاسم الكامل' });
    if (name.length > 60) return res.status(400).json({ error: 'الاسم طويل جداً، الحد الأقصى 60 حرف' });
    if (role === 'technician' && !avatar_filename) return res.status(400).json({ error: 'الصورة الشخصية مطلوبة للفني فقط' });
    if (!validator.isEmail(email)) return res.status(400).json({ error: 'البريد غير صحيح' });
    if (email.length > 100) return res.status(400).json({ error: 'البريد الإلكتروني طويل جداً' });
    if (!/^07\d{8}$/.test(phone)) return res.status(400).json({ error: 'رقم الهاتف يجب أن يبدأ 07 ويتكون من 10 أرقام' });
    if (password.length < 8) return res.status(400).json({ error: 'كلمة السر يجب أن تكون 8 أحرف على الأقل' });
    if (password.length > 72) return res.status(400).json({ error: 'كلمة السر طويلة جداً، الحد الأقصى 72 حرف' });
    if (role === 'technician' && !/^\d{10}$/.test(national_number)) return res.status(400).json({ error: 'الرقم الوطني يجب أن يكون 10 أرقام' });
    if (city.length > 50) return res.status(400).json({ error: 'اسم المدينة طويل جداً' });
    if (services.length > 500) return res.status(400).json({ error: 'الخدمات طويلة جداً' });
    if (areas.length > 500) return res.status(400).json({ error: 'المناطق طويلة جداً' });

    if (db.prepare('SELECT id FROM users WHERE email=?').get(email))
      return res.status(409).json({ error: 'البريد الإلكتروني مستخدم مسبقاً' });
    if (db.prepare('SELECT id FROM users WHERE phone=?').get(phone))
      return res.status(409).json({ error: 'رقم الهاتف مستخدم مسبقاً' });

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
    if (!sent) return res.status(500).json({ error: 'تعذر إرسال البريد، حاول مرة أخرى' });

    res.json({ ok: true, step: 'verify', message: 'تم إرسال كود التحقق إلى بريدك الإلكتروني', email });
   } catch (e) {
     console.error('register failed:', e.message);
     res.status(500).json({ error: 'تعذر إنشاء الحساب، حاول مرة أخرى' });
   }
  });

  // ── STEP 2: التحقق من OTP وإنشاء الحساب ─────────────────────────────────
  router.post('/auth/verify-otp', (req, res) => {
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
    if (!pending) return res.status(400).json({ error: 'لا يوجد طلب تسجيل لهذا البريد، أعد التسجيل' });

    if (Date.now() > pending.otp_expires) {
      db.prepare('DELETE FROM pending_users WHERE email=?').run(email);
      return res.status(400).json({ error: 'انتهت صلاحية الكود، أعد التسجيل' });
    }

    if (pending.attempts >= 5) {
      db.prepare('DELETE FROM pending_users WHERE email=?').run(email);
      return res.status(400).json({ error: 'محاولات كثيرة، أعد التسجيل' });
    }

    if (pending.otp !== otp) {
      db.prepare('UPDATE pending_users SET attempts=attempts+1 WHERE email=?').run(email);
      const left = 5 - (pending.attempts + 1);
      return res.status(400).json({ error: `الكود غير صحيح. تبقى لك ${left} محاولات` });
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
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'البريد أو رقم الهاتف مستخدم مسبقاً' });
      res.status(500).json({ error: 'تعذر إنشاء الحساب' });
    }
  });

  // [PERF-HARDEN-03] راجع تعليق [PERF-HARDEN-03] أعلى /auth/register — نفس
  // شبكة الأمان بالضبط، وهذا أكثر مسار بالتطبيق كله استدعاءً (كل محاولة دخول)،
  // فأي استثناء غير متوقّع هنا كان أخطر ما يمكن أن يُسقط الخادم بأكمله.
  router.post('/auth/login', loginLimiter, async (req, res) => {
   try {
    const email = clean(req.body.email).toLowerCase();
    const password = String(req.body.password || '');
    if (password.length > 72) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    const DUMMY_HASH = '$2a$12$dummyhashtopreventtimingattacksonnonexistentaccounts111';
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    // Always run bcrypt to prevent user enumeration via timing difference
    const hashToCheck = user ? user.password_hash : DUMMY_HASH;
    // [PERF-04] هذا تحديداً أهم موقع بالكامل: bcrypt يُشغَّل على كل محاولة
    // دخول (بما فيها الفاشلة، عمداً لمنع timing attack) — كان يحجز الخادم
    // بأكمله لكل مستخدم آخر ~350ms لكل محاولة دخول تحدث على المنصة.
    const valid = await bcrypt.compare(password, hashToCheck);
    if (!user || !valid) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    if (!user.is_active) return res.status(403).json({ error: 'الحساب موقوف' });
    const token = sign(user); res.cookie('token', token, COOKIE_OPTS); res.json({ user: userPublic(user), token });
   } catch (e) {
     console.error('login failed:', e.message);
     res.status(500).json({ error: 'تعذر تسجيل الدخول، حاول مرة أخرى' });
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
    if (!validator.isEmail(email)) return res.status(400).json({ error: 'البريد الإلكتروني غير صحيح' });
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
    if (!sent) return res.status(500).json({ error: 'تعذر إرسال البريد، حاول مرة أخرى' });
    res.json({ ok: true, message: 'تم إرسال كود التحقق على بريدك الإلكتروني' });
   } catch (e) {
     console.error('forgot-password failed:', e.message);
     res.status(500).json({ error: 'تعذر إرسال البريد، حاول مرة أخرى' });
   }
  });

  // ── Forgot Password: خطوة 2 — التحقق وإعادة التعيين ─────────────────────
  router.post('/auth/reset-password', passwordResetLimiter, async (req, res) => {
    const email = clean(req.body.email || '').toLowerCase();
    const otp = clean(req.body.otp || '');
    const newPassword = String(req.body.new_password || '');
    if (!validator.isEmail(email)) return res.status(400).json({ error: 'البريد غير صحيح' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'كلمة السر يجب أن تكون 8 أحرف على الأقل' });
    if (newPassword.length > 72) return res.status(400).json({ error: 'كلمة السر طويلة جداً' });
    // [PERF-HARDEN-03] ORDER BY id DESC — بلا هذا، لو وُجد أكثر من صف معلّق
    // بنفس الإيميل (نافذة تسابق ضيقة: طلبَي تسجيل/إعادة تعيين متزامنَين
    // فعلياً لنفس الإيميل، بينهما نقطة await واحدة بجسم /auth/register تسمح
    // لطلب آخر بالتنفيذ في المنتصف)، .get() بلا ترتيب صريح قد يُرجع أقدم صف
    // بدل آخر محاولة فعلية للمستخدم — فيُقارَن الكود المُدخَل بكود قديم مختلف.
    // DELETE-ثم-INSERT بمسار /auth/register يمنع هذا بالمسار الطبيعي المتسلسل؛
    // هذا فقط يجعل الحالة النادرة المتبقية سلوكها صحيحاً (يأخذ الأحدث دائماً)
    // بدل الاعتماد على ترتيب غير مضمون بمحرك SQLite.
    const pending = db.prepare('SELECT * FROM pending_users WHERE email=? ORDER BY id DESC LIMIT 1').get(email);
    if (!pending) return res.status(400).json({ error: 'انتهت صلاحية الكود أو لم تطلبه، أعد المحاولة' });
    if (Date.now() > pending.otp_expires) {
      db.prepare('DELETE FROM pending_users WHERE email=?').run(email);
      return res.status(400).json({ error: 'انتهت صلاحية الكود، اطلب كوداً جديداً' });
    }
    if (pending.attempts >= 5) {
      db.prepare('DELETE FROM pending_users WHERE email=?').run(email);
      return res.status(400).json({ error: 'محاولات كثيرة، اطلب كوداً جديداً' });
    }
    if (pending.otp !== otp) {
      db.prepare('UPDATE pending_users SET attempts=attempts+1 WHERE email=?').run(email);
      const left = 5 - (pending.attempts + 1);
      return res.status(400).json({ error: `الكود غير صحيح. تبقى لك ${left} محاولات` });
    }
    try {
      const d = JSON.parse(pending.data);
      if (d.type !== 'reset') return res.status(400).json({ error: 'طلب غير صحيح' });
      const hash = await bcrypt.hash(newPassword, 12);
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, d.userId);
      db.prepare('DELETE FROM pending_users WHERE email=?').run(email);
      res.json({ ok: true, message: 'تم تغيير كلمة السر بنجاح. يمكنك الدخول الآن.' });
    } catch (e) {
      res.status(500).json({ error: 'تعذر تحديث كلمة السر' });
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
      user.free_offers_remaining = Math.max(0, 2 - user.free_offers_used);
      user.free_quota_used = user.free_offers_used;
    }
    res.json({ user });
  });

  router.post('/me/profile', auth, upload.single('avatar'), (req, res) => {
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
    const services = req.body.services ? (Array.isArray(req.body.services) ? req.body.services.join(',') : clean(req.body.services)) : null;
    if (name.length < 2) return res.status(400).json({ error: 'الاسم قصير' });
    if (name.length > 60) return res.status(400).json({ error: 'الاسم طويل جداً، الحد الأقصى 60 حرف' });
    if (city.length > 50) return res.status(400).json({ error: 'اسم المدينة طويل جداً' });
    if (areas.length > 500) return res.status(400).json({ error: 'المناطق طويلة جداً، الحد الأقصى 500 حرف' });
    if (services && services.length > 500) return res.status(400).json({ error: 'الخدمات طويلة جداً، الحد الأقصى 500 حرف' });
    if (!/^07\d{8}$/.test(phone)) return res.status(400).json({ error: 'رقم الهاتف يجب أن يبدأ 07 ويتكون من 10 أرقام' });
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
    if (!(await bcrypt.compare(current, user.password_hash))) return res.status(400).json({ error: 'كلمة السر الحالية غير صحيحة' });
    if (next.length < 8) return res.status(400).json({ error: 'كلمة السر الجديدة يجب أن تكون 8 أحرف على الأقل' });
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
    res.json({ ok: true, token });
   } catch (e) {
     console.error('password change failed:', e.message);
     res.status(500).json({ error: 'تعذر تغيير كلمة السر، حاول مرة أخرى' });
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
    if (!u) return res.status(404).json({ error: 'الحساب غير موجود' });
    if (!(await bcrypt.compare(password, u.password_hash))) {
      return res.status(401).json({ error: 'كلمة السر غير صحيحة' });
    }
    const activeRequest = db.prepare(
      "SELECT id FROM requests WHERE (customer_id=? OR technician_id=?) AND status IN ('بانتظار العروض','وصلت عروض','تم اختيار عرض','قيد التنفيذ','بانتظار تأكيد الدفع') LIMIT 1"
    ).get(id, id);
    if (activeRequest) {
      return res.status(409).json({
        error: `لا يمكن حذف حسابك حالياً — عندك طلب نشط رقم ${activeRequest.id}. أنهِ أو ألغِ الطلب أولاً.`,
      });
    }
    if (Number(u.balance || 0) > 0) {
      return res.status(409).json({
        error: `لا يمكن حذف حسابك حالياً — رصيدك الحالي ${u.balance} د.أ. تواصل مع الدعم لتصفيته أولاً.`,
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
      return res.status(500).json({ error: 'تعذر حذف الحساب، حاول لاحقاً' });
    }
    // اقطع أي اتصال Socket.IO حي بهذا الحساب فوراً (بدل انتظار انقطاعه لحاله).
    try { io.in(`user-${id}`).disconnectSockets(); } catch (e) {}
    res.clearCookie('token');
    res.json({ ok: true, message: 'تم حذف حسابك بنجاح' });
   } catch (e) {
     console.error('account deletion failed (outer):', e.message);
     res.status(500).json({ error: 'تعذر حذف الحساب، حاول لاحقاً' });
   }
  });

  return router;
};
