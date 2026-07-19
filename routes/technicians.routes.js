// routes/technicians.routes.js — /api/technicians, /api/technicians/:id/profile
const express = require('express');

module.exports = function (deps) {
  const { db } = deps;
  const { auth } = deps.middleware;
  const { escapeLike, clean } = deps.utils;
  const router = express.Router();

  // ── بروفايل الفني العام ───────────────────────────────────────────────────
  router.get('/technicians/:id/profile', auth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صحيح' });
    const tech = db.prepare(`SELECT id,name,city,areas,services,avatar_url,rating_avg,rating_count,completed_jobs,is_active,created_at FROM users WHERE id=? AND role='technician'`).get(id);
    if (!tech) return res.status(404).json({ error: 'الفني غير موجود' });
    // [FIX-DELETE-01] فني محذوف (حساب مُجهَّل الهوية) لا يظهر ملفه الشخصي
    // بعد الآن، حتى بمعرفة الرابط المباشر — يطابق ما تصفه صفحة حذف الحساب.
    if (!tech.is_active) return res.status(404).json({ error: 'هذا الحساب لم يعد متاحاً' });
    const reviews = db.prepare(`SELECT r.stars,r.comment,r.created_at,u.name customer_name FROM ratings r JOIN users u ON u.id=r.customer_id WHERE r.technician_id=? ORDER BY r.id DESC LIMIT 10`).all(id);
    res.json({ tech, reviews });
  });

  router.get('/technicians', auth, (req, res) => {
    const service = clean(req.query.service), city = clean(req.query.city), area = clean(req.query.area), q = clean(req.query.q);
    // phone only returned to admin — customers see all other public fields
    const phoneField = req.user.role === 'admin' ? ', phone' : '';
    let sql = `SELECT id,name${phoneField},city,areas,services,avatar_url,rating_avg,rating_count,completed_jobs,is_active FROM users WHERE role='technician' AND is_active=1`;
    const params = [];
    const wanted = service || q;
    // [SEC-FIX-05] Escape LIKE wildcards before interpolation
    if (wanted) { const w = escapeLike(wanted); sql += " AND (services LIKE ? OR name LIKE ?)"; params.push('%' + w + '%', '%' + w + '%'); }
    if (city) { const c = escapeLike(city); sql += " AND (city=? OR areas LIKE ?)"; params.push(city, '%' + c + '%'); }
    if (area) { const a = escapeLike(area); sql += " AND (areas LIKE ? OR city=?)"; params.push('%' + a + '%', city || area); }
    // [PERF-HARDEN-01] بلا سقف سابقاً — endpoint عام يستخدمه كل عميل يبحث عن
    // فني، بلا أي حد أقصى للنتائج المُرجَعة. 500 سقف وقائي بحت (لا يوجد
    // سيناريو واقعي حالي فيه أكثر من 500 نتيجة مطابقة لبحث واحد) يمنع نمو
    // الاستجابة بلا حدود مع نمو عدد الفنيين المسجَّلين مستقبلاً.
    sql += ' ORDER BY rating_avg DESC, completed_jobs DESC, created_at DESC LIMIT 500';
    res.json({ technicians: db.prepare(sql).all(...params) });
  });

  return router;
};
