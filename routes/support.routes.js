// routes/support.routes.js — /api/support*, /api/fcm-token, /api/complaints
const express = require('express');

module.exports = function (deps) {
  const { db } = deps;
  const { io } = deps.realtime;
  const { auth, requireRole } = deps.middleware;
  const { clean, notify } = deps.utils;
  const { sendPush } = deps.services;
  const { supportLimiter } = deps.limiters;
  const router = express.Router();

  // [NOTIF-PHASE2B-1] نسخة دائمة (جدول notifications) لكل الأدمنية — مستقلة
  // تماماً عن fcm_token (بعكس استعلامات sendPush بهذا الملف)، لأن الهدف هنا
  // سجل يظهر لاحقاً حتى لو لم يكن للأدمن توكن Push أو كان socket مقطوعاً وقتها.
  function getAdminIds() {
    return db.prepare("SELECT id FROM users WHERE role='admin'").all().map(a => a.id);
  }

  // [SEC-FIX-SUPPORTSPAM-01] راجع DECISIONS.md — أول نقطة إنشاء بهذا الملف
  // بلا أي حد طلبات سابقاً، رغم أن كل نداء ناجح ينبّه كل الأدمنية.
  router.post('/support', auth, supportLimiter, (req, res) => {
    const { type, title, body } = req.body || {};
    if (clean(title).length < 3 || clean(body).length < 10 || clean(title).length > 120 || clean(body).length > 2000) return res.status(400).json({ error: 'اكتب عنوان وتفاصيل واضحة للدعم', code: 'SUPPORT_INVALID_FIELDS' });
    const allowedTypes = [
      'مشكلة طلب',
      'مشكلة حساب',
      'مشكلة دفع أو رصيد',
      'مشكلة في الموقع',
      'اقتراح تحسين',
      'عام',
      'شكوى',
      'استفسار',
      'اقتراح'
    ];
    const ticketType = clean(type || 'عام');
    if (!allowedTypes.includes(ticketType)) {
      return res.status(400).json({ error: 'نوع التذكرة غير صحيح: ' + ticketType, code: 'SUPPORT_INVALID_TYPE', params: { ticketType } });
    }
    // [FIX-06] السماح بتذكرة واحدة مفتوحة فقط لكل مستخدم
    const openTicket = db.prepare("SELECT id FROM support_tickets WHERE user_id=? AND status='open' LIMIT 1").get(req.user.id);
    if (openTicket) {
      return res.status(409).json({ error: 'لديك تذكرة دعم مفتوحة بالفعل. انتظر رد الإدارة أو أكمل المحادثة الحالية.', code: 'SUPPORT_TICKET_ALREADY_OPEN' });
    }
    const info = db.prepare('INSERT INTO support_tickets(user_id,type,title,body) VALUES(?,?,?,?)')
      .run(req.user.id, ticketType, clean(title), clean(body));

    const ticket = db.prepare('SELECT * FROM support_tickets WHERE id=?').get(info.lastInsertRowid);

    // [SEC-FIX-03] Support ticket notifications only to admin + ticket owner
    io.to('admin-room').emit('support-created', { ticket });
    io.to(`user-${req.user.id}`).emit('support-created', { ticket });

    // [FIX-SUPPORT-PUSH-01] الحدث أعلاه realtime فقط عبر socket.io، وNOTIF-
    // PHASE2B-1 أدناه تخزين دائم فقط (لا يبعث Push حقيقياً — راجع تعليق
    // utils/notification.js) — كلاهما لا يصل للأدمن إن كان offline/socket
    // مقطوعاً وقتها وبلا فتح التطبيق لاحقاً. نفس الفجوة كانت موجودة هنا فقط،
    // بينما /complaints و/support/:id/messages ترسلان Push فعلياً لهذا السبب.
    const admins = db.prepare("SELECT fcm_token FROM users WHERE role='admin' AND fcm_token IS NOT NULL").all();
    admins.forEach(a => sendPush(a.fcm_token,
      '📋 تذكرة دعم جديدة',
      `${req.user.name || ''}: ${clean(title)}`,
      { type: 'support', ticketId: String(ticket.id) }
    ));

    // [NOTIF-PHASE2B-1] نسخة دائمة لكل الأدمنية — لا تُبدّل ولا تُلغي البث
    // اللحظي أعلاه، فقط تضيف سجلاً يبقى حتى لو كان الأدمن غير متصل وقتها.
    getAdminIds().forEach(adminId => notify({
      userId: adminId,
      type: 'support',
      title: 'تذكرة دعم جديدة',
      body: `${req.user.name || 'مستخدم'} فتح تذكرة دعم: ${ticket.title}`,
      data: { ticketId: ticket.id },
      ticketId: ticket.id
    }));

    res.json({ ticket });
  });

  // [PERF-HARDEN-01] بلا سقف سابقاً — نفس المخاطرة المُثبتة بـGET /admin/users
  // (استعلام متزامن يحجز عملية Node بأكملها لمدة تتناسب مع حجم الجدول). 1000
  // سقف وقائي، ليس له أي أثر على أي استخدام حالي واقعي لهذا التطبيق.
  router.get('/support', auth, requireRole('admin'), (req, res) => {
    res.json({ tickets: db.prepare(`SELECT t.*,u.name user_name,u.role user_role,u.email FROM support_tickets t LEFT JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT 1000`).all() });
  });

  router.post('/support/:id/status', auth, requireRole('admin'), (req, res) => {
    const status = clean(req.body.status || 'open');
    if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'حالة الدعم غير صحيحة', code: 'SUPPORT_STATUS_INVALID' });
    db.prepare('UPDATE support_tickets SET status=? WHERE id=?').run(status, req.params.id);
    const ticket = db.prepare('SELECT * FROM support_tickets WHERE id=?').get(req.params.id);
    // [REALTIME] أبلغ صاحب التذكرة فوراً بتغيّر الحالة (لإظهار/إخفاء اختصار الدعم).
    if (ticket) {
      io.to(`user-${ticket.user_id}`).emit('support-status-updated', { ticket });
      io.to(`user-${ticket.user_id}`).emit('support-message-refresh', { ticketId: ticket.id });
      io.to('admin-room').emit('support-message-refresh', { ticketId: ticket.id });
    }
    res.json({ ticket });
  });

  // ── FCM Token: يحفظ token الجهاز لإرسال إشعارات خارجية ──
  router.post('/fcm-token', auth, (req, res) => {
    const { token } = req.body;
    if (!token || typeof token !== 'string') return res.status(400).json({ error: 'token مطلوب', code: 'FCM_TOKEN_REQUIRED' });
    db.prepare('UPDATE users SET fcm_token=? WHERE id=?').run(token, req.user.id);
    res.json({ ok: true });
  });

  // ── شكاوى العملاء — للأدمن فقط ──
  // [FIX-07] الجدول الحقيقي بقاعدة البيانات أعمدته: user_id, subject(NOT NULL), body(NOT NULL), status
  // (وليس customer_id/technician_id كما كان الكود يفترض خطأً — كان هذا يسبب فشل 500 على كل شكوى).
  // [SEC-FIX-SUPPORTSPAM-01] راجع DECISIONS.md.
  router.post('/complaints', auth, requireRole('customer'), supportLimiter, (req, res) => {
    // [SEC-FIX-SOCKETCRASH-01] راجع DECISIONS.md — request_id كان يصل خاماً
    // من req.body (راوت JSON عادي، بلا multer إطلاقاً) بلا أي تحويل نوع.
    // مصفوفة/كائن كـrequest_id يجعل better-sqlite3 يرمي RangeError متزامناً
    // عند تمريره لـ.get() أدناه — بلا try/catch هنا، يصل كخطأ 400 غير نظيف
    // بدل تجاهله بهدوء كـ"لا يوجد request_id صالح" (نفس سلوك القيمة الفارغة).
    // فحص typeof صريح قبل parseInt — راجع نفس التعليق بـtopups.routes.js:
    // parseInt(['1','2']) يقرأ الرقم البادئ من نص المصفوفة ("1,2") بدل NaN،
    // فيقبل بصمت معرّف طلب قد لا علاقة له بالمقصود إطلاقاً.
    const rawRequestId = req.body.request_id;
    const requestId = (typeof rawRequestId === 'string' || typeof rawRequestId === 'number') ? parseInt(rawRequestId, 10) : NaN;
    const validRequestId = (requestId && !isNaN(requestId)) ? requestId : null;
    const body = clean(req.body.body || '');
    if (body.length < 1) return res.status(400).json({ error: 'الشكوى فارغة', code: 'COMPLAINT_EMPTY' });
    if (body.length > 1000) return res.status(400).json({ error: 'الشكوى طويلة جداً، الحد الأقصى 1000 حرف', code: 'COMPLAINT_TOO_LONG' });

    // تحقق أن الطلب فعلاً يخص هذا العميل (إن أُرسل request_id)
    const request = validRequestId
      ? db.prepare('SELECT id, service, technician_id FROM requests WHERE id=? AND customer_id=?').get(validRequestId, req.user.id)
      : null;

    const subject = request ? `شكوى على طلب: ${request.service}` : 'شكوى عامة';

    const info = db.prepare('INSERT INTO complaints (user_id, request_id, subject, body) VALUES (?,?,?,?)')
      .run(req.user.id, validRequestId, subject, body);
    const complaint = db.prepare('SELECT * FROM complaints WHERE id=?').get(info.lastInsertRowid);

    // إشعار للأدمن
    io.to('admin-room').emit('new-complaint', { complaint });
    // Push للأدمن
    const admins = db.prepare("SELECT fcm_token FROM users WHERE role='admin' AND fcm_token IS NOT NULL").all();
    admins.forEach(a => sendPush(a.fcm_token, '⚠️ شكوى جديدة', `العميل ${req.user.name || ''} قدّم شكوى على طلب #${validRequestId || ''}`, { type: 'complaint' }));

    // [NOTIF-PHASE2B-1] نسخة دائمة لكل الأدمنية. complaints ليس له عمود مخصّص
    // بجدول notifications (بعكس request_id/ticket_id) — complaintId يُحفظ
    // ضمن data فقط، كما هو مطلوب.
    getAdminIds().forEach(adminId => notify({
      userId: adminId,
      type: 'complaint',
      title: 'شكوى جديدة',
      body: `العميل ${req.user.name || ''} قدّم شكوى${request ? ` على طلب #${request.id}` : ''}`,
      data: { complaintId: complaint.id }
    }));

    res.json({ ok: true, complaint });
  });

  // [PERF-HARDEN-01] بلا سقف سابقاً — نفس المخاطرة المُثبتة بـGET /admin/users.
  router.get('/complaints', auth, requireRole('admin'), (req, res) => {
    // technician_id مش عمود موجود بجدول complaints — نجيبه عبر الربط مع جدول requests بدلاً منه.
    const complaints = db.prepare(`
      SELECT c.*,
        cu.name as customer_name, cu.phone as customer_phone,
        r.technician_id as technician_id,
        t.name as technician_name, t.phone as technician_phone
      FROM complaints c
      LEFT JOIN users cu ON cu.id = c.user_id
      LEFT JOIN requests r ON r.id = c.request_id
      LEFT JOIN users t  ON t.id  = r.technician_id
      ORDER BY c.id DESC
      LIMIT 1000
    `).all();
    res.json({ complaints });
  });

  // ── تحديث حالة الشكوى (أدمن فقط) — يستخدم عمود status الموجود أصلاً بالجدول ──
  router.post('/complaints/:id/status', auth, requireRole('admin'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صحيح', code: 'INVALID_ID' });
    const status = clean(req.body.status || '');
    const allowed = ['open', 'in_review', 'resolved', 'rejected'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'حالة غير صحيحة', code: 'STATUS_INVALID' });
    const existing = db.prepare('SELECT id FROM complaints WHERE id=?').get(id);
    if (!existing) return res.status(404).json({ error: 'الشكوى غير موجودة', code: 'COMPLAINT_NOT_FOUND' });
    db.prepare('UPDATE complaints SET status=? WHERE id=?').run(status, id);
    const complaint = db.prepare('SELECT * FROM complaints WHERE id=?').get(id);
    io.to('admin-room').emit('complaint-status-updated', { complaint });

    // [NOTIF-PHASE2B-1] نسخة دائمة لصاحب الشكوى — complaintId ضمن data فقط
    // (لا عمود مخصّص له بجدول notifications، بنفس منطق الإنشاء أعلاه).
    const complaintStatusLabels = { open: 'مفتوحة', in_review: 'قيد المراجعة', resolved: 'تم الحل', rejected: 'مرفوضة' };
    notify({
      userId: complaint.user_id,
      type: 'complaint',
      title: 'تحديث حالة الشكوى',
      body: `تم تحديث حالة شكواك إلى: ${complaintStatusLabels[status] || status}`,
      data: { complaintId: complaint.id }
    });

    res.json({ ok: true, complaint });
  });

  // endpoint جديد: يرجع تذاكر الدعم الخاصة بالمستخدم الحالي
  router.get('/support/my', auth, (req, res) => {
    const tickets = db.prepare(
      'SELECT * FROM support_tickets WHERE user_id=? ORDER BY id DESC'
    ).all(req.user.id);
    res.json({ tickets });
  });

  router.get('/support/:id/messages', auth, (req, res) => {
    const ticket = db.prepare(`
      SELECT t.*, u.name user_name, u.email, u.role user_role
      FROM support_tickets t
      LEFT JOIN users u ON u.id=t.user_id
      WHERE t.id=?
    `).get(req.params.id);

    if (!ticket) return res.status(404).json({ error: 'التذكرة غير موجودة', code: 'SUPPORT_TICKET_NOT_FOUND' });

    // IDOR guard: only the ticket owner or admin can read the ticket
    if (req.user.role !== 'admin' && ticket.user_id !== req.user.id)
      return res.status(403).json({ error: 'غير مصرح', code: 'FORBIDDEN_GENERIC' });

    const messages = db.prepare(`
      SELECT m.*, u.name sender_name, u.role sender_role
      FROM support_messages m
      JOIN users u ON u.id=m.sender_id
      WHERE m.ticket_id=?
      ORDER BY m.id ASC
    `).all(req.params.id);

    res.json({ ticket, messages });
  });

  // [SEC-FIX-SUPPORTSPAM-01] راجع DECISIONS.md.
  router.post('/support/:id/messages', auth, supportLimiter, (req, res) => {
    const ticket = db.prepare('SELECT * FROM support_tickets WHERE id=?').get(req.params.id);

    if (!ticket) return res.status(404).json({ error: 'التذكرة غير موجودة', code: 'SUPPORT_TICKET_NOT_FOUND' });

    // IDOR guard: only the ticket owner or admin can post messages
    if (req.user.role !== 'admin' && ticket.user_id !== req.user.id)
      return res.status(403).json({ error: 'غير مصرح', code: 'FORBIDDEN_GENERIC' });

    if (ticket.status === 'closed') {
      return res.status(400).json({ error: 'الدردشة منتهية', code: 'SUPPORT_CHAT_CLOSED' });
    }

    const body = clean(req.body.body || '');

    if (body.length < 1) {
      return res.status(400).json({ error: 'اكتب رسالة', code: 'SUPPORT_MESSAGE_EMPTY' });
    }
    if (body.length > 1000) {
      return res.status(400).json({ error: 'الرسالة طويلة جداً، الحد الأقصى 1000 حرف', code: 'CHAT_MESSAGE_TOO_LONG' });
    }

    db.prepare(`
      INSERT INTO support_messages(ticket_id,sender_id,body)
      VALUES(?,?,?)
    `).run(req.params.id, req.user.id, body);

    // [SEC-FIX-03] Support message — only to ticket owner + admin
    const supportMsgPayload = { ticketId: Number(req.params.id), ticketUserId: ticket.user_id, senderId: req.user.id };
    io.to(`user-${ticket.user_id}`).emit('support-message', supportMsgPayload);
    io.to('admin-room').emit('support-message', supportMsgPayload);
    const refreshPayload = { ticketId: Number(req.params.id), senderId: req.user.id };
    io.to(`user-${ticket.user_id}`).emit('support-message-refresh', refreshPayload);
    io.to('admin-room').emit('support-message-refresh', refreshPayload);
    // Push Notification لرسائل الدعم
    const isAdminSender = req.user.role === 'admin';
    if (isAdminSender) {
      // الأدمن رد — إشعار للعميل
      const ticketOwner = db.prepare('SELECT fcm_token FROM users WHERE id=?').get(ticket.user_id);
      if (ticketOwner?.fcm_token) {
        sendPush(ticketOwner.fcm_token,
          '🎧 رد من الدعم الفني',
          `${(req.body.body || '').slice(0, 100)}`,
          { type: 'support', ticketId: String(req.params.id) }
        );
      }
    } else {
      // العميل بعت — إشعار للأدمن
      const admins = db.prepare("SELECT fcm_token FROM users WHERE role='admin' AND fcm_token IS NOT NULL").all();
      admins.forEach(a => sendPush(a.fcm_token,
        '📋 رسالة دعم جديدة',
        `العميل ${req.user.name || ''}: ${(req.body.body || '').slice(0, 80)}`,
        { type: 'support', ticketId: String(req.params.id) }
      ));
    }

    // [NOTIF-PHASE2B-1] نسخة دائمة — نفس اتجاه الإشعار الفعلي أعلاه بالضبط
    // (لا تُبدّل sendPush ولا الأحداث اللحظية، تعمل بالتوازي معهما).
    if (isAdminSender) {
      notify({
        userId: ticket.user_id,
        type: 'support',
        title: 'رد من الدعم الفني',
        body: body.slice(0, 100),
        data: { ticketId: ticket.id },
        ticketId: ticket.id
      });
    } else {
      getAdminIds().forEach(adminId => notify({
        userId: adminId,
        type: 'support',
        title: 'رسالة دعم جديدة',
        body: `${req.user.name || 'مستخدم'}: ${body.slice(0, 80)}`,
        data: { ticketId: ticket.id },
        ticketId: ticket.id
      }));
    }

    res.json({ success: true });
  });

  return router;
};
