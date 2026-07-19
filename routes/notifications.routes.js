// routes/notifications.routes.js — /api/notifications
// [NOTIF-PHASE2A] قراءة الإشعارات الدائمة فقط (جدول notifications، أُضيف
// بمرحلة سابقة عبر config/migrate.js + utils/notification.js). لا يوجد هنا
// أي استدعاء لـnotify() من أي route آخر بعد — هذا فقط سطح القراءة/التحديث
// على ما يُدرَج مستقبلاً. لا علاقة له بـservices/push.js ولا بأي حدث Socket.IO.
const express = require('express');

module.exports = function (deps) {
  const { db } = deps;
  const { auth } = deps.middleware;
  const router = express.Router();

  // data مُخزَّنة كنص JSON بقاعدة البيانات (راجع utils/notification.js) —
  // تُعاد للعميل ككائن فعلي بدل نص خام. فشل تحليل (بيانات قديمة/تالفة، لن
  // يحدث فعلياً من notify() نفسها) لا يجوز أن يُسقط الاستجابة كلها.
  function mapNotification(row) {
    let data = null;
    if (row.data != null) {
      try { data = JSON.parse(row.data); } catch (e) { data = row.data; }
    }
    return { ...row, data, is_read: !!row.is_read };
  }

  // [PERF-HARDEN-01] نفس نمط GET /requests وGET /admin/ledger بالضبط:
  // page/limit مع حدود دنيا/قصوى، ORDER BY id DESC (id تصاعدي = ترتيب
  // إدراج زمني فعلي، يتجنّب تعادل created_at بنفس الثانية).
  router.get('/notifications', auth, (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const offset = (page - 1) * limit;

    const total = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=?').get(req.user.id).c;
    const unreadCount = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND is_read=0').get(req.user.id).c;
    const rows = db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(req.user.id, limit, offset);

    res.json({
      items: rows.map(mapNotification),
      pagination: { page, limit, total },
      unreadCount
    });
  });

  // [SEC] IDOR guard: لازم يكون صاحب الإشعار فعلاً — بدون استثناء للأدمن،
  // بنفس ما هو مطلوب صراحة ("Only owner can mark it").
  router.post('/notifications/:id/read', auth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صحيح' });
    const notif = db.prepare('SELECT * FROM notifications WHERE id=?').get(id);
    if (!notif) return res.status(404).json({ error: 'الإشعار غير موجود' });
    if (Number(notif.user_id) !== Number(req.user.id)) return res.status(403).json({ error: 'غير مصرح' });

    if (!notif.is_read) {
      db.prepare('UPDATE notifications SET is_read=1, read_at=CURRENT_TIMESTAMP WHERE id=?').run(id);
    }
    const updated = db.prepare('SELECT * FROM notifications WHERE id=?').get(id);
    res.json({ notification: mapNotification(updated) });
  });

  router.post('/notifications/read-all', auth, (req, res) => {
    const info = db.prepare(
      "UPDATE notifications SET is_read=1, read_at=CURRENT_TIMESTAMP WHERE user_id=? AND is_read=0"
    ).run(req.user.id);
    res.json({ ok: true, updated: info.changes });
  });

  return router;
};
