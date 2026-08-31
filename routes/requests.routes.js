// routes/requests.routes.js — /api/requests (create/list/delete/status/rate)
const express = require('express');

module.exports = function (deps) {
  const { db } = deps;
  const { io, safeEmit } = deps.realtime;
  const { auth, requireRole, upload, verifyImageMagicBytes } = deps.middleware;
  const { clean, calcRating, notify, maskCoordsUnlessConfirmedTechnician } = deps.utils;
  const { sendPush } = deps.services;
  const { requestLimiter } = deps.limiters;
  const router = express.Router();

  // [NOTIF-PHASE2B-2] نفس جمهور بث 'new-request-created' بالضبط (technicians-room،
  // كل من role='technician' بلا أي تصفية خدمة/مدينة إضافية — التصفية الفعلية
  // تحدث فقط بطرف القراءة GET /requests، تماماً كما لا يوجد أي تصفية على
  // البث اللحظي نفسه اليوم).
  // [CRIT-FIX-01] استعلام واحد يُعاد استخدامه (مُجهَّز مرة واحدة عند إقلاع
  // السيرفر) بدل db.prepare جديد بكل نداء — نفس نمط insertStmt بـ
  // utils/notification.js. LIMIT 5000 سقف وقائي بحت مطابق تماماً لنفس نمط
  // PERF-HARDEN-01 المُستخدَم بكل أرجاء المشروع (GET /admin/users، GET
  // /requests...) — لا يوجد سيناريو واقعي حالي لهذا التطبيق فيه أكثر من 5000
  // فني مسجَّل، فهذا لا يغيّر أي سلوك فعلي اليوم، فقط يمنع نمواً غير محدود
  // مستقبلاً لنفس فئة المخاطرة المذكورة أدناه (CRIT-FIX-02).
  const technicianIdsStmt = db.prepare("SELECT id FROM users WHERE role='technician' LIMIT 5000");
  function getTechnicianIds() {
    return technicianIdsStmt.all().map(t => t.id);
  }

  // [CRIT-FIX-01] كل نداءات notify() لدفعة كاملة من المستلمين تُنفَّذ الآن
  // بمعاملة واحدة (db.transaction) بدل commit/fsync منفصل لكل صف — نفس
  // النمط المُستخدَم أصلاً بهذا المشروع لأي إدراج دفعي (مثال: doComplete
  // بـPOST /requests/:id/status أدناه). notify() نفسها (utils/notification.js)
  // تبتلع أي خطأ فردي داخلياً ولا ترمي أبداً، فسلوك "فشل إشعار واحد لا يُسقط
  // الباقي" يبقى كما هو تماماً حتى مع الدفعة الموحّدة.
  const notifyBatch = db.transaction((userIds, buildPayload) => {
    for (const userId of userIds) notify(buildPayload(userId));
  });

  // [SEC-FIX-REQSPAM-01] راجع DECISIONS.md وmiddleware/security.js —
  // requestLimiter قبل upload.single عمداً (فحص رخيص يوقف الطلب قبل إنفاق أي
  // جهد بتحليل جسم multipart)، بنفس ترتيب offerLimiter/messageLimiter بباقي
  // هذا المشروع.
  router.post('/requests', auth, requireRole('customer'), requestLimiter, upload.single('problem_image'), verifyImageMagicBytes, (req, res) => {
    const { service, city, area, description, preferred_time } = req.body;
    // [SEC-FIX-COORDZERO-01] راجع DECISIONS.md — `req.body.lat ? ... : null`
    // كانت تُسقط إحداثية 0 الشرعية (خط الاستواء/خط غرينتش) لأنها falsy بجافاسكربت
    // بالضبط كـundefined — فحص وجود صريح بدل الاعتماد على truthiness.
    const lat = (req.body.lat !== undefined && req.body.lat !== null && req.body.lat !== '') ? Number(req.body.lat) : null;
    const lng = (req.body.lng !== undefined && req.body.lng !== null && req.body.lng !== '') ? Number(req.body.lng) : null;
    const problemImage = req.file ? '/uploads/requests/' + req.file.filename : '';
    if (!clean(service) || !clean(city) || clean(description).length < 10) return res.status(400).json({ error: 'أكمل بيانات الطلب: الخدمة، المحافظة، ووصف لا يقل عن 10 أحرف', code: 'REQUEST_INVALID_FIELDS' });
    if (clean(description).length > 1000) return res.status(400).json({ error: 'الوصف طويل جداً، الحد الأقصى 1000 حرف', code: 'REQUEST_DESCRIPTION_TOO_LONG' });
    if (clean(service).length > 100) return res.status(400).json({ error: 'اسم الخدمة طويل جداً', code: 'REQUEST_SERVICE_TOO_LONG' });
    if (clean(city).length > 50) return res.status(400).json({ error: 'اسم المحافظة طويل جداً', code: 'REQUEST_CITY_TOO_LONG' });
    if (clean(area || '').length > 100) return res.status(400).json({ error: 'اسم المنطقة طويل جداً', code: 'REQUEST_AREA_TOO_LONG' });
    if (lat !== null && (isNaN(lat) || lat < -90 || lat > 90)) return res.status(400).json({ error: 'إحداثيات غير صحيحة', code: 'REQUEST_INVALID_COORDINATES' });
    if (lng !== null && (isNaN(lng) || lng < -180 || lng > 180)) return res.status(400).json({ error: 'إحداثيات غير صحيحة', code: 'REQUEST_INVALID_COORDINATES' });
    if (clean(preferred_time || '').length > 100) return res.status(400).json({ error: 'وقت التفضيل طويل جداً', code: 'REQUEST_PREFERRED_TIME_TOO_LONG' });
    // [FIX-DEADFIELD-02] راجع DECISIONS.md — إنشاء طلب موجَّه مباشرة لفني معيّن
    // (technician_id بجسم الطلب) أُزيل بالكامل: لا شاشة بالتطبيق تستخدمه، وكان
    // يبقى ميزة خاملة تفتح سطح هجوم بلا فائدة فعلية. technician_id بجدول
    // requests يبقى NULL دائماً عند الإنشاء، ولا يُضبَط إلا لاحقاً عند قبول عرض
    // فعلي (routes/offers.routes.js) — نفس آلية التعيين الوحيدة الشرعية اليوم.
    const info = db.prepare('INSERT INTO requests(customer_id,technician_id,service,city,area,lat,lng,description,preferred_time,problem_image_url,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(req.user.id, null, clean(service), clean(city), clean(area), lat, lng, clean(description), clean(preferred_time), problemImage, 'بانتظار العروض');
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

    // [CRIT-FIX-01] نسخة دائمة لكل الفنيين — لا تُبدّل ولا تُلغي بث
    // technicians-room أعلاه، فقط تضيف سجلاً يبقى حتى لو كان الفني غير متصل.
    // مؤجَّلة عمداً لِـ setImmediate (بعد إرسال res.json أعلاه) وليست جزءاً
    // من الاستجابة المتزامنة للعميل — كانت سابقاً حلقة db.prepare/insert
    // متزامنة (فني واحد = نداء واحد) تُنفَّذ *قبل* res.json، أي كل عميل ينشئ
    // طلباً كان يُحجَز فعلياً بمقدار زمن إدراج سجل واحد لكل فني مسجَّل على
    // المنصة بأكملها قبل أن يصله رده — بحلقة الحدث المتزامنة الوحيدة
    // لـ better-sqlite3، هذا كان يُجمّد أي طلب آخر من أي مستخدم آخر بالمنصة
    // بالتوازي (نفس فئة العلّة الموثَّقة بـ[PERF-01]/[PERF-HARDEN-01] أعلاه
    // بهذا الملف بالضبط، وسبق أن سببت حادثة أداء فعلية على الإنتاج — راجع
    // منطق middleware/perf-monitor.js). الآن: العميل يستلم رده فوراً بغض
    // النظر عن عدد الفنيين، والدفعة الكاملة تُنفَّذ بمعاملة واحدة (notifyBatch)
    // بجزء لاحق من حلقة الحدث. try/catch إلزامي هنا تحديداً (وليس اختيارياً)
    // — أي استثناء غير مُلتقَط داخل setImmediate لا تراه Express إطلاقاً
    // (خارج دورة الطلب/الرد كلياً)، فيصل مباشرة لمعالج process.on('uncaughtException')
    // بـserver.js الذي يُنفّذ إغلاقاً كاملاً وإعادة تشغيل للسيرفر — عطل واحد
    // بجلب قائمة الفنيين هنا كان سيعيد تشغيل السيرفر بأكمله، وهذا أسوأ بكثير
    // من العلّة الأصلية.
    setImmediate(() => {
      try {
        const technicianIds = getTechnicianIds();
        notifyBatch(technicianIds, (techId) => ({
          userId: techId,
          type: 'request',
          title: 'طلب جديد قريب منك',
          body: `${request.service} في ${request.city}`,
          data: { requestId: request.id },
          requestId: request.id
        }));
      } catch (e) {
        console.error('[CRIT-FIX-01] فشل بث إشعار الطلب الجديد للفنيين:', e.message);
      }
    });
  });

  router.get('/requests', auth, (req, res) => {
    let rows;
    let total;
    if (req.user.role === 'admin') {
      const baseSql = 'SELECT r.*, c.name customer_name, t.name technician_name FROM requests r JOIN users c ON c.id=r.customer_id LEFT JOIN users t ON t.id=r.technician_id ORDER BY r.id DESC';

      if (req.query.page == null && req.query.limit == null) {
        // [PERF-HARDEN-01] نفس سقف GET /admin/users الوقائي — راجع تعليقه.
        rows = db.prepare(`${baseSql} LIMIT 2000`).all();
      } else {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const offset = (page - 1) * limit;
        total = db.prepare('SELECT COUNT(*) c FROM requests').get().c;
        rows = db.prepare(`${baseSql} LIMIT ? OFFSET ?`).all(limit, offset);
      }
    }
    // [PERF-HARDEN-04] بلا سقف سابقاً — بعكس فرعَي الأدمن (أعلاه) والفني
    // (أسفل، LIMIT 1000) بنفس الدالة تحديداً، واللذين أُصلحا سابقاً لنفس
    // السبب. سجل طلبات العميل ينمو مع عمر الحساب وبلا حد، ويُطلَب بكل فتح
    // لشاشة "طلباتي". نفس سقف 1000 المستخدَم بفرع الفني (قائمة شخصية تنمو
    // مع الاستخدام)، وليس 2000 (مخصَّص لقوائم الأدمن الشاملة).
    else if (req.user.role === 'customer') rows = db.prepare('SELECT r.*, t.name technician_name FROM requests r LEFT JOIN users t ON t.id=r.technician_id WHERE customer_id=? ORDER BY r.id DESC LIMIT 1000').all(req.user.id);
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
      // [PERF-HARDEN-01] فرع r.technician_id=? هنا يشمل كل طلبات الفني بأي
      // حالة (بلا قيد على status)، فينمو بلا حدود مع طول عمر الحساب. سقف 1000
      // وقائي بحت — ORDER BY r.id DESC يضمن بقاء الأحدث (وأي عمل نشط حالياً
      // منطقياً حديث العمر) دائماً ضمن النطاق المُرجَع.
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
          LIMIT 1000
        `).all(req.user.id, req.user.id, ...sv, me.city, me.areas || '', me.areas || '', me.areas || '', me.areas || '');
      } else {
        rows = db.prepare(`
          SELECT r.*, c.name customer_name, o.id _myOfferId
          FROM requests r
          JOIN users c ON c.id = r.customer_id
          LEFT JOIN offers o ON o.request_id = r.id AND o.technician_id = ? AND o.status='pending'
          WHERE r.technician_id = ?
          ORDER BY r.id DESC
          LIMIT 1000
        `).all(req.user.id, req.user.id);
      }
      // LEFT JOIN يرجّع null صراحة لغياب العرض؛ السلوك القديم كان يحذف
      // المفتاح كلياً بهذه الحالة بدل تركه null — نحافظ على نفس شكل الرد.
      // [SEC-FIX-COORDMASK-01] راجع DECISIONS.md — الشرط WHERE أعلاه يجمع
      // فرعين مختلفين تماماً بنفس النتيجة: طلبات الفني المؤكَّد (r.technician_id
      // = معرّفه، يستحق الإحداثيات الكاملة) وطلبات يتصفّحها فقط أو قدّم عرضاً
      // معلَّقاً عليها (r.status ضمن الحالتين المفتوحتين، لا يستحق الإحداثيات
      // الدقيقة بعد) — maskCoordsUnlessConfirmedTechnician تفرّق بينهما لكل صف.
      rows = rows.map(r => {
        if (r._myOfferId == null) delete r._myOfferId;
        return maskCoordsUnlessConfirmedTechnician(r, req.user.id);
      });
    }
    res.json(total !== undefined ? { requests: rows, total } : { requests: rows });
  });

  router.delete('/requests/:id', auth, requireRole('customer'), (req, res) => {
    const r = db.prepare('SELECT * FROM requests WHERE id=? AND customer_id=?').get(req.params.id, req.user.id);
    if (!r) return res.status(404).json({ error: 'الطلب غير موجود', code: 'REQUEST_NOT_FOUND' });
    if (['مكتمل'].includes(r.status)) return res.status(400).json({ error: 'لا يمكن حذف طلب مكتمل من السجل', code: 'REQUEST_CANNOT_DELETE_COMPLETED' });
    // منع إلغاء الطلب بعد أن يقبل العميل عرض فني وتبدأ الإدارة الفعلية للطلب،
    // لحماية الفني من إلغاء مفاجئ بعد أن يكون قد بدأ التنفيذ أو هو في الطريق.
    if (['تم اختيار عرض', 'قيد التنفيذ', 'بانتظار تأكيد الدفع'].includes(r.status)) {
      return res.status(400).json({ error: 'لا يمكن إلغاء الطلب بعد قبول عرض الفني. تواصل مع الدعم الفني إذا واجهت مشكلة.', code: 'REQUEST_CANNOT_CANCEL_AFTER_OFFER_ACCEPTED' });
    }
    // [DATA-INTEGRITY-04] راجع DECISIONS.md — نفس نمط applyRejection/applyAcceptance
    // بـoffers.routes.js: رفض العروض المعلَّقة وتحديث حالة الطلب الآن معاملة
    // واحدة، لا كتابتان منفصلتان.
    const doCancel = db.transaction(() => {
      db.prepare("UPDATE offers SET status='rejected', updated_at=CURRENT_TIMESTAMP WHERE request_id=? AND status='pending'").run(r.id);
      db.prepare("UPDATE requests SET status='ملغي', cancelled_by=?, cancelled_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.user.id, r.id);
    });
    doCancel();
    const request = db.prepare('SELECT * FROM requests WHERE id=?').get(r.id);
    // [SEC-FIX-03] Targeted emit
    safeEmit(r.id, 'request-status-updated', { request });
    io.to(`user-${request.customer_id}`).emit('requests-updated', { request });
    if (request.technician_id) io.to(`user-${request.technician_id}`).emit('requests-updated', { request });
    io.to('admin-room').emit('requests-updated', { request });

    // [NOTIF-PHASE2B-2] نسخة دائمة للفني فقط — العميل هو من نفّذ الإلغاء
    // (لا داعي لإشعاره بفعله هو نفسه)، أما الفني (إن وُجد) فهذا خبر جديد له.
    if (request.technician_id) {
      // [FIX-NOTIF-GAP-01] كان بلا Push إطلاقاً — فقط لحظي + دائم.
      const tech = db.prepare('SELECT fcm_token FROM users WHERE id=?').get(request.technician_id);
      if (tech?.fcm_token) {
        sendPush(tech.fcm_token,
          '📋 تحديث على الطلب',
          `تم إلغاء طلب ${request.service || ''} من قبل العميل`,
          { type: 'request', requestId: String(request.id) }
        );
      }
      notify({
        userId: request.technician_id,
        type: 'request',
        title: 'تحديث على الطلب',
        body: 'حالة الطلب أصبحت: ' + request.status,
        data: { requestId: request.id },
        requestId: request.id
      });
    }

    res.json({ request });
  });

  router.post('/requests/:id/status', auth, (req, res) => {
    const r = db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'الطلب غير موجود', code: 'REQUEST_NOT_FOUND' });
    const status = clean(req.body.status);
    const allowed = ['قيد التنفيذ', 'بانتظار تأكيد الدفع', 'مكتمل', 'ملغي'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'حالة غير صحيحة', code: 'STATUS_INVALID' });
    if (req.user.role !== 'admin' && req.user.id !== r.customer_id && req.user.id !== r.technician_id) return res.status(403).json({ error: 'لا تملك صلاحية', code: 'AUTH_FORBIDDEN' });
    // [SEC-FIX-16] طلب "مكتمل" أو "ملغي" حالة نهائية — بدون هذا الفحص، العميل
    // أو الفني صاحب الطلب كان يقدر "يحيي" طلباً قديماً منتهياً (مهما كان قديماً)
    // بإعادته لحالة "قيد التنفيذ"، وهذا كان يُفعّل بالخطأ قيد "طلب نشط واحد فقط"
    // بمسار العروض (routes/offers.routes.js) ويمنع الفني من قبول أي طلب جديد
    // تماماً، رغم إنه ما إله علاقة فعلية بأي عمل نشط حقيقي. القيمة نفسها (نداء
    // متكرر بنفس الحالة الحالية) تبقى مسموحة كعملية بلا أثر إضافي.
    if (['مكتمل', 'ملغي'].includes(r.status) && status !== r.status) {
      return res.status(409).json({ error: 'هذا الطلب مغلق أصلاً (مكتمل أو ملغي) ولا يمكن تعديل حالته', code: 'REQUEST_ALREADY_CLOSED' });
    }
    // [SEC-FIX-STATUSFLOW-01] راجع DECISIONS.md — قبل هذا الفحص، لم يكن هناك
    // أي تحقق من أن الحالة الحالية تسمح فعلياً بالانتقال للحالة المطلوبة (فقط
    // فحص "ليست مغلقة أصلاً" أعلاه). هذا كان يسمح للعميل بإكمال طلب لم يقبل
    // به أي فني إطلاقاً — راجع الاستقصاء الكامل بـDECISIONS.md لتفاصيل
    // السيناريو الفعلي المُتحقَّق منه. القاعدة الأمنية الجوهرية: أي انتقال
    // للحالات الثلاث أدناه يتطلّب أن يكون الطلب قد مرّ فعلاً بقبول عرض فني حقيقي
    // أولاً (r.status='تم اختيار عرض' هي الحالة الوحيدة التي يكتبها
    // routes/offers.routes.js عند قبول عرض فعلي — لا مسار آخر يصلها). الحالات
    // الثلاث الحالية جميعها (تم اختيار عرض، قيد التنفيذ، بانتظار تأكيد الدفع)
    // تُعتبَر "فني وافق فعلاً" وتبقى محتملة انتقالاً لبعضها بأي ترتيب (يطابق
    // tests/db-integrity.spec.js الذي يُكمل الطلب مباشرة من "تم اختيار عرض"
    // بلا مرور بـ"قيد التنفيذ"، وtechnician_request_details_screen.dart الذي
    // يُظهر زرَي "بدء العمل" و"بانتظار تأكيد الدفع" معاً بمجرد تعيين الفني).
    // ملغي مستثناة عمداً من هذه الخريطة — فحوصها الخاصة (أسفل هذا الفحص) كانت
    // صحيحة أصلاً ولم تتغيّر.
    const LEGAL_PREDECESSORS = {
      'قيد التنفيذ': ['تم اختيار عرض', 'قيد التنفيذ', 'بانتظار تأكيد الدفع'],
      'بانتظار تأكيد الدفع': ['تم اختيار عرض', 'قيد التنفيذ', 'بانتظار تأكيد الدفع'],
      'مكتمل': ['تم اختيار عرض', 'قيد التنفيذ', 'بانتظار تأكيد الدفع']
    };
    if (LEGAL_PREDECESSORS[status] && !LEGAL_PREDECESSORS[status].includes(r.status)) {
      return res.status(409).json({
        error: `لا يمكن الانتقال لحالة "${status}" من الحالة الحالية "${r.status}" — يجب أن يمر الطلب بمراحله الطبيعية أولاً (قبول عرض فني فعلي).`,
        code: 'STATUS_TRANSITION_INVALID'
      });
    }
    if (status === 'ملغي' && req.user.role !== 'admin' && req.user.id !== r.customer_id) return res.status(403).json({ error: 'إلغاء الطلب يكون من العميل أو الإدارة فقط', code: 'REQUEST_CANCEL_FORBIDDEN' });
    if (status === 'ملغي' && req.user.role === 'customer' && ['تم اختيار عرض', 'قيد التنفيذ', 'بانتظار تأكيد الدفع'].includes(r.status)) {
      return res.status(400).json({ error: 'لا يمكن إلغاء الطلب بعد قبول عرض الفني. تواصل مع الدعم الفني إذا واجهت مشكلة.', code: 'REQUEST_CANNOT_CANCEL_AFTER_OFFER_ACCEPTED' });
    }
    if (status === 'مكتمل' && req.user.role !== 'admin' && req.user.id !== r.customer_id) return res.status(403).json({ error: 'إكمال الطلب يكون من العميل فقط', code: 'REQUEST_COMPLETE_CUSTOMER_ONLY' });
    if (status === 'مكتمل' && r.technician_id && r.commission_charged === null) {
      let charged = 0;
      const doComplete = db.transaction(() => {
        const tech = db.prepare('SELECT * FROM users WHERE id=?').get(r.technician_id);
        const COMMISSION = Number(tech?.active_commission ?? 2);
        let charge = 0;
        if (tech.free_orders_used < 2) {
          db.prepare('UPDATE users SET free_orders_used=free_orders_used+1, completed_jobs=completed_jobs+1 WHERE id=?').run(tech.id);
          // [FEAT-REFUND-01] راجع DECISIONS.md — request_id يُمرَّر مباشرة من
          // الكود، لا يُستنتَج لاحقاً من نص note (لا يحمله note هذا النوع أصلاً).
          db.prepare('INSERT INTO ledger(user_id,type,amount,balance_after,note,request_id) VALUES(?,?,?,?,?,?)').run(tech.id, 'طلب مجاني', 0, tech.balance, 'تم احتساب الطلب ضمن أول طلبين مجانيين', r.id);
        } else {
          charge = COMMISSION;
          if (tech.balance < charge) throw Object.assign(new Error('رصيد الفني غير كافٍ لإكمال الطلب. يجب شحن الرصيد أولاً.'), { status: 400, code: 'TECHNICIAN_BALANCE_INSUFFICIENT' });
          const after = Number((tech.balance - charge).toFixed(2));
          db.prepare('UPDATE users SET balance=?, completed_jobs=completed_jobs+1 WHERE id=?').run(after, tech.id);
          // [FEAT-REFUND-01] راجع DECISIONS.md — request_id مباشرة من الكود
          // أيضاً هنا (كان سابقاً مُستخرَجاً فقط من نص note بالترحيل التاريخي).
          db.prepare('INSERT INTO ledger(user_id,type,amount,balance_after,note,request_id) VALUES(?,?,?,?,?,?)').run(tech.id, 'خصم عمولة طلب', -charge, after, `خصم عمولة الطلب رقم ${r.id}`, r.id);
        }
        db.prepare('UPDATE requests SET commission_charged=? WHERE id=?').run(charge, r.id);
        charged = charge;
      });
      try { doComplete(); } catch (e) { return res.status(e.status || 500).json({ error: e.message, code: e.code }); }

      // [FIX-WALLETDEDUCT-01] كان الخصم يحدث فعلياً بقاعدة البيانات (مؤكَّد
      // باختبار tests/db-integrity.spec.js) لكن بلا أي حدث لحظي على الإطلاق —
      // الفني كان يرى رصيده القديم بشاشة المحفظة حتى يعيد فتح التطبيق يدوياً،
      // فيبدو الأمر وكأن الخصم لم يحدث إطلاقاً. نفس شكل الحدث المُستخدَم أصلاً
      // عند الموافقة على شحن الرصيد (routes/topups.routes.js).
      const updatedTech = db.prepare('SELECT balance, active_commission FROM users WHERE id=?').get(r.technician_id);
      io.to(`user-${r.technician_id}`).emit('balance-updated', {
        balance: updatedTech?.balance ?? 0,
        active_commission: updatedTech?.active_commission ?? 2,
        requestId: r.id,
        status: charged > 0 ? 'commission-charged' : 'free-order'
      });
      if (charged > 0) {
        notify({
          userId: r.technician_id,
          type: 'wallet',
          title: 'تم خصم عمولة الطلب',
          body: `تم خصم ${charged} د.أ من رصيدك بعد اكتمال الطلب رقم ${r.id}`,
          data: { requestId: r.id }
        });
      }

      // [FIX-RATEPROMPT-01] كان العميل (وهو غالباً من يُنهي الطلب بنفسه عبر
      // زر "إنهاء الطلب") مستثنى من حلقة إشعار تغيّر الحالة العامة أدناه
      // (تستثني منفّذ العملية نفسه) — فلا يصله أي إشعار يدعوه لتقييم الفني
      // إطلاقاً رغم أن هذا بالضبط اللحظة الصحيحة لطلب التقييم. زر "قيّم الفني"
      // موجود أصلاً بشاشة تفاصيل الطلب فور اكتمالها (customer_request_details_screen)
      // — هذا فقط يضمن وصول دعوة فعلية له بدل انتظار عودته يدوياً للطلب.
      // بث لحظي إضافي (بعكس sendPush/notify أدناه) — يعكس فوراً بجرس الإشعارات
      // إن كان تطبيق العميل مفتوحاً هذه اللحظة بالذات، دون انتظار أي تحديث دوري.
      io.to(`user-${r.customer_id}`).emit('rate-request-prompt', { requestId: r.id, service: r.service });

      const customerForRating = db.prepare('SELECT fcm_token FROM users WHERE id=?').get(r.customer_id);
      if (customerForRating?.fcm_token) {
        sendPush(customerForRating.fcm_token,
          '⭐ قيّم تجربتك',
          `اكتمل طلب ${r.service} — شاركنا رأيك بتقييم الفني`,
          { type: 'rate_request', requestId: String(r.id) }
        );
      }
      notify({
        userId: r.customer_id,
        type: 'rate_request',
        title: 'قيّم تجربتك',
        body: `اكتمل طلب ${r.service} — شاركنا رأيك بتقييم الفني`,
        data: { requestId: r.id },
        requestId: r.id
      });
    }
    if (status === 'ملغي') {
      // [SEC-FIX-CANCELREVIVE-01] راجع DECISIONS.md — هذا المسار (على عكس
      // DELETE /requests/:id وPOST /admin/requests/:id/cancel) كان يُلغي
      // الطلب بلا رفض العروض المعلَّقة عليه ولا تسجيل من ألغاه ومتى، فيبقى
      // عرض 'pending' قابلاً للقبول لاحقاً على طلب "ملغي" (يُعالَج الآن أيضاً
      // بفحص مستقل بـPOST /offers/:id/decision، لكن هذا يمنع الحالة الشاذة
      // من الحدوث أصلاً بدل الاعتماد فقط على فحص لاحق).
      // [DATA-INTEGRITY-04] راجع DECISIONS.md — نفس نمط applyRejection/applyAcceptance
      // بـoffers.routes.js: معاملة واحدة، لا كتابتان منفصلتان.
      const doCancel = db.transaction(() => {
        db.prepare("UPDATE offers SET status='rejected', updated_at=CURRENT_TIMESTAMP WHERE request_id=? AND status='pending'").run(r.id);
        db.prepare("UPDATE requests SET status=?, cancelled_by=?, cancelled_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(status, req.user.id, r.id);
      });
      doCancel();
    } else {
      db.prepare('UPDATE requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, r.id);
    }
    const request = db.prepare('SELECT * FROM requests WHERE id=?').get(r.id);
    // [SEC-FIX-03] Targeted emit for status update
    safeEmit(r.id, 'request-status-updated', { request });
    io.to(`user-${request.customer_id}`).emit('requests-updated', { request });
    if (request.technician_id) io.to(`user-${request.technician_id}`).emit('requests-updated', { request });
    io.to('admin-room').emit('requests-updated', { request });

    // [NOTIF-PHASE2B-2] نسخة دائمة — للطرف (العميل و/أو الفني) الذي لم يكن
    // هو من نفّذ هذا التغيير فعلياً (قد يكون الأدمن هو المنفّذ، فيُشعَر كلاهما).
    // [FIX-NOTIF-GAP-01] وأُضيف هنا أيضاً Push حقيقي — كان هذا الحدث بلا Push
    // إطلاقاً رغم كونه من أكثر الأحداث تكراراً (كل انتقال حالة طلب).
    const notifyTargets = [request.customer_id, request.technician_id]
      .filter(uid => uid && uid !== req.user.id);
    notifyTargets.forEach(uid => {
      const target = db.prepare('SELECT fcm_token FROM users WHERE id=?').get(uid);
      if (target?.fcm_token) {
        sendPush(target.fcm_token,
          '📋 تحديث على الطلب',
          `حالة طلب ${request.service || ''} أصبحت: ${status}`,
          { type: 'request', requestId: String(request.id) }
        );
      }
      notify({
        userId: uid,
        type: 'request',
        title: 'تحديث على الطلب',
        body: 'حالة الطلب أصبحت: ' + status,
        data: { requestId: request.id },
        requestId: request.id
      });
    });

    res.json({ request });
  });

  router.post('/requests/:id/rate', auth, requireRole('customer'), (req, res) => {
    const r = db.prepare('SELECT * FROM requests WHERE id=? AND customer_id=? AND status=?').get(req.params.id, req.user.id, 'مكتمل');
    if (!r || !r.technician_id) return res.status(400).json({ error: 'لا يمكن تقييم هذا الطلب', code: 'RATING_NOT_ALLOWED' });
    // [SEC-FIX-20] Number(x) لقيمة مفقودة/غير رقمية تُنتج NaN، والمقارنات
    // stars < 1 / stars > 5 كلتاهما false مع NaN بجافاسكربت — يتجاوز هذا
    // التحقق بصمت ويصل الإدراج لقاعدة البيانات، حيث يرفضه قيد CHECK فعلاً
    // (لا يحدث أي تلف بيانات)، لكن catch العام أسفل هذا الراوت يُرجع خطأ
    // "تم تقييم هذا الطلب مسبقاً" لأي فشل إدراج — رسالة خاطئة تماماً لهذه
    // الحالة (لم يُسجَّل أي تقييم أصلاً). Number.isFinite يرفض NaN صراحة قبل
    // وصول القيمة لقاعدة البيانات، فيُرجع رسالة "تقييم غير صحيح" الصحيحة.
    const stars = Number(req.body.stars);
    if (!Number.isFinite(stars) || stars < 1 || stars > 5) return res.status(400).json({ error: 'اختر تقييم من 1 إلى 5', code: 'RATING_STARS_INVALID' });
    const comment = clean(req.body.comment || '');
    if (comment.length > 500) return res.status(400).json({ error: 'التعليق طويل جداً، الحد الأقصى 500 حرف', code: 'RATING_COMMENT_TOO_LONG' });
    try {
      db.prepare('INSERT INTO ratings(request_id,technician_id,customer_id,stars,comment) VALUES(?,?,?,?,?)').run(r.id, r.technician_id, req.user.id, stars, comment);
      calcRating(r.technician_id);
      safeEmit(r.id, 'rated', { requestId: r.id, stars });
      // [FIX-RATINGLIVE-01] safeEmit أعلاه يبثّ فقط لغرفة هذا الطلب تحديداً
      // (المشتركين فيها فعلياً هذه اللحظة) — الفني نادراً ما يكون منضمّاً لغرفة
      // طلب أُغلق للتو، فكان متوسط تقييمه وعدد تقييماته لا يتحدّثان بواجهته
      // إلا بعد إعادة تشغيل التطبيق (حيث يُعاد جلب /me من الصفر). بث إضافي
      // لغرفة الفني الشخصية (نفس نمط user-${id} المُستخدَم بكل أرجاء المشروع).
      const updatedTech = db.prepare('SELECT rating_avg, rating_count FROM users WHERE id=?').get(r.technician_id);
      io.to(`user-${r.technician_id}`).emit('rating-updated', {
        technicianId: r.technician_id,
        ratingAvg: updatedTech?.rating_avg ?? 0,
        ratingCount: updatedTech?.rating_count ?? 0
      });
      res.json({ ok: true });
    }
    catch { res.status(409).json({ error: 'تم تقييم هذا الطلب مسبقاً', code: 'RATING_ALREADY_EXISTS' }); }
  });

  return router;
};
