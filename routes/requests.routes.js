// routes/requests.routes.js — /api/requests (create/list/delete/status/rate)
const express = require('express');

module.exports = function (deps) {
  const { db } = deps;
  const { io, safeEmit } = deps.realtime;
  const { auth, requireRole, upload } = deps.middleware;
  const { clean, calcRating } = deps.utils;
  const router = express.Router();

  router.post('/requests', auth, requireRole('customer'), upload.single('problem_image'), (req, res) => {
    const { service, city, area, description, preferred_time } = req.body;
    const lat = req.body.lat ? Number(req.body.lat) : null;
    const lng = req.body.lng ? Number(req.body.lng) : null;
    const requestedTechId = req.body.technician_id ? Number(req.body.technician_id) : null;
    const problemImage = req.file ? '/uploads/requests/' + req.file.filename : '';
    if (!clean(service) || !clean(city) || clean(description).length < 10) return res.status(400).json({ error: 'أكمل بيانات الطلب: الخدمة، المحافظة، ووصف لا يقل عن 10 أحرف' });
    if (clean(description).length > 1000) return res.status(400).json({ error: 'الوصف طويل جداً، الحد الأقصى 1000 حرف' });
    if (clean(service).length > 100) return res.status(400).json({ error: 'اسم الخدمة طويل جداً' });
    if (clean(city).length > 50) return res.status(400).json({ error: 'اسم المحافظة طويل جداً' });
    if (clean(area || '').length > 100) return res.status(400).json({ error: 'اسم المنطقة طويل جداً' });
    if (lat !== null && (isNaN(lat) || lat < -90 || lat > 90)) return res.status(400).json({ error: 'إحداثيات غير صحيحة' });
    if (lng !== null && (isNaN(lng) || lng < -180 || lng > 180)) return res.status(400).json({ error: 'إحداثيات غير صحيحة' });
    if (clean(preferred_time || '').length > 100) return res.status(400).json({ error: 'وقت التفضيل طويل جداً' });
    if (requestedTechId) {
      const tech = db.prepare("SELECT id FROM users WHERE id=? AND role='technician' AND is_active=1").get(requestedTechId);
      if (!tech) return res.status(400).json({ error: 'الفني غير متاح أو لم تتم موافقته من الإدارة' });
    }
    const info = db.prepare('INSERT INTO requests(customer_id,technician_id,service,city,area,lat,lng,description,preferred_time,problem_image_url,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(req.user.id, requestedTechId, clean(service), clean(city), clean(area), lat, lng, clean(description), clean(preferred_time), problemImage, 'بانتظار العروض');
    const request = db.prepare('SELECT * FROM requests WHERE id=?').get(info.lastInsertRowid);
    // [SEC-FIX-03] Targeted emit: only relevant users & admins
    safeEmit(request.id, 'request-status-updated', { request });
    // Notify the customer who created the request
    io.to(`user-${request.customer_id}`).emit('requests-updated', { request });
    // Notify all technicians about new available request (no sensitive customer data sent here)
    io.to('technicians-room').emit('new-request-created', { requestId: request.id, service: request.service, city: request.city, area: request.area, status: request.status });
    // Notify admins with full data
    io.to('admin-room').emit('requests-updated', { request });
    res.json({ request });
  });

  router.get('/requests', auth, (req, res) => {
    let rows;
    let total;
    if (req.user.role === 'admin') {
      const baseSql = 'SELECT r.*, c.name customer_name, t.name technician_name FROM requests r JOIN users c ON c.id=r.customer_id LEFT JOIN users t ON t.id=r.technician_id ORDER BY r.id DESC';

      if (req.query.page == null && req.query.limit == null) {
        // [FIX-09] السلوك الافتراضي القديم — بدون أي تغيير لو ما طُلبت صفحات
        rows = db.prepare(baseSql).all();
      } else {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const offset = (page - 1) * limit;
        total = db.prepare('SELECT COUNT(*) c FROM requests').get().c;
        rows = db.prepare(`${baseSql} LIMIT ? OFFSET ?`).all(limit, offset);
      }
    }
    else if (req.user.role === 'customer') rows = db.prepare('SELECT r.*, t.name technician_name FROM requests r LEFT JOIN users t ON t.id=r.technician_id WHERE customer_id=? ORDER BY r.id DESC').all(req.user.id);
    else rows = [];
    if (req.user.role === 'technician') {
      const me = db.prepare('SELECT services,city,areas FROM users WHERE id=?').get(req.user.id);
      const sv = (me.services || '').split(',').filter(Boolean);
      // [PERF-01] كانت هذه تجلب كل طلب على المنصة منذ إنشائها بلا أي WHERE/LIMIT
      // (db.prepare(...).all() بلا شرط)، ثم تُصفّي بجافاسكربت، ثم تُنفّذ استعلاماً
      // إضافياً منفصلاً *لكل صف مطابق* (N+1) لمعرفة عرض الفني الخاص. بما أن
      // better-sqlite3 متزامن بالكامل، هذا كان يوقف حلقة الحدث (event loop)
      // بأكملها — أي طلب آخر لأي مستخدم آخر — لمدة تتناسب طردياً مع إجمالي
      // عدد الطلبات على المنصة كاملة، بغض النظر عن مدى قلة الطلبات الفعلية
      // المطابقة لهذا الفني. الآن: التصفية والانضمام لعرض الفني كلاهما بجملة
      // SQL واحدة (WHERE + LEFT JOIN) بدل تحميل كل شيء وتصفيته لاحقاً.
      if (sv.length > 0) {
        const placeholders = sv.map(() => '?').join(',');
        rows = db.prepare(`
          SELECT r.*, c.name customer_name, o.id _myOfferId
          FROM requests r
          JOIN users c ON c.id = r.customer_id
          LEFT JOIN offers o ON o.request_id = r.id AND o.technician_id = ? AND o.status='pending'
          WHERE r.technician_id = ?
             OR (r.status IN ('بانتظار العروض','وصلت عروض') AND r.service IN (${placeholders})
                 AND (r.city = ? OR (? != '' AND instr(?, r.city) > 0) OR (r.area IS NOT NULL AND r.area != '' AND ? != '' AND instr(?, r.area) > 0)))
          ORDER BY r.id DESC
        `).all(req.user.id, req.user.id, ...sv, me.city, me.areas || '', me.areas || '', me.areas || '', me.areas || '');
      } else {
        rows = db.prepare(`
          SELECT r.*, c.name customer_name, o.id _myOfferId
          FROM requests r
          JOIN users c ON c.id = r.customer_id
          LEFT JOIN offers o ON o.request_id = r.id AND o.technician_id = ? AND o.status='pending'
          WHERE r.technician_id = ?
          ORDER BY r.id DESC
        `).all(req.user.id, req.user.id);
      }
      // LEFT JOIN يرجّع null صراحة لغياب العرض؛ السلوك القديم كان يحذف
      // المفتاح كلياً بهذه الحالة بدل تركه null — نحافظ على نفس شكل الرد.
      for (const r of rows) {
        if (r._myOfferId == null) delete r._myOfferId;
      }
    }
    res.json(total !== undefined ? { requests: rows, total } : { requests: rows });
  });

  router.delete('/requests/:id', auth, requireRole('customer'), (req, res) => {
    const r = db.prepare('SELECT * FROM requests WHERE id=? AND customer_id=?').get(req.params.id, req.user.id);
    if (!r) return res.status(404).json({ error: 'الطلب غير موجود' });
    if (['مكتمل'].includes(r.status)) return res.status(400).json({ error: 'لا يمكن حذف طلب مكتمل من السجل' });
    // منع إلغاء الطلب بعد أن يقبل العميل عرض فني وتبدأ الإدارة الفعلية للطلب،
    // لحماية الفني من إلغاء مفاجئ بعد أن يكون قد بدأ التنفيذ أو هو في الطريق.
    if (['تم اختيار عرض', 'قيد التنفيذ', 'بانتظار تأكيد الدفع'].includes(r.status)) {
      return res.status(400).json({ error: 'لا يمكن إلغاء الطلب بعد قبول عرض الفني. تواصل مع الدعم الفني إذا واجهت مشكلة.' });
    }
    db.prepare("UPDATE offers SET status='rejected', updated_at=CURRENT_TIMESTAMP WHERE request_id=? AND status='pending'").run(r.id);
    db.prepare("UPDATE requests SET status='ملغي', cancelled_by=?, cancelled_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.user.id, r.id);
    const request = db.prepare('SELECT * FROM requests WHERE id=?').get(r.id);
    // [SEC-FIX-03] Targeted emit
    safeEmit(r.id, 'request-status-updated', { request });
    io.to(`user-${request.customer_id}`).emit('requests-updated', { request });
    if (request.technician_id) io.to(`user-${request.technician_id}`).emit('requests-updated', { request });
    io.to('admin-room').emit('requests-updated', { request });
    res.json({ request });
  });

  router.post('/requests/:id/status', auth, (req, res) => {
    const r = db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'الطلب غير موجود' });
    const status = clean(req.body.status);
    const allowed = ['قيد التنفيذ', 'بانتظار تأكيد الدفع', 'مكتمل', 'ملغي'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'حالة غير صحيحة' });
    if (req.user.role !== 'admin' && req.user.id !== r.customer_id && req.user.id !== r.technician_id) return res.status(403).json({ error: 'لا تملك صلاحية' });
    // [SEC-FIX-16] طلب "مكتمل" أو "ملغي" حالة نهائية — بدون هذا الفحص، العميل
    // أو الفني صاحب الطلب كان يقدر "يحيي" طلباً قديماً منتهياً (مهما كان قديماً)
    // بإعادته لحالة "قيد التنفيذ"، وهذا كان يُفعّل بالخطأ قيد "طلب نشط واحد فقط"
    // بمسار العروض (routes/offers.routes.js) ويمنع الفني من قبول أي طلب جديد
    // تماماً، رغم إنه ما إله علاقة فعلية بأي عمل نشط حقيقي. القيمة نفسها (نداء
    // متكرر بنفس الحالة الحالية) تبقى مسموحة كعملية بلا أثر إضافي.
    if (['مكتمل', 'ملغي'].includes(r.status) && status !== r.status) {
      return res.status(409).json({ error: 'هذا الطلب مغلق أصلاً (مكتمل أو ملغي) ولا يمكن تعديل حالته' });
    }
    if (status === 'ملغي' && req.user.role !== 'admin' && req.user.id !== r.customer_id) return res.status(403).json({ error: 'إلغاء الطلب يكون من العميل أو الإدارة فقط' });
    if (status === 'ملغي' && req.user.role === 'customer' && ['تم اختيار عرض', 'قيد التنفيذ', 'بانتظار تأكيد الدفع'].includes(r.status)) {
      return res.status(400).json({ error: 'لا يمكن إلغاء الطلب بعد قبول عرض الفني. تواصل مع الدعم الفني إذا واجهت مشكلة.' });
    }
    if (status === 'مكتمل' && req.user.role !== 'admin' && req.user.id !== r.customer_id) return res.status(403).json({ error: 'إكمال الطلب يكون من العميل فقط' });
    if (status === 'مكتمل' && r.technician_id && r.commission_charged === null) {
      const doComplete = db.transaction(() => {
        const tech = db.prepare('SELECT * FROM users WHERE id=?').get(r.technician_id);
        const COMMISSION = Number(tech?.active_commission ?? 2);
        let charge = 0;
        if (tech.free_orders_used < 2) {
          db.prepare('UPDATE users SET free_orders_used=free_orders_used+1, completed_jobs=completed_jobs+1 WHERE id=?').run(tech.id);
          db.prepare('INSERT INTO ledger(user_id,type,amount,balance_after,note) VALUES(?,?,?,?,?)').run(tech.id, 'طلب مجاني', 0, tech.balance, 'تم احتساب الطلب ضمن أول طلبين مجانيين');
        } else {
          charge = COMMISSION;
          if (tech.balance < charge) throw Object.assign(new Error('رصيد الفني غير كافٍ لإكمال الطلب. يجب شحن الرصيد أولاً.'), { status: 400 });
          const after = Number((tech.balance - charge).toFixed(2));
          db.prepare('UPDATE users SET balance=?, completed_jobs=completed_jobs+1 WHERE id=?').run(after, tech.id);
          db.prepare('INSERT INTO ledger(user_id,type,amount,balance_after,note) VALUES(?,?,?,?,?)').run(tech.id, 'خصم عمولة طلب', -charge, after, `خصم عمولة الطلب رقم ${r.id}`);
        }
        db.prepare('UPDATE requests SET commission_charged=? WHERE id=?').run(charge, r.id);
      });
      try { doComplete(); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
    }
    db.prepare('UPDATE requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, r.id);
    const request = db.prepare('SELECT * FROM requests WHERE id=?').get(r.id);
    // [SEC-FIX-03] Targeted emit for status update
    safeEmit(r.id, 'request-status-updated', { request });
    io.to(`user-${request.customer_id}`).emit('requests-updated', { request });
    if (request.technician_id) io.to(`user-${request.technician_id}`).emit('requests-updated', { request });
    io.to('admin-room').emit('requests-updated', { request });
    res.json({ request });
  });

  router.post('/requests/:id/rate', auth, requireRole('customer'), (req, res) => {
    const r = db.prepare('SELECT * FROM requests WHERE id=? AND customer_id=? AND status=?').get(req.params.id, req.user.id, 'مكتمل');
    if (!r || !r.technician_id) return res.status(400).json({ error: 'لا يمكن تقييم هذا الطلب' });
    const stars = Number(req.body.stars); if (stars < 1 || stars > 5) return res.status(400).json({ error: 'اختر تقييم من 1 إلى 5' });
    const comment = clean(req.body.comment || '');
    if (comment.length > 500) return res.status(400).json({ error: 'التعليق طويل جداً، الحد الأقصى 500 حرف' });
    try { db.prepare('INSERT INTO ratings(request_id,technician_id,customer_id,stars,comment) VALUES(?,?,?,?,?)').run(r.id, r.technician_id, req.user.id, stars, comment); calcRating(r.technician_id); safeEmit(r.id, 'rated', { requestId: r.id, stars }); res.json({ ok: true }); }
    catch { res.status(409).json({ error: 'تم تقييم هذا الطلب مسبقاً' }); }
  });

  return router;
};
