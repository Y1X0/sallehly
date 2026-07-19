// routes/topups.routes.js — /api/topups, /api/admin/topups/:id/review, /api/ledger
const express = require('express');

module.exports = function (deps) {
  const { db } = deps;
  const { io } = deps.realtime;
  const { auth, requireRole, upload } = deps.middleware;
  const { clean, logAudit } = deps.utils;
  const { sendPush } = deps.services;
  const router = express.Router();

  router.post('/topups', auth, requireRole('technician'), upload.single('receipt'), (req, res) => {
    const pkg = db.prepare('SELECT * FROM packages WHERE id=? AND is_active=1').get(req.body.package_id);
    if (!pkg) return res.status(404).json({ error: 'الباقة غير موجودة' });
    // منع إرسال أكثر من طلب شحن معلق في نفس الوقت
    const pendingCount = db.prepare("SELECT COUNT(*) c FROM topups WHERE technician_id=? AND status='pending'").get(req.user.id).c;
    if (pendingCount >= 2) return res.status(429).json({ error: 'لديك طلبات شحن قيد المراجعة. انتظر موافقة الإدارة أولاً' });
    if (!req.file) return res.status(400).json({ error: 'يجب رفع صورة إثبات الدفع' });
    const receipt_url = '/uploads/payments/' + req.file.filename;
    const info = db.prepare('INSERT INTO topups(technician_id,package_id,amount,bonus,receipt_url) VALUES(?,?,?,?,?)').run(req.user.id, pkg.id, pkg.amount, pkg.bonus, receipt_url);
    const topup = db.prepare('SELECT * FROM topups WHERE id=?').get(info.lastInsertRowid);

    // [SEC-FIX-03] Topup notifications only to admin + the technician themselves
    io.to('admin-room').emit('topup-created', { topup });
    io.to(`user-${req.user.id}`).emit('topup-created', { topup });
    res.json({ topup: db.prepare('SELECT * FROM topups WHERE id=?').get(info.lastInsertRowid) });
  });

  // [PERF-HARDEN-01] فرع الأدمن (كل طلبات الشحن على المنصة) كان بلا سقف —
  // نفس المخاطرة المُثبتة بـGET /admin/users. فرع الفني (سطر تحته) لا يحتاج
  // سقفاً مماثلاً: محصور بمعرّف الفني نفسه (WHERE technician_id=?) فلن ينمو
  // بلا حدود مهما كبرت المنصة.
  router.get('/topups', auth, (req, res) => {
    if (req.user.role === 'admin') return res.json({ topups: db.prepare('SELECT tp.*,u.name technician_name,u.phone,p.name package_name FROM topups tp JOIN users u ON u.id=tp.technician_id JOIN packages p ON p.id=tp.package_id ORDER BY tp.id DESC LIMIT 2000').all() });
    res.json({ topups: db.prepare('SELECT tp.*,p.name package_name FROM topups tp JOIN packages p ON p.id=tp.package_id WHERE technician_id=? ORDER BY id DESC').all(req.user.id) });
  });

  router.post('/admin/topups/:id/review', auth, requireRole('admin'), (req, res) => {
    const t = db.prepare('SELECT * FROM topups WHERE id=?').get(req.params.id);
    if (!t || t.status !== 'pending') return res.status(400).json({ error: 'طلب الشحن غير صالح' });
    const status = clean(req.body.status);
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'قرار غير صحيح' });
    const adminNote = clean(req.body.admin_note || '');
    if (adminNote.length > 500) return res.status(400).json({ error: 'ملاحظة المراجعة طويلة جداً' });
    const doReview = db.transaction(() => {
      if (status === 'approved') {
        const tech = db.prepare('SELECT * FROM users WHERE id=?').get(t.technician_id);
        const add = Number(t.amount) + Number(t.bonus || 0); const after = Number((tech.balance + add).toFixed(2));
        const pkg = db.prepare('SELECT commission_per_order FROM packages WHERE id=?').get(t.package_id);
        const newCommission = Number(pkg?.commission_per_order ?? tech.active_commission ?? 2);
        db.prepare('UPDATE users SET balance=?, active_commission=? WHERE id=?').run(after, newCommission, tech.id);
        db.prepare('INSERT INTO ledger(user_id,type,amount,balance_after,note) VALUES(?,?,?,?,?)').run(tech.id, 'شحن رصيد', add, after, `موافقة على طلب شحن رقم ${t.id}`);
      }
      db.prepare('UPDATE topups SET status=?, admin_note=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?').run(status, adminNote, t.id);
    });
    doReview();
    logAudit({
      adminId: req.user.id, actorName: req.user.name,
      action: status === 'approved' ? 'الموافقة على شحن رصيد' : 'رفض طلب شحن',
      targetType: 'topup', targetId: t.id,
      details: { technician_id: t.technician_id, amount: t.amount, bonus: t.bonus, admin_note: adminNote }
    });
    // [REALTIME] إبلاغ الفني فوراً بنتيجة الشحن وتحديث رصيده دون إعادة تشغيل
    if (status === 'approved') {
      const updated = db.prepare('SELECT balance, active_commission FROM users WHERE id=?').get(t.technician_id);
      io.to(`user-${t.technician_id}`).emit('balance-updated', {
        balance: updated?.balance ?? 0,
        active_commission: updated?.active_commission ?? 2,
        topupId: t.id,
        status: 'approved'
      });
      sendPush(db.prepare('SELECT fcm_token FROM users WHERE id=?').get(t.technician_id)?.fcm_token,
        '✅ تمت الموافقة على الشحن', `تم إضافة ${Number(t.amount) + Number(t.bonus || 0)} د.أ إلى رصيدك`, { type: 'topup' });
    } else {
      io.to(`user-${t.technician_id}`).emit('balance-updated', { topupId: t.id, status: 'rejected' });
    }
    res.json({ topup: db.prepare('SELECT * FROM topups WHERE id=?').get(t.id) });
  });

  router.get('/ledger', auth, (req, res) => {
    let id = req.user.id;
    if (req.user.role === 'admin' && req.query.user_id) {
      const parsed = parseInt(req.query.user_id, 10);
      if (isNaN(parsed) || parsed <= 0) return res.status(400).json({ error: 'معرّف المستخدم غير صحيح' });
      id = parsed;
    }
    res.json({ ledger: db.prepare('SELECT * FROM ledger WHERE user_id=? ORDER BY id DESC').all(id) });
  });

  return router;
};
