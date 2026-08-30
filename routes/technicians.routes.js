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
    if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صحيح', code: 'INVALID_ID' });
    const tech = db.prepare(`SELECT id,name,city,areas,services,avatar_url,rating_avg,rating_count,completed_jobs,is_active,created_at FROM users WHERE id=? AND role='technician'`).get(id);
    if (!tech) return res.status(404).json({ error: 'الفني غير موجود', code: 'TECHNICIAN_NOT_FOUND' });
    // [FIX-DELETE-01] فني محذوف (حساب مُجهَّل الهوية) لا يظهر ملفه الشخصي
    // بعد الآن، حتى بمعرفة الرابط المباشر — يطابق ما تصفه صفحة حذف الحساب.
    if (!tech.is_active) return res.status(404).json({ error: 'هذا الحساب لم يعد متاحاً', code: 'TECHNICIAN_ACCOUNT_UNAVAILABLE' });
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
    // [SEC-FIX-LIKEESCAPE-01] راجع DECISIONS.md — escapeLike() وحدها بلا
    // `ESCAPE '\'` صريحة بجملة SQL نفسها لا تفعل شيئاً: SQLite لا يعطي أي
    // معنى خاص لـ`\` بمحارف LIKE افتراضياً (بعكس لغات/محركات أخرى)، فبقي
    // `%`/`_` بعد الـ`\` المُدرَج يعملان كوايلدكارد كما هما — أُثبت مباشرة
    // (سكربت better-sqlite3 مستقل) أن `ESCAPE '\'` ضرورية ليصبح `\%`/`\_`
    // تطابقاً حرفياً فعلياً، لا مجرد تجميلي. بدونها، بحث بلا `ESCAPE` عن اسم/
    // مدينة/منطقة تحوي `%` أو `_` حرفياً (نادر لكن ممكن) كان يعيد صفر نتائج
    // دائماً (يتطلّب `\` حرفياً غير موجود بالبيانات الحقيقية) بدل مطابقة
    // القيمة كما كتبها المستخدم فعلاً.
    if (wanted) { const w = escapeLike(wanted); sql += " AND (services LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')"; params.push('%' + w + '%', '%' + w + '%'); }
    if (city) { const c = escapeLike(city); sql += " AND (city=? OR areas LIKE ? ESCAPE '\\')"; params.push(city, '%' + c + '%'); }
    if (area) { const a = escapeLike(area); sql += " AND (areas LIKE ? ESCAPE '\\' OR city=?)"; params.push('%' + a + '%', city || area); }
    // [PERF-HARDEN-01] بلا سقف سابقاً — endpoint عام يستخدمه كل عميل يبحث عن
    // فني، بلا أي حد أقصى للنتائج المُرجَعة. 500 سقف وقائي بحت (لا يوجد
    // سيناريو واقعي حالي فيه أكثر من 500 نتيجة مطابقة لبحث واحد) يمنع نمو
    // الاستجابة بلا حدود مع نمو عدد الفنيين المسجَّلين مستقبلاً.
    sql += ' ORDER BY rating_avg DESC, completed_jobs DESC, created_at DESC LIMIT 500';
    res.json({ technicians: db.prepare(sql).all(...params) });
  });

  return router;
};
