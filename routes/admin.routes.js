// routes/admin.routes.js — /api/admin/*
const express = require('express');

module.exports = function (deps) {
  const { db, path } = deps;
  const { auth, requireRole } = deps.middleware;
  const { clean } = deps.utils;
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
    db.prepare('UPDATE users SET is_active=? WHERE id=?').run(u.is_active ? 0 : 1, u.id);
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
    res.json({ package: db.prepare('SELECT * FROM packages WHERE id=?').get(info.lastInsertRowid) });
  });

  router.delete('/admin/packages/:id', auth, requireRole('admin'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صحيح' });
    const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(id);
    if (!pkg) return res.status(404).json({ error: 'الباقة غير موجودة' });
    db.prepare('DELETE FROM packages WHERE id=?').run(id);
    res.json({ ok: true });
  });

  return router;
};
