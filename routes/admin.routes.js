// routes/admin.routes.js — /api/admin/*
const express = require('express');

module.exports = function (deps) {
  const { db, path } = deps;
  const { io, safeEmit } = deps.realtime;
  const { auth, requireRole, requireSuperAdmin } = deps.middleware;
  const { clean, logAudit } = deps.utils;
  const { createDbBackup } = deps.services;
  const router = express.Router();

  router.post('/admin/backup', auth, requireRole('admin'), (req, res) => {
    const file = createDbBackup();
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
  router.get('/admin/users', auth, requireRole('admin'), (req, res) => {
    const baseSql = 'SELECT id,role,name,email,phone,national_number,city,areas,services,is_active,balance,free_orders_used,rating_avg,rating_count,completed_jobs,created_at FROM users ORDER BY id DESC';

    if (req.query.page == null && req.query.limit == null) {
      // السلوك الافتراضي القديم — بدون أي تغيير
      return res.json({ users: db.prepare(baseSql).all() });
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
    const newStatus = u.is_active ? 0 : 1;
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
    const amount = Number(req.body.amount);
    const reason = clean(req.body.reason || '');
    if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'أدخل مبلغاً صحيحاً (موجب للإضافة، سالب للخصم)' });
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
    const activeRequest = db.prepare(
      "SELECT id FROM requests WHERE (customer_id=? OR technician_id=?) AND status IN ('بانتظار العروض','وصلت عروض','تم اختيار عرض','قيد التنفيذ','بانتظار تأكيد الدفع') LIMIT 1"
    ).get(id, id);
    if (activeRequest) return res.status(409).json({ error: `لا يمكن حذف هذا الحساب — عنده طلب نشط رقم ${activeRequest.id}. أنهِ أو ألغِ الطلب أولاً.` });
    if (Number(u.balance || 0) > 0) return res.status(409).json({ error: `لا يمكن حذف هذا الحساب — رصيده الحالي ${u.balance} د.أ. صفّر الرصيد أولاً.` });
    db.prepare('DELETE FROM users WHERE id=?').run(id);
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
    if (!amount || amount <= 0) return res.status(400).json({ error: 'قيمة الباقة يجب أن تكون أكبر من صفر' });
    if (bonusVal < 0) return res.status(400).json({ error: 'البونص لا يمكن أن يكون سالباً' });
    if (commission < 0) return res.status(400).json({ error: 'العمولة لا يمكن أن تكون سالبة' });
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
    if (!amount || amount <= 0) return res.status(400).json({ error: 'قيمة الباقة يجب أن تكون أكبر من صفر' });
    if (bonusVal < 0) return res.status(400).json({ error: 'البونص لا يمكن أن يكون سالباً' });
    if (commission < 0) return res.status(400).json({ error: 'العمولة لا يمكن أن تكون سالبة' });
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
    db.prepare("UPDATE offers SET status='rejected', updated_at=CURRENT_TIMESTAMP WHERE request_id=? AND status='pending'").run(id);
    db.prepare("UPDATE requests SET status='ملغي', cancel_reason=?, cancelled_by=?, cancelled_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(reason, req.user.id, id);
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

  // ── سجل عمليات الأدمن (Audit Log) ──
  router.get('/admin/audit-logs', auth, requireRole('admin'), (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const search = clean(req.query.search || '');
    let where = '';
    const params = [];
    if (search) {
      where = 'WHERE actor_name LIKE ? OR action LIKE ? OR target_type LIKE ? OR details LIKE ?';
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
