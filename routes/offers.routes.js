// routes/offers.routes.js — /api/requests/:id/offer(s), /api/offers/:id/decision, DELETE /api/offers/:id
const express = require('express');

module.exports = function (deps) {
  const { db } = deps;
  const { io, safeEmit } = deps.realtime;
  const { auth, requireRole } = deps.middleware;
  const { clean } = deps.utils;
  const { sendPush } = deps.services;
  const router = express.Router();

  router.post('/requests/:id/offer', auth, requireRole('technician'), (req, res) => {
    const r = db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'الطلب غير موجود' });
    if (!['بانتظار العروض', 'وصلت عروض'].includes(r.status)) return res.status(400).json({ error: 'هذا الطلب لم يعد يستقبل عروضاً' });
    if (r.technician_id && Number(r.technician_id) !== Number(req.user.id)) return res.status(403).json({ error: 'هذا الطلب مباشر لفني آخر' });
    const active = db.prepare("SELECT id, service FROM requests WHERE technician_id=? AND status IN ('تم اختيار عرض','قيد التنفيذ','بانتظار تأكيد الدفع') AND id<>? ORDER BY id DESC LIMIT 1").get(req.user.id, r.id);
    if (active) return res.status(409).json({ error: `لا يمكنك إرسال عرض جديد قبل إنهاء طلبك الحالي رقم ${active.id} - ${active.service}` });
    const tech = db.prepare('SELECT id,balance,free_offers_used,active_commission FROM users WHERE id=? AND role=\'technician\'').get(req.user.id);
    const requiredBalance = Number(tech?.active_commission ?? 2);
    const oldOffer = db.prepare('SELECT id FROM offers WHERE request_id=? AND technician_id=? LIMIT 1').get(r.id, req.user.id);
    // [FIX-OFFERQUOTA-01] free_offers_used عدّاد دائم يُزاد فقط عند نجاح إدراج
    // عرض جديد فعلياً (أسفل هذا الراوت) — لا يتأثر إطلاقاً بسحب عرض لاحقاً
    // (DELETE /offers/:id)، بعكس الحساب القديم القابل للتلاعب بإعادة تقديم/سحب.
    const quotaUsed = Number(tech?.free_offers_used || 0);
    if (!oldOffer && tech && quotaUsed >= 2 && Number(tech.balance || 0) < requiredBalance) {
      return res.status(402).json({
        code: 'INSUFFICIENT_BALANCE',
        required_balance: requiredBalance,
        current_balance: Number(tech.balance || 0),
        free_quota_used: quotaUsed,
        error: `رصيدك غير كافي. استخدمت أول فرصتين مجاناً، يجب شحن الرصيد قبل تقديم عرض جديد. الحد الأدنى المطلوب ${requiredBalance} د.أ`
      });
    }
    const price = Number(req.body.offer_price);
    const duration = clean(req.body.duration || req.body.arrival_time);
    const note = clean(req.body.note || '');
    if (!price || price < 1) return res.status(400).json({ error: 'أدخل سعر صحيح' });
    if (price > 99999) return res.status(400).json({ error: 'السعر مرتفع جداً، الحد الأقصى 99,999 د.أ' });
    if (!duration) return res.status(400).json({ error: 'أدخل مدة التنفيذ أو الوصول' });
    if (duration.length > 100) return res.status(400).json({ error: 'مدة التنفيذ طويلة جداً' });
    if (note.length > 500) return res.status(400).json({ error: 'الملاحظة طويلة جداً، الحد الأقصى 500 حرف' });
    db.prepare(`INSERT INTO offers(request_id,technician_id,price,duration,note,status) VALUES(?,?,?,?,?,'pending')
      ON CONFLICT(request_id,technician_id) DO UPDATE SET price=excluded.price,duration=excluded.duration,note=excluded.note,status='pending',updated_at=CURRENT_TIMESTAMP`)
      .run(r.id, req.user.id, price, duration, note);
    // [FIX-OFFERQUOTA-01] يُزاد فقط عند أول عرض فعلي على هذا الطلب تحديداً
    // (oldOffer كان فارغاً قبل الإدراج أعلاه) — تعديل السعر على عرض معلّق
    // موجود مسبقاً على نفس الطلب (نفس شرط ON CONFLICT أعلاه) لا يُحتسب محاولة
    // ثانية، وسحب العرض لاحقاً لا يُنقص هذا العدّاد أبداً.
    if (!oldOffer) {
      db.prepare('UPDATE users SET free_offers_used = free_offers_used + 1 WHERE id=?').run(req.user.id);
    }
    db.prepare("UPDATE requests SET status='وصلت عروض', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('بانتظار العروض','وصلت عروض')").run(r.id);

    const request = db.prepare('SELECT * FROM requests WHERE id=?').get(r.id);
    const offers = db.prepare('SELECT * FROM offers WHERE request_id=? ORDER BY id DESC').all(r.id);

    // [SEC-FIX-03] Targeted emit for offer creation
    safeEmit(r.id, 'request-status-updated', { request });
    safeEmit(r.id, 'offer-created', { requestId: r.id, request, offers });
    io.to(`user-${r.customer_id}`).emit('requests-updated', { request });
    io.to(`user-${r.customer_id}`).emit('offer-created', { requestId: r.id, request, offers });
    io.to('admin-room').emit('requests-updated', { request });
    // Push Notification للعميل خارج التطبيق
    const customer = db.prepare('SELECT fcm_token FROM users WHERE id=?').get(r.customer_id);
    if (customer?.fcm_token) {
      sendPush(customer.fcm_token,
        '🛠️ وصل عرض جديد!',
        `الفني ${req.user.name || ''} أرسل عرضاً على طلبك — اضغط للمراجعة`,
        { type: 'offer', requestId: String(r.id) }
      );
    }
    res.json({ request, offers });
  });

  router.get('/requests/:id/offers', auth, (req, res) => {
    const r = db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'الطلب غير موجود' });
    const allowed = req.user.role === 'admin' || r.customer_id === req.user.id || r.technician_id === req.user.id || req.user.role === 'technician';
    if (!allowed) return res.status(403).json({ error: 'غير مصرح' });
    // Customer IDOR guard: customers only see their own requests' offers
    if (req.user.role === 'customer' && r.customer_id !== req.user.id) return res.status(403).json({ error: 'غير مصرح' });
    let rows = db.prepare(`SELECT o.*, u.name technician_name, u.city technician_city, u.areas technician_areas, u.avatar_url, u.rating_avg, u.rating_count, u.completed_jobs
      FROM offers o JOIN users u ON u.id=o.technician_id WHERE o.request_id=? ORDER BY CASE o.status WHEN 'accepted' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, o.id DESC`).all(r.id);
    if (req.user.role === 'technician' && r.customer_id !== req.user.id && r.technician_id !== req.user.id) rows = rows.filter(o => o.technician_id === req.user.id);
    res.json({ offers: rows, request: r });
  });

  router.post('/offers/:id/decision', auth, requireRole('customer'), (req, res) => {
    const offer = db.prepare('SELECT o.*, r.customer_id, r.status request_status FROM offers o JOIN requests r ON r.id=o.request_id WHERE o.id=?').get(req.params.id);
    if (!offer) return res.status(404).json({ error: 'العرض غير موجود' });
    if (offer.customer_id !== req.user.id) return res.status(403).json({ error: 'هذا العرض لا يخصك' });
    const decision = clean(req.body.decision);
    if (!['accepted', 'rejected'].includes(decision)) return res.status(400).json({ error: 'قرار غير صحيح' });
    // [SEC-FIX-15] لازم العرض يكون لسا 'pending' — بدون هذا الفحص، عرض سبق رفضه
    // (تلقائياً عند قبول عرض تاني على نفس الطلب) أو سبق قبوله كان ممكن يُعاد اتخاذ
    // قرار "قبول" عليه من جديد، وهذا كان يعيد تعيين الطلب لفني مختلف عن الفني
    // المؤكَّد فعلياً حالياً (r.technician_id) بصمت وبدون أي تنبيه للفني الأول.
    if (offer.status !== 'pending') return res.status(400).json({ error: 'تم اتخاذ قرار على هذا العرض مسبقاً' });
    if (decision === 'rejected') {
      db.prepare("UPDATE offers SET status='rejected', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(offer.id);
      const pending = db.prepare("SELECT COUNT(*) c FROM offers WHERE request_id=? AND status='pending'").get(offer.request_id).c;
      db.prepare("UPDATE requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND technician_id IS NULL").run(pending ? 'وصلت عروض' : 'بانتظار العروض', offer.request_id);
    } else {
      const active = db.prepare("SELECT id FROM requests WHERE technician_id=? AND status IN ('تم اختيار عرض','قيد التنفيذ','بانتظار تأكيد الدفع') LIMIT 1").get(offer.technician_id);
      if (active) return res.status(409).json({ error: 'الفني أصبح لديه طلب نشط حالياً، اختر عرضاً آخر' });
      db.prepare("UPDATE offers SET status='rejected', updated_at=CURRENT_TIMESTAMP WHERE request_id=?").run(offer.request_id);
      db.prepare("UPDATE offers SET status='accepted', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(offer.id);
      db.prepare("UPDATE requests SET technician_id=?, offer_price=?, arrival_time=?, status='تم اختيار عرض', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(offer.technician_id, offer.price, offer.duration, offer.request_id);
    }
    const request = db.prepare('SELECT * FROM requests WHERE id=?').get(offer.request_id);
    const offers = db.prepare('SELECT * FROM offers WHERE request_id=? ORDER BY id DESC').all(offer.request_id);
    // [SEC-FIX-03] Targeted emit for offer decision
    safeEmit(offer.request_id, 'request-status-updated', { request });
    io.to(`user-${request.customer_id}`).emit('requests-updated', { request });
    if (request.technician_id) io.to(`user-${request.technician_id}`).emit('requests-updated', { request });
    // جميع الفنيين يرون قائمة الطلبات الجديدة؛ عند قبول عرض يجب أن يصلهم الحدث
    // كي يختفي الطلب فوراً من القائمة ويتحدّث العداد بدون تحديث يدوي.
    io.to('technicians-room').emit('requests-updated', { request });
    io.to('admin-room').emit('requests-updated', { request });
    if (decision === 'accepted') {
      io.to(`user-${offer.technician_id}`).emit('offer-accepted', {
        requestId: offer.request_id,
        technicianId: offer.technician_id,
        offerId: offer.id,
        service: request.service
      });
      // Push Notification للفني خارج التطبيق
      const techUser = db.prepare('SELECT fcm_token, name FROM users WHERE id=?').get(offer.technician_id);
      if (techUser?.fcm_token) {
        sendPush(techUser.fcm_token,
          '🎉 تم قبول عرضك!',
          `العميل وافق على عرضك لخدمة ${request.service || ''} — افتح التطبيق للتواصل`,
          { type: 'offer_accepted', requestId: String(request.id) }
        );
      }
    }
    res.json({ request, offers });
  });

  // ── سحب العرض: الفني يسحب عرضه قبل قبول العميل ─────────────────
  router.delete('/offers/:id', auth, requireRole('technician'), (req, res) => {
    const offer = db.prepare('SELECT o.*, r.status request_status, r.technician_id request_tech FROM offers o JOIN requests r ON r.id=o.request_id WHERE o.id=?').get(req.params.id);
    if (!offer) return res.status(404).json({ error: 'العرض غير موجود' });
    if (offer.technician_id !== req.user.id) return res.status(403).json({ error: 'هذا العرض لا يخصك' });
    if (offer.status !== 'pending') return res.status(400).json({ error: 'لا يمكن سحب عرض تم قبوله أو رفضه' });
    if (offer.request_status !== 'بانتظار العروض' && offer.request_status !== 'وصلت عروض') {
      return res.status(400).json({ error: 'لا يمكن سحب العرض بعد اختيار الفني' });
    }
    db.prepare('DELETE FROM offers WHERE id=?').run(offer.id);
    // إعادة حالة الطلب إذا ما في عروض معلقة غيره
    const remaining = db.prepare("SELECT COUNT(*) c FROM offers WHERE request_id=? AND status='pending'").get(offer.request_id).c;
    db.prepare("UPDATE requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(remaining ? 'وصلت عروض' : 'بانتظار العروض', offer.request_id);
    const request = db.prepare('SELECT * FROM requests WHERE id=?').get(offer.request_id);
    // [SEC-FIX-03] Targeted emit for offer withdrawal
    safeEmit(offer.request_id, 'request-status-updated', { request });
    io.to(`user-${request.customer_id}`).emit('requests-updated', { request });
    io.to('admin-room').emit('requests-updated', { request });
    res.json({ ok: true, message: 'تم سحب العرض بنجاح' });
  });

  return router;
};
