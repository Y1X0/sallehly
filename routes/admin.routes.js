// routes/admin.routes.js — /api/admin/*
const express = require('express');

module.exports = function (deps) {
  const { db, path } = deps;
  const { io, safeEmit } = deps.realtime;
  const { auth, requireRole, requireSuperAdmin } = deps.middleware;
  const { clean, logAudit, anonymizeUser, notify, getMessages } = deps.utils;
  const { createDbBackup, sendPush } = deps.services;
  const router = express.Router();

  // [SEC-FIX-AMOUNTBOUND-01] راجع DECISIONS.md — Number.isFinite وحدها ترفض
  // NaN/Infinity فقط، لا تضع أي سقف واقعي. مبلغ مالي مثل 1e15 يمر بصمت (رقم
  // منتهٍ فعلاً)، سواء عن خطأ كتابة (رقم إضافي بالغلط) أو تلاعب متعمّد — يفسد
  // حسابات الرصيد/دفتر الأستاذ لاحقاً بأرقام غير واقعية بلا أي تحذير. سقف
  // دفاعي بحت (لا قاعدة عمل)، أعلى بكثير من أي استخدام فعلي معقول اليوم
  // (أكبر باقة حالية 100 د.أ) — يمكن تعديله بسهولة من هنا وحدها لاحقاً.
  const MAX_FINANCIAL_AMOUNT = 1000000;

  router.post('/admin/backup', auth, requireRole('admin'), async (req, res) => {
    const file = await createDbBackup();
    if (!file) return res.status(500).json({ error: 'تعذر إنشاء النسخة الاحتياطية' });
    res.json({ ok: true, file: path.basename(file) });
  });

  router.get('/admin/stats', auth, requireRole('admin'), (req, res) => {
    const one = q => db.prepare(q).get().c;
    const revenue = db.prepare("SELECT COALESCE(SUM(ABS(amount)),0) total FROM ledger WHERE type='خصم عمولة طلب'").get().total || 0;
    const cancelled = one("SELECT COUNT(*) c FROM requests WHERE status='ملغي'");
    const total = one('SELECT COUNT(*) c FROM requests');
    const topServices = db.prepare("SELECT service, COUNT(*) cnt FROM requests GROUP BY service ORDER BY cnt DESC LIMIT 5").all();
    const topTechs = db.prepare("SELECT u.name, u.completed_jobs, u.rating_avg FROM users u WHERE u.role='technician' AND u.is_active=1 ORDER BY u.completed_jobs DESC, u.rating_avg DESC LIMIT 5").all();
    // [FIX-STATS-01] نشاط الفترات الزمنية — عدّادات إضافية فقط (لا تُبدّل أي
    // حقل موجود مسبقاً، فلا يتأثر أي طرف يقرأ الشكل القديم لهذا الرد).
    const activity = window => ({
      newRequests: one(`SELECT COUNT(*) c FROM requests WHERE created_at >= datetime('now','-${window} days')`),
      newUsers: one(`SELECT COUNT(*) c FROM users WHERE created_at >= datetime('now','-${window} days')`),
      revenue: Number(db.prepare(`SELECT COALESCE(SUM(ABS(amount)),0) total FROM ledger WHERE type='خصم عمولة طلب' AND created_at >= datetime('now','-${window} days')`).get().total || 0).toFixed(2)
    });
    res.json({
      stats: {
        customers: one("SELECT COUNT(*) c FROM users WHERE role='customer'"),
        technicians: one("SELECT COUNT(*) c FROM users WHERE role='technician'"),
        requests: total,
        pendingTopups: one("SELECT COUNT(*) c FROM topups WHERE status='pending'"),
        completed: one("SELECT COUNT(*) c FROM requests WHERE status='مكتمل'"),
        cancelled,
        cancelRate: total > 0 ? ((cancelled / total) * 100).toFixed(1) : '0',
        revenue: Number(revenue).toFixed(2),
        topServices,
        topTechs,
        suspendedUsers: one('SELECT COUNT(*) c FROM users WHERE is_active=0'),
        pendingVerification: one("SELECT COUNT(*) c FROM users WHERE role='technician' AND verification_status='pending'"),
        activity: { daily: activity(1), weekly: activity(7), monthly: activity(30) }
      }
    });
  });

  // [FIX-LEDGER-01] سجل حركات مالية عبر المنصة كاملة — قراءة فقط، لا يعدّل أي
  // منطق مالي. GET /api/ledger الحالي مقصور على مستخدم واحد فقط (?user_id)؛
  // هذا يجمع كل السجل بصفحات، لأي مستخدم، لعرضه دفعة واحدة بلوحة الأدمن.
  router.get('/admin/ledger', auth, requireRole('admin'), (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const userId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const type = clean(req.query.type || '');
    let where = '';
    const params = [];
    const conditions = [];
    if (userId) { conditions.push('l.user_id=?'); params.push(userId); }
    if (type) { conditions.push('l.type=?'); params.push(type); }
    if (conditions.length) where = 'WHERE ' + conditions.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) c FROM ledger l ${where}`).get(...params).c;
    const entries = db.prepare(`SELECT l.*, u.name user_name, u.role user_role FROM ledger l LEFT JOIN users u ON u.id=l.user_id ${where} ORDER BY l.id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    res.json({ entries, total });
  });

  // [FIX-09] Pagination اختيارية: لو ما أُرسل page/limit، السلوك يبقى بالضبط كما كان
  // (يرجع كل المستخدمين) — حتى لا يخرب أي عميل حالي (تطبيق الموبايل) لا يرسل هذه المعاملات.
  // [PERF-HARDEN-01] "بالضبط كما كان" كان يعني بلا أي سقف إطلاقاً — أُثبت
  // قياسياً (تحقيق بطء الخادم) أن هذا الاستعلام تحديداً بلا LIMIT يحجز عملية
  // Node بأكملها لمدة تفوق 700ms عند نمو الجدول لعشرات الآلاف من الصفوف
  // (better-sqlite3 متزامن)، ما يؤخر كل طلب آخر من أي مستخدم آخر بنفس اللحظة
  // بغض النظر عن علاقته بهذا الطلب. 2000 سقف وقائي بحت لا علاقة له بالسلوك
  // الحالي — لا يوجد سيناريو واقعي حالي لهذا التطبيق فيه أكثر من 2000 مستخدم
  // مسجَّل، فهذا لا يُغيّر أي استجابة فعلية اليوم، فقط يمنع الانهيار المستقبلي.
  router.get('/admin/users', auth, requireRole('admin'), (req, res) => {
    const baseSql = 'SELECT id,role,name,email,phone,national_number,city,areas,services,is_active,balance,free_orders_used,rating_avg,rating_count,completed_jobs,created_at FROM users ORDER BY id DESC';

    if (req.query.page == null && req.query.limit == null) {
      return res.json({ users: db.prepare(`${baseSql} LIMIT 2000`).all() });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const offset = (page - 1) * limit;

    const total = db.prepare('SELECT COUNT(*) c FROM users').get().c;
    const users = db.prepare(`${baseSql} LIMIT ? OFFSET ?`).all(limit, offset);
    res.json({ users, total, page, limit });
  });

  // [FIX-SUSPEND-01] reason اختياري تماماً — لا يكسر أي طرف حالي لا يرسله بعد.
  // عند التفعيل (newStatus=1) تُصفَّر بيانات التوقيف تلقائياً — حساب فعّال
  // لا معنى لبقاء "سبب توقيف" ظاهراً عليه من إيقاف سابق.
  router.post('/admin/users/:id/toggle', auth, requireRole('admin'), (req, res) => {
    if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'لا يمكنك إيقاف حسابك الخاص' });
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    if (!u) return res.status(404).json({ error: 'المستخدم غير موجود' });
    // [SEC-FIX-ADMINTARGET-01] راجع DECISIONS.md — نفس فحص `role === 'admin'`
    // المستخدَم أصلاً بـPOST /admin/users/:id/role (تحويل الدور)، الذي يمنع
    // استهداف حساب إدارة آخر تماماً. requireRole('admin') وحدها هنا تسمح لأي
    // أدمن عادي بإيقاف أو حذف حساب أدمن آخر — بما فيه محتمل super admin —
    // مخاطرة داخلية بحتة (حساب أدمن مُخترَق أو خبيث).
    if (u.role === 'admin') return res.status(400).json({ error: 'لا يمكن إيقاف حساب إدارة آخر', code: 'ADMIN_CANNOT_TARGET_ADMIN' });
    const newStatus = u.is_active ? 0 : 1;
    // [SEC-FIX-TOGGLEGHOST-01] راجع DECISIONS.md — anonymizeUser (حذف حساب)
    // يضبط deleted_at ويصفّي كل بيانات هوية صاحبه (name='مستخدم محذوف'،
    // email/phone/password_hash عشوائية) لكنه لا يلمس role أو is_active=0
    // بطريقة تمنع إعادة تفعيله لاحقاً — is_active=0 فقط، بلا أي حارس يمنع
    // فرع "إعادة التفعيل" (newStatus===1) هنا تحديداً من قلبها 1 من جديد.
    // بدون هذا الفحص، أدمن يضغط /toggle على معرّف محذوف قديم (سجل تدقيق،
    // خطأ نقر) يُعيد الحساب "نشطاً" بصمت — لا يمنحه أحد وصولاً فعلياً (لا
    // أحد يعرف كلمة السر العشوائية)، لكنه يجعل هذا الحساب "الشبح" يظهر من
    // جديد بكل مكان يفلتر فقط بـis_active=1: GET /technicians (بحث الفنيين
    // العام، بلا أي فلتر خدمة/مدينة) وGET /technicians/:id/profile (كان
    // يرفض 404 صراحة لحساب محذوف — يعود يعرض بروفايلاً باسم "مستخدم محذوف"
    // بلا صورة ولا خدمات لأي عميل حقيقي يتصفّح). نفس فحص deleted_at المستخدَم
    // أصلاً بـ/admin/users/:id/balance (SEC-FIX-BALANCETOGHOST-01) — مقصور
    // على فرع إعادة التفعيل فقط؛ إيقاف حساب محذوف أصلاً (newStatus===0) غير
    // ممكن أساساً لأن is_active يبدأ من 0 بعد الحذف، فلا حاجة لفحصه هناك.
    if (newStatus === 1 && u.deleted_at) {
      return res.status(400).json({ error: 'لا يمكن إعادة تفعيل حساب محذوف نهائياً', code: 'ADMIN_CANNOT_REACTIVATE_DELETED_ACCOUNT' });
    }
    // [SEC-FIX-SUSPENDACTIVE-01] راجع DECISIONS.md — نفس فحص الطلب النشط
    // الموجود أصلاً بـDELETE /admin/users/:id (سطر ~318) لكنه كان غائباً هنا:
    // بدونه، إيقاف حساب فني له طلب "تم اختيار عرض"/"قيد التنفيذ"/"بانتظار
    // تأكيد الدفع" يقفله عن REST فوراً (middleware/auth.js) بلا أي طريقة
    // لإكمال أو حتى رؤية ذلك الطلب لاحقاً — يبقى طلب العميل عالقاً "قيد
    // التنفيذ" للأبد إلا بتدخّل يدوي من أدمن آخر. نفس الفحص (customer_id
    // OR technician_id) يحمي العميل أيضاً لو كان هو من يُوقَف.
    if (newStatus === 0) {
      const activeRequest = db.prepare(
        "SELECT id FROM requests WHERE (customer_id=? OR technician_id=?) AND status IN ('بانتظار العروض','وصلت عروض','تم اختيار عرض','قيد التنفيذ','بانتظار تأكيد الدفع') LIMIT 1"
      ).get(u.id, u.id);
      if (activeRequest) return res.status(409).json({ error: `لا يمكن إيقاف هذا الحساب — عنده طلب نشط رقم ${activeRequest.id}. أنهِ أو ألغِ الطلب أولاً.` });
      // [FIX-PENDINGOFFER-01] راجع DECISIONS.md — الفحص أعلاه يغطي requests.technician_id
      // فقط، وهو NULL على الطلب طالما لم يُقبَل عرض بعد. فني قدَّم عرضاً
      // pending على طلب لم يُحسَم كان يفوت هذا الفحص تماماً، فيُوقَف بينما
      // عرضه لا يزال قابلاً للقبول لاحقاً — العميل يقبله فيرتبط الطلب بحساب
      // ميت. نفس نمط الفحص المستخدَم أصلاً بـ/admin/users/:id/role (تحويل
      // فني→عميل، سطر ~282) الذي يغطي هذا الاحتمال بالفعل — لم يكن مُطبَّقاً
      // هنا رغم معالجته لنفس فئة "حساب على وشك التعطّل له التزام معلَّق".
      const pendingOffer = db.prepare("SELECT id FROM offers WHERE technician_id=? AND status='pending' LIMIT 1").get(u.id);
      if (pendingOffer) return res.status(409).json({ error: `لا يمكن إيقاف هذا الحساب — لديه عرض معلَّق رقم ${pendingOffer.id} بانتظار قرار عميل. اسحبه أو انتظر حسمه أولاً.` });
    }
    const reason = clean(req.body.reason || '');
    if (reason.length > 300) return res.status(400).json({ error: 'سبب الإيقاف طويل جداً، الحد الأقصى 300 حرف' });
    if (newStatus === 0) {
      db.prepare('UPDATE users SET is_active=0, suspension_reason=?, suspended_at=CURRENT_TIMESTAMP, suspended_by=? WHERE id=?')
        .run(reason || null, req.user.id, u.id);
    } else {
      db.prepare('UPDATE users SET is_active=1, suspension_reason=NULL, suspended_at=NULL, suspended_by=NULL WHERE id=?').run(u.id);
    }
    // [SEC-FIX-10] الإيقاف كان يمنع REST فوراً (auth.js يتحقق من is_active حياً
    // بكل طلب) لكن أي اتصال Socket.IO مفتوح مسبقاً كان يبقى شغّالاً (لا يُعاد
    // التحقق إلا عند الاتصال). نفس النمط المستخدم أصلاً بحذف الحساب الذاتي
    // (routes/auth.routes.js) — اقطع فوراً أي اتصال حي بهذا الحساب عند إيقافه.
    if (!newStatus) {
      try { io.in(`user-${u.id}`).disconnectSockets(true); } catch (e) {}
    }
    logAudit({
      adminId: req.user.id, actorName: req.user.name,
      action: newStatus ? 'تفعيل مستخدم' : 'إيقاف مستخدم',
      targetType: 'user', targetId: u.id,
      details: newStatus ? { name: u.name, email: u.email } : { name: u.name, email: u.email, reason: reason || null }
    });
    res.json({ ok: true });
  });

  // [FIX-VERIFY-01] توثيق فني — عرض/تصفية فقط، لا يمنع أي فني (موثّق أو لا)
  // من العمل بأي شيء آخر بالنظام (راجع تعليق الترحيل بـconfig/migrate.js).
  router.post('/admin/users/:id/verify', auth, requireRole('admin'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صحيح' });
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!u) return res.status(404).json({ error: 'المستخدم غير موجود' });
    if (u.role !== 'technician') return res.status(400).json({ error: 'التوثيق مخصّص لحسابات الفنيين فقط' });
    db.prepare("UPDATE users SET verification_status='verified' WHERE id=?").run(id);
    logAudit({
      adminId: req.user.id, actorName: req.user.name,
      action: 'توثيق فني', targetType: 'user', targetId: id,
      details: { name: u.name, email: u.email }
    });
    res.json({ ok: true });
  });

  // [FIX-ADMINPROFILE-01] بروفايل كامل لمستخدم واحد لشاشة الأدمن — يجمّع كل ما
  // كان يتطلّب عدة طلبات منفصلة (طلبات كعميل/عروض كفني، دفتر الحساب، بلاغات
  // ومخالفات ضده) في استدعاء واحد. قراءة فقط، لا يعدّل أي شيء.
  router.get('/admin/users/:id', auth, requireRole('admin'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صحيح' });
    const user = db.prepare('SELECT id,role,name,email,phone,national_number,city,areas,services,is_active,balance,free_orders_used,free_offers_used,rating_avg,rating_count,completed_jobs,verification_status,suspension_reason,suspended_at,suspended_by,is_super_admin,created_at FROM users WHERE id=?').get(id);
    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });

    const requestsAsCustomer = db.prepare(
      "SELECT id,service,status,created_at FROM requests WHERE customer_id=? ORDER BY id DESC LIMIT 50"
    ).all(id);
    const requestsAsTechnician = user.role === 'technician'
      ? db.prepare("SELECT id,service,status,created_at FROM requests WHERE technician_id=? ORDER BY id DESC LIMIT 50").all(id)
      : [];
    const offers = user.role === 'technician'
      ? db.prepare("SELECT id,request_id,price,status,created_at FROM offers WHERE technician_id=? ORDER BY id DESC LIMIT 50").all(id)
      : [];
    const ledger = db.prepare('SELECT id,type,amount,balance_after,note,created_at FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 50').all(id);
    const violationsCount = db.prepare('SELECT COUNT(*) c FROM chat_violations WHERE user_id=?').get(id).c;
    const reportsAgainstCount = db.prepare('SELECT COUNT(*) c FROM message_reports WHERE reported_user_id=?').get(id).c;
    const complaintsFiledCount = db.prepare('SELECT COUNT(*) c FROM complaints WHERE user_id=?').get(id).c;

    res.json({
      user,
      requestsAsCustomer,
      requestsAsTechnician,
      offers,
      ledger,
      moderation: { violationsCount, reportsAgainstCount, complaintsFiledCount }
    });
  });

  // ── تعديل بيانات مستخدم من لوحة الأدمن (الاسم والمدينة فقط) ──
  router.post('/admin/users/:id/profile', auth, requireRole('admin'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صحيح' });
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!u) return res.status(404).json({ error: 'المستخدم غير موجود' });
    const name = clean(req.body.name);
    const city = clean(req.body.city);
    if (name.length < 2) return res.status(400).json({ error: 'الاسم قصير' });
    if (name.length > 60) return res.status(400).json({ error: 'الاسم طويل جداً، الحد الأقصى 60 حرف' });
    if (city.length > 50) return res.status(400).json({ error: 'اسم المدينة طويل جداً' });
    db.prepare('UPDATE users SET name=?, city=? WHERE id=?').run(name, city, id);
    logAudit({
      adminId: req.user.id, actorName: req.user.name,
      action: 'تعديل بيانات مستخدم', targetType: 'user', targetId: id,
      details: { name, city }
    });
    res.json({ ok: true, user: db.prepare('SELECT id,name,city,email,role FROM users WHERE id=?').get(id) });
  });

  // ── تعديل رصيد فني يدوياً من الأدمن — بيسجّل حركة بدفتر الأستاذ متل أي تعديل رصيد تاني ──
  router.post('/admin/users/:id/balance', auth, requireRole('admin'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صحيح' });
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!u) return res.status(404).json({ error: 'المستخدم غير موجود' });
    // [SEC-FIX-BALANCETOGHOST-01] راجع DECISIONS.md — anonymizeUser (عند حذف
    // حساب، utils/db-helpers.js) يضبط deleted_at لكنه لا يلمس balance إطلاقاً؛
    // بلا هذا الفحص، أدمن يستهدف معرّفاً قديماً (سجل تدقيق، تذكرة دعم) يقدر
    // يُضيف رصيداً فعلياً لحساب لم يعد أحد يستطيع تسجيل الدخول إليه أبداً
    // (بريد/كلمة سر عشوائيان) — نفس فئة "رصيد عالق بلا استرجاع غير تدخّل
    // مباشر بقاعدة البيانات" التي عالجتها SEC-FIX-PENDINGTOPUP-01 عند نقاط
    // الحذف نفسها. عمداً deleted_at لا is_active — الإيقاف (تعليق) يضبط
    // is_active=0 أيضاً لكنه قابل للتراجع (توجيل)، وحساب مُعلَّق قد يستحق
    // تعديل رصيد فعلاً أثناء التحقيق قبل قرار نهائي.
    if (u.deleted_at) return res.status(400).json({ error: 'لا يمكن تعديل رصيد حساب محذوف', code: 'USER_DELETED' });
    const amount = Number(req.body.amount);
    const reason = clean(req.body.reason || '');
    if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'أدخل مبلغاً صحيحاً (موجب للإضافة، سالب للخصم)' });
    // [SEC-FIX-AMOUNTBOUND-01] راجع DECISIONS.md — أعلى تعليق بالملف.
    if (Math.abs(amount) > MAX_FINANCIAL_AMOUNT) return res.status(400).json({ error: `المبلغ كبير جداً، الحد الأقصى ${MAX_FINANCIAL_AMOUNT} د.أ` });
    if (!reason || reason.length < 3) return res.status(400).json({ error: 'سبب التعديل إلزامي (3 أحرف على الأقل)' });
    if (reason.length > 300) return res.status(400).json({ error: 'السبب طويل جداً، الحد الأقصى 300 حرف' });
    const after = Number((Number(u.balance || 0) + amount).toFixed(2));
    if (after < 0) return res.status(400).json({ error: 'لا يمكن أن يصبح الرصيد سالباً' });
    const doAdjust = db.transaction(() => {
      db.prepare('UPDATE users SET balance=? WHERE id=?').run(after, id);
      db.prepare('INSERT INTO ledger(user_id,type,amount,balance_after,note) VALUES(?,?,?,?,?)')
        .run(id, 'تعديل يدوي من الإدارة', amount, after, reason);
    });
    doAdjust();
    logAudit({
      adminId: req.user.id, actorName: req.user.name,
      action: 'تعديل رصيد يدوي', targetType: 'user', targetId: id,
      details: { amount, balance_after: after, reason }
    });
    io.to(`user-${id}`).emit('balance-updated', { balance: after, status: 'admin-adjusted' });

    // [FIX-NOTIF-GAP-01] كان بلا Push ولا سجلّ دائم — نفس نمط topup approved
    // أدناه بـtopups.routes.js (type='wallet' موحّد مع NotificationProvider.handleBalanceUpdated).
    const targetUser = db.prepare('SELECT fcm_token FROM users WHERE id=?').get(id);
    if (targetUser?.fcm_token) {
      sendPush(targetUser.fcm_token,
        amount > 0 ? '💰 تمت إضافة رصيد لحسابك' : '⚠️ تم خصم من رصيدك',
        reason,
        { type: 'topup' }
      );
    }
    notify({
      userId: id,
      type: 'wallet',
      title: amount > 0 ? 'تمت إضافة رصيد لحسابك' : 'تم خصم من رصيدك',
      body: reason,
      data: { adjustedBy: 'admin' }
    });

    res.json({ balance: after });
  });

  // [FIX-ROLECHANGE-01] تغيير دور مستخدم — أشد إجراءات المستخدمين حساسية بهذا
  // الملف، لذا requireSuperAdmin بدل requireRole('admin') العادي. محظور كلياً
  // لو للحساب تاريخ عمل حقيقي (رصيد، أعمال مكتملة، عروض، طلب نشط) بنفس فلسفة
  // حظر حذف الحساب (DELETE /admin/users/:id وDELETE /me) — لا نفقد أي تاريخ
  // مالي أو تقييمات بتحويل صامت، الأدمن لازم يصفّي الوضع أولاً بنفس الأدوات
  // الموجودة (تعديل الرصيد، إلغاء الطلب) قبل التحويل.
  router.post('/admin/users/:id/role', auth, requireSuperAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صحيح' });
    if (id === req.user.id) return res.status(400).json({ error: 'لا يمكنك تغيير دور حسابك الخاص' });
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!u) return res.status(404).json({ error: 'المستخدم غير موجود' });
    const newRole = clean(req.body.role);
    if (!['customer', 'technician'].includes(newRole)) return res.status(400).json({ error: 'يمكن التحويل فقط بين عميل وفني' });
    if (u.role === newRole) return res.status(400).json({ error: 'الحساب من هذا النوع أصلاً' });
    if (u.role === 'admin') return res.status(400).json({ error: 'لا يمكن تغيير دور حساب إدارة' });

    if (u.role === 'technician') {
      // فني → عميل: يجب تصفية أي تاريخ عمل حقيقي أولاً.
      if (Number(u.balance || 0) > 0) return res.status(409).json({ error: `لا يمكن التحويل — رصيده الحالي ${u.balance} د.أ. صفّر الرصيد أولاً.` });
      if (Number(u.completed_jobs || 0) > 0) return res.status(409).json({ error: 'لا يمكن التحويل — لديه أعمال مكتملة وتاريخ تقييمات حقيقي.' });
      const activeAsTech = db.prepare(
        "SELECT id FROM requests WHERE technician_id=? AND status IN ('تم اختيار عرض','قيد التنفيذ','بانتظار تأكيد الدفع') LIMIT 1"
      ).get(id);
      if (activeAsTech) return res.status(409).json({ error: `لا يمكن التحويل — لديه طلب نشط رقم ${activeAsTech.id} كفني.` });
      const pendingOffers = db.prepare("SELECT id FROM offers WHERE technician_id=? AND status='pending' LIMIT 1").get(id);
      if (pendingOffers) return res.status(409).json({ error: 'لا يمكن التحويل — لديه عروض معلّقة على طلبات. اسحبها أو انتظر حسمها أولاً.' });
      // [SEC-FIX-PENDINGTOPUP-02] راجع DECISIONS.md — نفس فحص SEC-FIX-PENDINGTOPUP-01
      // (المُطبَّق على حذف/إيقاف الحساب) لكنه كان غائباً هنا: بلا هذا الفحص،
      // تحويل فني له طلب شحن معلَّق إلى عميل ثم موافقة أدمن لاحقاً على ذلك
      // الطلب (POST /admin/topups/:id/review يبحث بـtechnician_id فقط، بلا
      // فحص role) يُضيف رصيداً حقيقياً لحساب "عميل" الآن — لا مسار كتابة
      // يصرف balance عميل إطلاقاً (كل منطق العروض/الشحن يفترض role='technician')،
      // فالمبلغ يبقى عالقاً بلا استرجاع غير تدخّل مباشر بقاعدة البيانات.
      const pendingTopup = db.prepare("SELECT id FROM topups WHERE technician_id=? AND status='pending' LIMIT 1").get(id);
      if (pendingTopup) return res.status(409).json({ error: `لا يمكن التحويل — لديه طلب شحن رصيد معلَّق رقم ${pendingTopup.id} بانتظار مراجعة الأدمن. راجعه (موافقة أو رفض) أولاً.`, code: 'ROLECHANGE_PENDING_TOPUP' });

      db.prepare(`UPDATE users SET role='customer', national_number=NULL, services=NULL, areas=NULL,
        active_commission=2, free_offers_used=0, free_orders_used=0, verification_status='verified' WHERE id=?`).run(id);
    } else {
      // عميل → فني: يحتاج نفس الحقول التي يتطلّبها التسجيل ككل فني بالضبط.
      const activeAsCustomer = db.prepare(
        "SELECT id FROM requests WHERE customer_id=? AND status IN ('بانتظار العروض','وصلت عروض','تم اختيار عرض','قيد التنفيذ','بانتظار تأكيد الدفع') LIMIT 1"
      ).get(id);
      if (activeAsCustomer) return res.status(409).json({ error: `لا يمكن التحويل — لديه طلب نشط رقم ${activeAsCustomer.id} كعميل. أنهِ أو ألغِ الطلب أولاً.` });

      const national_number = clean(req.body.national_number);
      const services = Array.isArray(req.body.services) ? req.body.services.join(',') : clean(req.body.services);
      const areas = Array.isArray(req.body.areas) ? req.body.areas.join(',') : clean(req.body.areas);
      if (!/^\d{10}$/.test(national_number)) return res.status(400).json({ error: 'الرقم الوطني يجب أن يكون 10 أرقام' });
      if (!services) return res.status(400).json({ error: 'يجب تحديد خدمة واحدة على الأقل' });
      if (!areas) return res.status(400).json({ error: 'يجب تحديد منطقة واحدة على الأقل' });
      if (services.length > 500) return res.status(400).json({ error: 'الخدمات طويلة جداً' });
      if (areas.length > 500) return res.status(400).json({ error: 'المناطق طويلة جداً' });
      if (!u.avatar_url) return res.status(400).json({ error: 'يجب أن يكون لدى الحساب صورة شخصية قبل تحويله لفني — اطلب منه تحديث الصورة أولاً.' });
      const dupNational = db.prepare('SELECT id FROM users WHERE national_number=? AND id<>?').get(national_number, id);
      if (dupNational) return res.status(409).json({ error: 'الرقم الوطني مستخدم مسبقاً لحساب آخر' });

      db.prepare(`UPDATE users SET role='technician', national_number=?, services=?, areas=?,
        verification_status='verified' WHERE id=?`).run(national_number, services, areas, id);
    }

    // [SEC-FIX-09] بنفس منطق تغيير كلمة السر — دور الحساب تغيّر جوهرياً،
    // فأي توكن صادر قبل هذه اللحظة (يحمل الدور القديم) يجب أن يُبطَل فوراً.
    db.prepare('UPDATE users SET token_version=token_version+1 WHERE id=?').run(id);
    try { io.in(`user-${id}`).disconnectSockets(true); } catch (e) {}

    const updated = db.prepare('SELECT id,role,name,email FROM users WHERE id=?').get(id);
    logAudit({
      adminId: req.user.id, actorName: req.user.name,
      action: 'تغيير دور مستخدم', targetType: 'user', targetId: id,
      details: { name: u.name, email: u.email, old_role: u.role, new_role: newRole }
    });
    res.json({ ok: true, user: updated });
  });

  // ── حذف مستخدم نهائياً — محظور لو عنده طلب نشط أو رصيد أكبر من صفر (لازم يتصفّى وضعه أول) ──
  router.delete('/admin/users/:id', auth, requireRole('admin'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صحيح' });
    if (id === req.user.id) return res.status(400).json({ error: 'لا يمكنك حذف حسابك الخاص' });
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!u) return res.status(404).json({ error: 'المستخدم غير موجود' });
    // [SEC-FIX-ADMINTARGET-01] راجع DECISIONS.md وتعليق /toggle أعلاه — نفس الفحص.
    if (u.role === 'admin') return res.status(400).json({ error: 'لا يمكن حذف حساب إدارة آخر', code: 'ADMIN_CANNOT_TARGET_ADMIN' });
    const activeRequest = db.prepare(
      "SELECT id FROM requests WHERE (customer_id=? OR technician_id=?) AND status IN ('بانتظار العروض','وصلت عروض','تم اختيار عرض','قيد التنفيذ','بانتظار تأكيد الدفع') LIMIT 1"
    ).get(id, id);
    if (activeRequest) return res.status(409).json({ error: `لا يمكن حذف هذا الحساب — عنده طلب نشط رقم ${activeRequest.id}. أنهِ أو ألغِ الطلب أولاً.` });
    // [FIX-PENDINGOFFER-01] راجع DECISIONS.md وتعليق /toggle أعلاه — نفس
    // الفحص، نفس السبب: عرض pending غير مرتبط بأي طلب "نشط" بمعنى الفحص
    // أعلاه (requests.technician_id لا يزال NULL) لكنه لا يزال قابلاً
    // للقبول من العميل بعد حذف هذا الحساب.
    const pendingOffer = db.prepare("SELECT id FROM offers WHERE technician_id=? AND status='pending' LIMIT 1").get(id);
    if (pendingOffer) return res.status(409).json({ error: `لا يمكن حذف هذا الحساب — لديه عرض معلَّق رقم ${pendingOffer.id} بانتظار قرار عميل. اسحبه أو انتظر حسمه أولاً.` });
    // [SEC-FIX-PENDINGTOPUP-01] راجع DECISIONS.md — طلب شحن pending لم يكن
    // يُفحَص هنا على الإطلاق: لو حُذف حساب فني له طلب شحن معلَّق، ووافق الأدمن
    // عليه لاحقاً بلا علم أنه يستهدف حساباً محذوفاً، الرصيد يُضاف لحساب
    // is_active=0 مُصفّى بلا أي طريقة استرجاع غير تدخّل مباشر بقاعدة البيانات.
    const pendingTopup = db.prepare("SELECT id FROM topups WHERE technician_id=? AND status='pending' LIMIT 1").get(id);
    if (pendingTopup) return res.status(409).json({ error: `لا يمكن حذف هذا الحساب — لديه طلب شحن رصيد معلَّق رقم ${pendingTopup.id} بانتظار مراجعة الأدمن. راجعه (موافقة أو رفض) أولاً.`, code: 'DELETE_ACCOUNT_PENDING_TOPUP' });
    if (Number(u.balance || 0) > 0) return res.status(409).json({ error: `لا يمكن حذف هذا الحساب — رصيده الحالي ${u.balance} د.أ. صفّر الرصيد أولاً.` });
    // [FIX-DELETE-CRASH-01] راجع utils/db-helpers.js (anonymizeUser) — كانت
    // DELETE FROM users هنا ترمي SqliteError (FOREIGN KEY constraint failed)
    // لأي مستخدم له سجل واحد فعلي بـrequests/offers/topups/support_tickets/
    // support_messages، فيلتقطها معالج الأخطاء العام كخطأ 400 غامض بدل تنفيذ
    // الحذف فعلياً.
    try {
      anonymizeUser(id);
    } catch (e) {
      console.error('user deletion failed:', e.message);
      return res.status(500).json({ error: 'تعذر حذف المستخدم، حاول لاحقاً' });
    }
    // [SEC-FIX-SOCKETDISCONNECT-01] راجع DECISIONS.md — بعكس /toggle (SEC-FIX-10)
    // و/role (SEC-FIX-09) بنفس الملف، هذا المسار كان يترك أي اتصال Socket.IO
    // حيّ وقت الحذف يعمل بلا انقطاع (REST محظور فوراً عبر is_active/token_version،
    // لكن القناة الحية لا) حتى انقطاع طبيعي أو إعادة اتصال لاحقة.
    try { io.in(`user-${id}`).disconnectSockets(true); } catch (e) {}
    logAudit({
      adminId: req.user.id, actorName: req.user.name,
      action: 'حذف مستخدم نهائياً', targetType: 'user', targetId: id,
      details: { name: u.name, email: u.email, role: u.role }
    });
    res.json({ ok: true });
  });

  // [FIX-SERVICES-01] كل المهن (فعّالة وغير فعّالة) — لشاشة إدارة الأدمن فقط،
  // بعكس /meta العام الذي يُظهر الفعّالة فقط.
  router.get('/admin/services', auth, requireRole('admin'), (req, res) => {
    res.json({ services: db.prepare('SELECT * FROM service_categories ORDER BY name').all() });
  });

  router.post('/admin/services', auth, requireRole('admin'), (req, res) => {
    const name = clean(req.body.name);
    const icon = clean(req.body.icon) || '🔧';
    if (name.length < 2) return res.status(400).json({ error: 'اسم المهنة قصير' });
    if (name.length > 50) return res.status(400).json({ error: 'اسم المهنة طويل جداً، الحد الأقصى 50 حرف' });
    if (icon.length > 10) return res.status(400).json({ error: 'رمز المهنة طويل جداً' });
    try {
      const info = db.prepare('INSERT INTO service_categories(name,icon) VALUES(?,?)').run(name, icon);
      logAudit({ adminId: req.user.id, actorName: req.user.name, action: 'إضافة مهنة', targetType: 'service', targetId: info.lastInsertRowid, details: { name, icon } });
      // [FIX-SERVICES-01] بث فوري لكل المستخدمين المتصلين (عملاء وفنيين) —
      // مهنة جديدة تفعّل تظهر بدون إعادة فتح التطبيق.
      io.emit('services-updated', { type: 'created', name });
      res.json({ service: db.prepare('SELECT * FROM service_categories WHERE id=?').get(info.lastInsertRowid) });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'هذه المهنة موجودة مسبقاً' });
      res.status(500).json({ error: 'تعذر إضافة المهنة' });
    }
  });

  // [FIX-SERVICES-01] تفعيل/تعطيل مهنة — البديل الآمن للحذف النهائي. مهنة
  // معطّلة تختفي فوراً من /meta (تسجيل الفنيين + إنشاء الطلبات) لكن تبقى
  // بقاعدة البيانات (لا تُفقد بيانات الفنيين الحاليين المرتبطين بها كنص).
  // [FIX-SERVICES-03] نقطة واحدة تغطي كلا الحالتين: تبديل الحالة فقط، أو
  // تعديل الاسم/الأيقونة كاملاً (مع إمكانية تغيير الحالة بنفس الطلب أيضاً).
  // لا يوجد endpoint منفصل مكرر — نفس المسار PATCH /admin/services/:id.
  router.patch('/admin/services/:id', auth, requireRole('admin'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صحيح' });
    const svc = db.prepare('SELECT * FROM service_categories WHERE id=?').get(id);
    if (!svc) return res.status(404).json({ error: 'المهنة غير موجودة' });

    const editingNameOrIcon = req.body.name !== undefined || req.body.icon !== undefined;

    // ── الحالة 1: تبديل الحالة فقط (نفس السلوك القديم، بدون أي تغيير) ──
    if (!editingNameOrIcon) {
      const isActive = req.body.is_active ? 1 : 0;
      db.prepare('UPDATE service_categories SET is_active=? WHERE id=?').run(isActive, id);
      logAudit({
        adminId: req.user.id,
        actorName: req.user.name,
        action: isActive ? 'تفعيل مهنة' : 'تعطيل مهنة',
        targetType: 'service',
        targetId: id,
        details: { name: svc.name },
      });
      io.emit('services-updated', { type: 'toggled', id, name: svc.name, is_active: !!isActive });
      return res.json({ service: db.prepare('SELECT * FROM service_categories WHERE id=?').get(id) });
    }

    // ── الحالة 2: تعديل الاسم/الأيقونة (والحالة اختيارياً بنفس الطلب) ──
    const name = clean(req.body.name ?? svc.name);
    const icon = clean(req.body.icon ?? svc.icon) || '🔧';
    if (name.length < 2) return res.status(400).json({ error: 'اسم المهنة قصير' });
    if (name.length > 50) return res.status(400).json({ error: 'اسم المهنة طويل جداً، الحد الأقصى 50 حرف' });
    if (icon.length > 10) return res.status(400).json({ error: 'رمز المهنة طويل جداً' });

    // معرّف نفس المهنة يبقى كما هو (نُحدّث بنفس id)، والحالة الفعّالة تبقى
    // كما كانت إلا لو صرّح الطلب بتغييرها صراحة.
    const isActive = req.body.is_active !== undefined ? (req.body.is_active ? 1 : 0) : svc.is_active;

    try {
      const dup = db.prepare('SELECT id FROM service_categories WHERE name=? AND id<>?').get(name, id);
      if (dup) return res.status(409).json({ error: 'هذه المهنة موجودة مسبقاً' });

      db.prepare('UPDATE service_categories SET name=?, icon=?, is_active=? WHERE id=?').run(name, icon, isActive, id);
      logAudit({
        adminId: req.user.id,
        actorName: req.user.name,
        action: 'تعديل مهنة',
        targetType: 'service',
        targetId: id,
        details: { old_name: svc.name, name, icon },
      });
      // [FIX-SERVICES-03] بث فوري لكل المتصلين — العميل والفني، شاشة التسجيل،
      // تعديل الملف الشخصي، وإنشاء الطلب، كلها تعتمد على نفس هذا الحدث.
      io.emit('services-updated', { type: 'edited', id, name, icon, is_active: !!isActive });
      res.json({ service: db.prepare('SELECT * FROM service_categories WHERE id=?').get(id) });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'هذه المهنة موجودة مسبقاً' });
      res.status(500).json({ error: 'تعذر تعديل المهنة' });
    }
  });

  router.delete('/admin/services/:id', auth, requireRole('admin'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صحيح' });
    const svc = db.prepare('SELECT * FROM service_categories WHERE id=?').get(id);
    if (!svc) return res.status(404).json({ error: 'المهنة غير موجودة' });
    db.prepare('DELETE FROM service_categories WHERE id=?').run(id);
    logAudit({ adminId: req.user.id, actorName: req.user.name, action: 'حذف مهنة', targetType: 'service', targetId: id, details: { name: svc.name } });
    io.emit('services-updated', { type: 'deleted', name: svc.name });
    res.json({ ok: true });
  });

  router.post('/admin/packages', auth, requireRole('admin'), (req, res) => {
    const { name, bonus, commission_per_order } = req.body;
    const amount = Number(req.body.amount);
    const bonusVal = Number(bonus || 0);
    const commission = Number(commission_per_order || 2);
    if (!clean(name) || clean(name).length < 2) return res.status(400).json({ error: 'اسم الباقة مطلوب' });
    // [SEC-FIX-PKGFINITE-01] راجع DECISIONS.md — نفس فحص Number.isFinite
    // المستخدَم أصلاً بـ/admin/users/:id/balance أعلاه؛ `!amount` وحدها لا
    // ترفض Infinity (تُقيَّم falsy فقط لـ0/NaN، لا لـInfinity)، وbonus/commission
    // كانا بلا أي فحص isFinite إطلاقاً فيقبلان Infinity أو NaN (NaN يُخزَّن
    // NULL بصمت بـbetter-sqlite3، بلا أي خطأ).
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'قيمة الباقة يجب أن تكون أكبر من صفر' });
    if (!Number.isFinite(bonusVal) || bonusVal < 0) return res.status(400).json({ error: 'البونص لا يمكن أن يكون سالباً' });
    if (!Number.isFinite(commission) || commission < 0) return res.status(400).json({ error: 'العمولة لا يمكن أن تكون سالبة' });
    // [SEC-FIX-AMOUNTBOUND-01] راجع DECISIONS.md — أعلى الملف. commission_per_order
    // أُضيفت الآن أيضاً — كانت مستثناة عمداً بالإصلاح الأصلي (لم تُطلَب صراحة
    // وقتها)، لكن رقم عمولة غير واقعي (مثال: 99999999999) كان يمر بلا أي سقف
    // ويُخصَم فعلياً من كل طلب شحن يُوافَق عليه على هذه الباقة.
    if (amount > MAX_FINANCIAL_AMOUNT || bonusVal > MAX_FINANCIAL_AMOUNT || commission > MAX_FINANCIAL_AMOUNT) return res.status(400).json({ error: `القيمة كبيرة جداً، الحد الأقصى ${MAX_FINANCIAL_AMOUNT} د.أ` });
    const info = db.prepare('INSERT INTO packages(name,amount,bonus,commission_per_order) VALUES(?,?,?,?)').run(clean(name), amount, bonusVal, commission);
    logAudit({ adminId: req.user.id, actorName: req.user.name, action: 'إضافة باقة', targetType: 'package', targetId: info.lastInsertRowid, details: { name: clean(name), amount, bonus: bonusVal, commission } });
    res.json({ package: db.prepare('SELECT * FROM packages WHERE id=?').get(info.lastInsertRowid) });
  });

  // ── تعديل باقة موجودة ──
  // [FIX-PACKAGEACTIVE-01] عمود packages.is_active موجود أصلاً بالجدول
  // ومُستخدَم فعلياً بتصفية /meta العامة (WHERE is_active=1) — لكن لم يكن أي
  // مسار يقدر يُعيّنه غير القيمة الافتراضية 1 عند الإنشاء. نفس فلسفة تعطيل
  // مهنة بدل حذفها: باقة معطّلة تختفي فوراً من شاشة الشحن للفنيين لكن تبقى
  // بقاعدة البيانات (لا تُفقد طلبات الشحن القديمة المرتبطة بها).
  router.put('/admin/packages/:id', auth, requireRole('admin'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صحيح' });
    const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(id);
    if (!pkg) return res.status(404).json({ error: 'الباقة غير موجودة' });
    const name = clean(req.body.name);
    const amount = Number(req.body.amount);
    const bonusVal = Number(req.body.bonus || 0);
    const commission = Number(req.body.commission_per_order ?? req.body.commissionPerOrder ?? 2);
    const isActive = req.body.is_active !== undefined ? (req.body.is_active ? 1 : 0) : pkg.is_active;
    if (!name || name.length < 2) return res.status(400).json({ error: 'اسم الباقة مطلوب' });
    // [SEC-FIX-PKGFINITE-01] راجع DECISIONS.md وتعليق POST /admin/packages أعلاه.
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'قيمة الباقة يجب أن تكون أكبر من صفر' });
    if (!Number.isFinite(bonusVal) || bonusVal < 0) return res.status(400).json({ error: 'البونص لا يمكن أن يكون سالباً' });
    if (!Number.isFinite(commission) || commission < 0) return res.status(400).json({ error: 'العمولة لا يمكن أن تكون سالبة' });
    // [SEC-FIX-AMOUNTBOUND-01] راجع DECISIONS.md — أعلى الملف. commission_per_order مضافة الآن أيضاً (راجع تعليق POST أعلاه).
    if (amount > MAX_FINANCIAL_AMOUNT || bonusVal > MAX_FINANCIAL_AMOUNT || commission > MAX_FINANCIAL_AMOUNT) return res.status(400).json({ error: `القيمة كبيرة جداً، الحد الأقصى ${MAX_FINANCIAL_AMOUNT} د.أ` });
    db.prepare('UPDATE packages SET name=?, amount=?, bonus=?, commission_per_order=?, is_active=? WHERE id=?')
      .run(name, amount, bonusVal, commission, isActive, id);
    logAudit({ adminId: req.user.id, actorName: req.user.name, action: 'تعديل باقة', targetType: 'package', targetId: id, details: { name, amount, bonus: bonusVal, commission, is_active: isActive } });
    res.json({ package: db.prepare('SELECT * FROM packages WHERE id=?').get(id) });
  });

  router.delete('/admin/packages/:id', auth, requireRole('admin'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صحيح' });
    const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(id);
    if (!pkg) return res.status(404).json({ error: 'الباقة غير موجودة' });
    db.prepare('DELETE FROM packages WHERE id=?').run(id);
    logAudit({ adminId: req.user.id, actorName: req.user.name, action: 'حذف باقة', targetType: 'package', targetId: id, details: { name: pkg.name } });
    res.json({ ok: true });
  });

  // ── إلغاء طلب من الأدمن — سبب إلزامي ──
  router.post('/admin/requests/:id/cancel', auth, requireRole('admin'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صحيح' });
    const r = db.prepare('SELECT * FROM requests WHERE id=?').get(id);
    if (!r) return res.status(404).json({ error: 'الطلب غير موجود' });
    if (['مكتمل', 'ملغي'].includes(r.status)) return res.status(400).json({ error: 'هذا الطلب مغلق أصلاً (مكتمل أو ملغي)' });
    const reason = clean(req.body.reason || '');
    if (!reason || reason.length < 3) return res.status(400).json({ error: 'سبب الإلغاء إلزامي (3 أحرف على الأقل)' });
    if (reason.length > 500) return res.status(400).json({ error: 'السبب طويل جداً، الحد الأقصى 500 حرف' });
    // [DATA-INTEGRITY-04] راجع DECISIONS.md — نفس نمط applyRejection/applyAcceptance
    // بـoffers.routes.js: معاملة واحدة، لا كتابتان منفصلتان.
    const doCancel = db.transaction(() => {
      db.prepare("UPDATE offers SET status='rejected', updated_at=CURRENT_TIMESTAMP WHERE request_id=? AND status='pending'").run(id);
      db.prepare("UPDATE requests SET status='ملغي', cancel_reason=?, cancelled_by=?, cancelled_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(reason, req.user.id, id);
    });
    doCancel();
    const request = db.prepare('SELECT * FROM requests WHERE id=?').get(id);
    safeEmit(id, 'request-status-updated', { request });
    io.to(`user-${request.customer_id}`).emit('requests-updated', { request });
    if (request.technician_id) io.to(`user-${request.technician_id}`).emit('requests-updated', { request });
    io.to('admin-room').emit('requests-updated', { request });
    logAudit({
      adminId: req.user.id, actorName: req.user.name,
      action: 'إلغاء طلب', targetType: 'request', targetId: id,
      details: { reason, previous_status: r.status }
    });
    res.json({ request });
  });

  // [FEAT-ADMINREQUESTDETAIL-01] راجع DECISIONS.md — لم يكن هناك أي endpoint
  // يجمّع صورة كاملة لطلب واحد قبل هذا. أدمن يحاول الحكم بنزاع كان مضطراً
  // يجمّع القطع يدوياً من شاشات منفصلة (قائمة الطلبات المسطَّحة، بروفايل
  // العميل، بروفايل الفني) — ولا شاشة، ولا حتى endpoint، تعرض محادثة الطلب
  // رغم أن canAccessRequestChat (utils/helpers.js) تسمح للأدمن بها صراحة
  // منذ البداية. هذا المسار يجمع الثلاثة معاً: صف الطلب كاملاً (يشمل
  // cancel_reason/cancelled_by/cancelled_at — مُسجَّلة أصلاً بقاعدة البيانات
  // منذ POST /admin/requests/:id/cancel لكن لم تكن تُعرَض بأي مكان)، كل
  // العروض المُقدَّمة عليه (لا المقبول فقط — تاريخ التفاوض كاملاً يهمّ عند
  // الحكم بنزاع)، والمحادثة الكاملة (عبر getMessages المشتركة نفسها
  // المستخدَمة بـGET /requests/:id/messages — لا نسخة SQL موازية، نفس درس
  // SEC-FIX-CHATACCESS-CHOKEPOINT-01 بالضبط). عمداً بلا استدعاء
  // markChatRead — عرض الأدمن للمحادثة لا يجوز أن يغيّر مؤشر "تمت المشاهدة"
  // الخاص بالطرفين الفعليين.
  //
  // [FEAT-REFUND-01] راجع DECISIONS.md — ledger يحمل الآن عمود request_id
  // فعلياً (لم يكن موجوداً وقت كتابة هذا المسار أول مرة، راجع config/migrate.js)،
  // لكن هذا المسار عمداً لا يزال بلا أي join لقيود دفتر الأستاذ — خارج نطاق
  // ما طُلب بهذه الجولة (البند #2 فقط: عرض الطلب/العروض/المحادثة). العمود
  // الموثوق فعلاً لمعرفة "هل خُصمت عمولة على هذا الطلب تحديداً وكم" يبقى
  // requests.commission_charged نفسه (موجود أصلاً ضمن SELECT * أدناه)، وحالة
  // الاسترداد عبر commission_refunded_at الجديد أيضاً — كلاهما كافٍ لعرض
  // بند "الاسترداد" بشاشة تفاصيل الطلب لاحقاً بلا أي join إضافي لو طُلب ذلك.
  router.get('/admin/requests/:id', auth, requireRole('admin'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صحيح' });
    const request = db.prepare(`
      SELECT r.*,
        c.name customer_name, c.phone customer_phone,
        t.name technician_name, t.phone technician_phone,
        cb.name cancelled_by_name
      FROM requests r
      JOIN users c ON c.id = r.customer_id
      LEFT JOIN users t ON t.id = r.technician_id
      LEFT JOIN users cb ON cb.id = r.cancelled_by
      WHERE r.id = ?
    `).get(id);
    if (!request) return res.status(404).json({ error: 'الطلب غير موجود' });

    const offers = db.prepare(`
      SELECT o.*, u.name technician_name
      FROM offers o
      JOIN users u ON u.id = o.technician_id
      WHERE o.request_id = ?
      ORDER BY o.id
    `).all(id);

    const messages = getMessages(req.user, id);

    res.json({ request, offers, messages });
  });

  // [FEAT-REFUND-01] راجع DECISIONS.md — استرداد إداري حقيقي لعمولة طلب،
  // البند #3 من أدوات حل النزاعات المعتمدة. قبل هذا المسار كانت "adjustUserBalance"
  // أعلاه (POST /admin/users/:id/balance) الأداة الوحيدة المتاحة لتعويض فني —
  // لكنها تكتب دائماً كـ'تعديل يدوي من الإدارة'، فلا فرق مرئي بين استرداد
  // نزاع فعلي وأي تعديل رصيد عشوائي آخر. هذا المسار مخصَّص فقط لعكس عمولة
  // مخصومة فعلياً على طلب بعينه: نوع ledger مختلف تماماً ('استرداد عمولة نزاع')
  // ومرتبط بـrequest_id (العمود الجديد)، فيبقى قابلاً للتمييز والتتبّع للأبد
  // عن أي تعديل يدوي عام.
  //
  // استرداد كامل فقط، لا مبلغ جزئي يُدخله الأدمن — "استرداد جزئي أسوأ من
  // عدمه" (قرار صاحب المنتج). المبلغ المُستَرَد = commission_charged بالضبط،
  // محسوب من الخادم لا من مدخل مستخدم، فلا احتمال لخطأ كتابة يعكس مبلغاً
  // خاطئاً. commission_charged نفسه لا يُصفَّر أو يُعاد كتابته أبداً — يبقى
  // السجل التاريخي لما خُصم فعلياً لحظة الإكمال؛ commission_refunded_at وحده
  // يميّز الحالة، ويمنع استرداداً ثانياً لنفس الطلب.
  //
  // معاملة واحدة (db.transaction) لتحديث رصيد الفني وضبط commission_refunded_at
  // وكتابة قيد ledger معاً — لا يمكن أن ينجح جزء ويفشل آخر (بالضبط طلب صاحب
  // المنتج: "عكس commission_charged وإضافة الرصيد للفني معاملة واحدة").
  router.post('/admin/requests/:id/refund-commission', auth, requireRole('admin'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صحيح' });
    const r = db.prepare('SELECT * FROM requests WHERE id=?').get(id);
    if (!r) return res.status(404).json({ error: 'الطلب غير موجود' });
    if (!r.technician_id) return res.status(400).json({ error: 'لا يوجد فني مرتبط بهذا الطلب', code: 'REQUEST_NO_TECHNICIAN' });
    if (r.commission_charged === null || r.commission_charged <= 0) {
      return res.status(400).json({ error: 'لا توجد عمولة مخصومة على هذا الطلب لاستردادها', code: 'REQUEST_NO_COMMISSION_CHARGED' });
    }
    if (r.commission_refunded_at) return res.status(400).json({ error: 'تم استرداد عمولة هذا الطلب مسبقاً', code: 'REQUEST_ALREADY_REFUNDED' });
    const reason = clean(req.body.reason || '');
    if (!reason || reason.length < 3) return res.status(400).json({ error: 'سبب الاسترداد إلزامي (3 أحرف على الأقل)' });
    if (reason.length > 300) return res.status(400).json({ error: 'السبب طويل جداً، الحد الأقصى 300 حرف' });

    const tech = db.prepare('SELECT * FROM users WHERE id=?').get(r.technician_id);
    if (!tech) return res.status(404).json({ error: 'الفني غير موجود' });
    if (tech.deleted_at) return res.status(400).json({ error: 'لا يمكن استرداد عمولة لحساب فني محذوف', code: 'TECHNICIAN_DELETED' });

    const amount = Number(r.commission_charged);
    const after = Number((Number(tech.balance || 0) + amount).toFixed(2));

    const doRefund = db.transaction(() => {
      db.prepare('UPDATE users SET balance=? WHERE id=?').run(after, tech.id);
      db.prepare('UPDATE requests SET commission_refunded_at=CURRENT_TIMESTAMP WHERE id=?').run(id);
      db.prepare('INSERT INTO ledger(user_id,type,amount,balance_after,note,request_id) VALUES(?,?,?,?,?,?)')
        .run(tech.id, 'استرداد عمولة نزاع', amount, after, reason, id);
    });
    doRefund();

    logAudit({
      adminId: req.user.id, actorName: req.user.name,
      action: 'استرداد عمولة طلب', targetType: 'request', targetId: id,
      details: { technician_id: tech.id, amount, balance_after: after, reason }
    });
    io.to(`user-${tech.id}`).emit('balance-updated', { balance: after, status: 'admin-refunded' });

    // نفس نمط FIX-NOTIF-GAP-01 أعلاه بالضبط (adjustUserBalance) — Push + سجلّ دائم.
    if (tech.fcm_token) {
      sendPush(tech.fcm_token, '💰 تم استرداد عمولة طلب لحسابك', reason, { type: 'topup' });
    }
    notify({
      userId: tech.id,
      type: 'wallet',
      title: 'تم استرداد عمولة طلب لحسابك',
      body: reason,
      data: { refundedBy: 'admin', requestId: id }
    });

    res.json({ ok: true, request_id: id, technician_id: tech.id, amount, balance_after: after });
  });

  // ── سجل عمليات الأدمن (Audit Log) ──
  router.get('/admin/audit-logs', auth, requireRole('admin'), (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const search = clean(req.query.search || '');
    let where = '';
    const params = [];
    if (search) {
      // [SEC-FIX-LIKEESCAPE-01] راجع DECISIONS.md وutils/helpers.js:escapeLike —
      // نفس العلّة بالضبط، بنسخة منفصلة مكتوبة يدوياً هنا بدل استدعاء
      // escapeLike المشتركة: `\` قبل `%`/`_` بلا `ESCAPE '\'' صريحة بجملة SQL
      // لا يمنحها أي معنى خاص بـSQLite، فالبحث عن سبب/تفاصيل تحوي % أو _
      // حرفياً كان يعيد صفر نتائج دائماً بدل مطابقتها كما كُتبت.
      where = "WHERE actor_name LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR target_type LIKE ? ESCAPE '\\' OR details LIKE ? ESCAPE '\\'";
      const w = '%' + search.replace(/[%_\\]/g, c => '\\' + c) + '%';
      params.push(w, w, w, w);
    }
    // [FIX-08] حماية دفاعية: لو الجدول غير موجود بعد لأي سبب (مثلاً DB لم يُعَد تشغيلها بعد
    // إضافة هذه الميزة)، أرجع سجلاً فارغاً بدل خطأ 500 خام.
    try {
      const total = db.prepare(`SELECT COUNT(*) c FROM audit_logs ${where}`).get(...params).c;
      const logs = db.prepare(`SELECT * FROM audit_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
      res.json({ logs, total });
    } catch (e) {
      console.error('audit-logs query failed (هل تم إعادة تشغيل السيرفر بعد إضافة الجدول؟):', e.message);
      res.json({ logs: [], total: 0 });
    }
  });

  return router;
};
