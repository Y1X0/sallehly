// routes/admin.routes.js — /api/admin/*
const express = require('express');

module.exports = function (deps) {
  const { db, path } = deps;
  const { io, safeEmit } = deps.realtime;
  const { auth, requireRole } = deps.middleware;
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
        topTechs
      }
    });
  });

  router.get('/admin/users', auth, requireRole('admin'), (req, res) => res.json({ users: db.prepare('SELECT id,role,name,email,phone,national_number,city,areas,services,is_active,balance,free_orders_used,rating_avg,rating_count,completed_jobs,created_at FROM users ORDER BY id DESC').all() }));

  router.post('/admin/users/:id/toggle', auth, requireRole('admin'), (req, res) => {
    if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'لا يمكنك إيقاف حسابك الخاص' });
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    if (!u) return res.status(404).json({ error: 'المستخدم غير موجود' });
    const newStatus = u.is_active ? 0 : 1;
    db.prepare('UPDATE users SET is_active=? WHERE id=?').run(newStatus, u.id);
    logAudit({
      adminId: req.user.id, actorName: req.user.name,
      action: newStatus ? 'تفعيل مستخدم' : 'إيقاف مستخدم',
      targetType: 'user', targetId: u.id,
      details: { name: u.name, email: u.email }
    });
    res.json({ ok: true });
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

  router.post('/admin/services', auth, requireRole('admin'), (req, res) => {
    const name = clean(req.body.name);
    const icon = clean(req.body.icon) || '🔧';
    if (name.length < 2) return res.status(400).json({ error: 'اسم المهنة قصير' });
    if (name.length > 50) return res.status(400).json({ error: 'اسم المهنة طويل جداً، الحد الأقصى 50 حرف' });
    if (icon.length > 10) return res.status(400).json({ error: 'رمز المهنة طويل جداً' });
    try {
      const info = db.prepare('INSERT INTO service_categories(name,icon) VALUES(?,?)').run(name, icon);
      logAudit({ adminId: req.user.id, actorName: req.user.name, action: 'إضافة مهنة', targetType: 'service', targetId: info.lastInsertRowid, details: { name, icon } });
      res.json({ service: db.prepare('SELECT * FROM service_categories WHERE id=?').get(info.lastInsertRowid) });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'هذه المهنة موجودة مسبقاً' });
      res.status(500).json({ error: 'تعذر إضافة المهنة' });
    }
  });

  router.delete('/admin/services/:id', auth, requireRole('admin'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صحيح' });
    const svc = db.prepare('SELECT * FROM service_categories WHERE id=?').get(id);
    if (!svc) return res.status(404).json({ error: 'المهنة غير موجودة' });
    db.prepare('DELETE FROM service_categories WHERE id=?').run(id);
    logAudit({ adminId: req.user.id, actorName: req.user.name, action: 'حذف مهنة', targetType: 'service', targetId: id, details: { name: svc.name } });
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
  router.put('/admin/packages/:id', auth, requireRole('admin'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صحيح' });
    const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(id);
    if (!pkg) return res.status(404).json({ error: 'الباقة غير موجودة' });
    const name = clean(req.body.name);
    const amount = Number(req.body.amount);
    const bonusVal = Number(req.body.bonus || 0);
    const commission = Number(req.body.commission_per_order ?? req.body.commissionPerOrder ?? 2);
    if (!name || name.length < 2) return res.status(400).json({ error: 'اسم الباقة مطلوب' });
    if (!amount || amount <= 0) return res.status(400).json({ error: 'قيمة الباقة يجب أن تكون أكبر من صفر' });
    if (bonusVal < 0) return res.status(400).json({ error: 'البونص لا يمكن أن يكون سالباً' });
    if (commission < 0) return res.status(400).json({ error: 'العمولة لا يمكن أن تكون سالبة' });
    db.prepare('UPDATE packages SET name=?, amount=?, bonus=?, commission_per_order=? WHERE id=?')
      .run(name, amount, bonusVal, commission, id);
    logAudit({ adminId: req.user.id, actorName: req.user.name, action: 'تعديل باقة', targetType: 'package', targetId: id, details: { name, amount, bonus: bonusVal, commission } });
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
    const total = db.prepare(`SELECT COUNT(*) c FROM audit_logs ${where}`).get(...params).c;
    const logs = db.prepare(`SELECT * FROM audit_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    res.json({ logs, total });
  });

  return router;
};
