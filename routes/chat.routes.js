// routes/chat.routes.js — /api/requests/:id/messages|audio|images, /api/chats, /api/chat-violations
const express = require('express');

// دوال فحص محاولات مشاركة أرقام هواتف/روابط تواصل خارج التطبيق — خاصة بالشات بس.
function normalizeChatText(input) {
  let s = String(input || '').toLowerCase();
  const ar = '٠١٢٣٤٥٦٧٨٩', fa = '۰۱۲۳۴۵۶۷۸۹';
  s = s.replace(/[٠-٩]/g, ch => String(ar.indexOf(ch))).replace(/[۰-۹]/g, ch => String(fa.indexOf(ch))).replace(/[oO]/g, '0');
  s = s.replace(/[\u064B-\u065F\u0670ـ\s\-_.()\[\]{}|\\/,:;،]+/g, '');
  return s;
}
function chatViolationReason(body) {
  const rawBody = String(body || '');
  // Internal app payloads are allowed: location and audio do not reveal phone/WhatsApp.
  if (/^\[location\]-?\d{1,2}\.\d+,-?\d{1,3}\.\d+$/.test(rawBody)) return '';
  if (/^\[audio\]\/uploads\/audios\/[A-Za-z0-9_.-]+$/.test(rawBody)) return '';
  const original = rawBody;
  const lower = String(body || '').toLowerCase()
    .replace(/[٠-٩]/g, ch => String('٠١٢٣٤٥٦٧٨٩'.indexOf(ch)))
    .replace(/[۰-۹]/g, ch => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(ch)))
    .replace(/[oO]/g, '0');
  const compact = normalizeChatText(original);
  const groups = [
    { reason: 'واتساب', words: ['واتساب', 'واتس', 'وتساب', 'whatsapp', 'watsapp', 'wa.me', 'wa me'] },
    { reason: 'تيليجرام', words: ['تيليجرام', 'تليجرام', 'تلجرام', 'telegram', 't.me', 't me'] },
    { reason: 'فيسبوك أو ماسنجر', words: ['facebook', 'fb.com', 'fb com', 'messenger', 'فيسبوك', 'ماسنجر'] },
    { reason: 'إنستغرام أو سناب', words: ['instagram', 'insta', 'انستا', 'إنستا', 'snapchat', 'سناب'] },
    { reason: 'بريد إلكتروني', words: ['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'gmail', 'hotmail', 'outlook', 'yahoo'] }
  ];
  for (const g of groups) {
    for (const w of g.words) {
      const wl = String(w).toLowerCase();
      const wc = normalizeChatText(w);
      if ((wl && lower.includes(wl)) || (wc && compact.includes(wc))) return g.reason;
    }
  }
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(original)) return 'بريد إلكتروني';
  const digits = lower.replace(/[^0-9+]/g, '');
  const separated = lower.replace(/[^0-9]/g, '');
  if (/(\+?962|00962)?0?7[789]\d{7}/.test(digits) || /(962|00962)?0?7[789]\d{7}/.test(separated)) return 'رقم هاتف';
  if (/\d{10,}/.test(separated)) return 'رقم هاتف';
  if (separated.length >= 9 && /^(0?7|9627|009627)/.test(separated)) return 'رقم هاتف';
  return '';
}

module.exports = function (deps) {
  const { db } = deps;
  const { io, safeEmit } = deps.realtime;
  const { auth, requireRole, upload, uploadAudio } = deps.middleware;
  const { clean, getMessages, markChatRead } = deps.utils;
  const { sendPush } = deps.services;
  const { messagesLimiter, pollingLimiter } = deps.limiters;
  const router = express.Router();

  // [FIX-CHAT-01] دالة مركزية واحدة لفحص "هل لدى هذا الفني عرض ما زال ساري
  // المفعول (لم يُرفض بعد) على هذا الطلب؟". كان هذا الفحص مكرراً 6 مرات بكل
  // نقاط الشات، وكلها بلا استثناء الحالة (status) — فأي فني قُدِّم عرضه ثم
  // رُفض (لأن العميل اختار فنياً آخر) كان يحتفظ بصلاحية دائمة لقراءة/إرسال
  // رسائل بمحادثة خاصة بين العميل والفني المُختار فعلياً، والانضمام لغرفتها
  // اللحظية عبر Socket.IO أيضاً (نفس الفحص مكرر بـservices/socket.js).
  // وجود الدالة هنا مركزياً يمنع تكرار نفس الخطأ عند إضافة أي مسار جديد
  // مستقبلاً يحتاج نفس فحص الصلاحية.
  function hasActiveOffer(requestId, technicianId) {
    return db.prepare(
      "SELECT id FROM offers WHERE request_id=? AND technician_id=? AND status IN ('pending','accepted') LIMIT 1"
    ).get(requestId, technicianId);
  }

  // [FIX-UGC-01] الطرف الآخر بمحادثة طلب معيّن، بنفس منطق تنبيه الرسائل تماماً.
  function getOtherPartyId(r, userId) {
    return Number(userId) === Number(r.customer_id) ? r.technician_id : r.customer_id;
  }

  // [FIX-UGC-01] هل يوجد حظر بين مستخدمين بأي اتجاه؟ (حظر أحدهما كافٍ لمنع التراسل بالاتجاهين).
  function isBlockedEitherWay(userA, userB) {
    if (!userA || !userB) return false;
    const row = db.prepare(
      'SELECT id FROM user_blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?) LIMIT 1'
    ).get(userA, userB, userB, userA);
    return !!row;
  }

  function rejectBlockedChat(req, res, r, body) {
    const reason = chatViolationReason(body);
    if (!reason) return false;
    db.prepare('INSERT INTO chat_violations(request_id,user_id,body,reason) VALUES(?,?,?,?)').run(r.id, req.user.id, String(body || '').slice(0, 500), reason);
    return res.status(400).json({ error: '⚠️ الرسائل العادية مسموحة. الممنوع فقط مشاركة رقم هاتف أو واتساب أو تيليجرام أو إيميل أو روابط تواصل خارجية.' });
  }

  router.post('/requests/:id/messages', auth, messagesLimiter, (req, res) => {
    const r = db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'الطلب غير موجود' });
    const hasOffer = req.user.role === 'technician' ? hasActiveOffer(r.id, req.user.id) : null;
    if (req.user.role !== 'admin' && req.user.id !== r.customer_id && req.user.id !== r.technician_id && !hasOffer) return res.status(403).json({ error: 'لا تملك صلاحية' });
    if (['مكتمل', 'ملغي'].includes(r.status) && req.user.role !== 'admin') return res.status(400).json({ error: 'لا يمكن إرسال رسائل على طلب مغلق' });
    if (req.user.role !== 'admin' && isBlockedEitherWay(req.user.id, getOtherPartyId(r, req.user.id))) {
      return res.status(403).json({ error: 'لا يمكنك إرسال رسائل — تم حظر التواصل بين الطرفين' });
    }
    const body = clean(req.body.body); if (body.length < 1) return res.status(400).json({ error: 'الرسالة فارغة' });
    if (body.length > 1000) return res.status(400).json({ error: 'الرسالة طويلة جداً، الحد الأقصى 1000 حرف' });
    if (rejectBlockedChat(req, res, r, body)) return;
    db.prepare('INSERT INTO messages(request_id,sender_id,body) VALUES(?,?,?)').run(r.id, req.user.id, body);
    markChatRead(r.id, req.user.id);
    const messages = getMessages(r.id);
    safeEmit(r.id, 'messages-updated', { requestId: r.id, messages, senderId: Number(req.user.id) });

    const chatPayload = {
      requestId: Number(r.id),
      senderId: Number(req.user.id),
      customerId: Number(r.customer_id),
      technicianId: r.technician_id ? Number(r.technician_id) : null
    };
    // [SEC-FIX-03] Only notify the other party in the chat, not everyone
    const otherPartyId = req.user.id === r.customer_id ? r.technician_id : r.customer_id;
    if (otherPartyId) io.to(`user-${otherPartyId}`).emit('chat-message-notify', chatPayload);
    io.to(`user-${req.user.id}`).emit('chat-message-notify', chatPayload);
    io.to('admin-room').emit('chat-message-notify', chatPayload);
    // chat-badges-updated only to participants
    io.to(`user-${r.customer_id}`).emit('chat-badges-updated', { requestId: Number(r.id) });
    if (r.technician_id) io.to(`user-${r.technician_id}`).emit('chat-badges-updated', { requestId: Number(r.id) });
    io.to('admin-room').emit('chat-badges-updated', { requestId: Number(r.id) });
    // Push Notification للطرف الثاني إذا كان خارج التطبيق
    if (otherPartyId) {
      const otherUser = db.prepare('SELECT fcm_token, name FROM users WHERE id=?').get(otherPartyId);
      if (otherUser?.fcm_token) {
        const senderName = req.user.name || 'مستخدم';
        const isCustomerSender = req.user.id === r.customer_id;
        sendPush(otherUser.fcm_token,
          isCustomerSender ? `📨 رسالة من العميل` : `📨 رسالة من الفني`,
          `${senderName}: ${(body || '').slice(0, 80)}`,
          { type: 'chat', requestId: String(r.id) }
        );
      }
    }
    res.json({ messages });
  });

  router.post('/requests/:id/audio', auth, messagesLimiter, uploadAudio.single('audio'), (req, res) => {
    const r = db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'الطلب غير موجود' });
    const hasOffer = req.user.role === 'technician' ? hasActiveOffer(r.id, req.user.id) : null;
    if (req.user.role !== 'admin' && req.user.id !== r.customer_id && req.user.id !== r.technician_id && !hasOffer) return res.status(403).json({ error: 'لا تملك صلاحية' });
    if (['مكتمل', 'ملغي'].includes(r.status) && req.user.role !== 'admin') return res.status(400).json({ error: 'لا يمكن إرسال رسائل على طلب مغلق' });
    if (req.user.role !== 'admin' && isBlockedEitherWay(req.user.id, getOtherPartyId(r, req.user.id))) {
      return res.status(403).json({ error: 'لا يمكنك إرسال رسائل — تم حظر التواصل بين الطرفين' });
    }
    if (!req.file) return res.status(400).json({ error: 'لم يتم استقبال التسجيل الصوتي' });
    const url = '/uploads/audios/' + req.file.filename;
    const body = '[audio]' + url;
    db.prepare('INSERT INTO messages(request_id,sender_id,body) VALUES(?,?,?)').run(r.id, req.user.id, body);
    markChatRead(r.id, req.user.id);
    const messages = getMessages(r.id);
    safeEmit(r.id, 'messages-updated', { requestId: r.id, messages, senderId: Number(req.user.id) });
    // [SEC-FIX-03] Targeted badges update for audio message
    io.to(`user-${r.customer_id}`).emit('chat-badges-updated', { requestId: r.id });
    if (r.technician_id) io.to(`user-${r.technician_id}`).emit('chat-badges-updated', { requestId: r.id });
    io.to('admin-room').emit('chat-badges-updated', { requestId: r.id });
    res.json({ messages });
  });

  // ── إرسال صورة في الشات (يستخدم نفس حماية ونمط مسار الصوت) ──
  router.post('/requests/:id/images', auth, messagesLimiter, upload.single('image'), (req, res) => {
    const r = db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'الطلب غير موجود' });
    const hasOffer = req.user.role === 'technician' ? hasActiveOffer(r.id, req.user.id) : null;
    if (req.user.role !== 'admin' && req.user.id !== r.customer_id && req.user.id !== r.technician_id && !hasOffer) return res.status(403).json({ error: 'لا تملك صلاحية' });
    if (['مكتمل', 'ملغي'].includes(r.status) && req.user.role !== 'admin') return res.status(400).json({ error: 'لا يمكن إرسال رسائل على طلب مغلق' });
    if (req.user.role !== 'admin' && isBlockedEitherWay(req.user.id, getOtherPartyId(r, req.user.id))) {
      return res.status(403).json({ error: 'لا يمكنك إرسال رسائل — تم حظر التواصل بين الطرفين' });
    }
    if (!req.file) return res.status(400).json({ error: 'لم يتم استقبال الصورة' });
    const url = '/uploads/requests/' + req.file.filename;
    const body = '[image]' + url;
    db.prepare('INSERT INTO messages(request_id,sender_id,body) VALUES(?,?,?)').run(r.id, req.user.id, body);
    markChatRead(r.id, req.user.id);
    const messages = getMessages(r.id);
    safeEmit(r.id, 'messages-updated', { requestId: r.id, messages, senderId: Number(req.user.id) });
    io.to(`user-${r.customer_id}`).emit('chat-badges-updated', { requestId: r.id });
    if (r.technician_id) io.to(`user-${r.technician_id}`).emit('chat-badges-updated', { requestId: r.id });
    io.to('admin-room').emit('chat-badges-updated', { requestId: r.id });
    res.json({ messages });
  });

  router.get('/requests/:id/messages', auth, (req, res) => {
    const r = db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'الطلب غير موجود' });
    const hasOffer = req.user.role === 'technician' ? hasActiveOffer(r.id, req.user.id) : null;
    if (req.user.role !== 'admin' && req.user.id !== r.customer_id && req.user.id !== r.technician_id && !hasOffer) return res.status(403).json({ error: 'لا تملك صلاحية' });
    markChatRead(r.id, req.user.id);
    // [SEC-FIX-03] Targeted badges updated on read
    io.to(`user-${r.customer_id}`).emit('chat-badges-updated', { requestId: r.id });
    if (r.technician_id) io.to(`user-${r.technician_id}`).emit('chat-badges-updated', { requestId: r.id });
    io.to('admin-room').emit('chat-badges-updated', { requestId: r.id });
    // [FIX-02] تحديث حالة "تمت المشاهدة" لدى الطرف الآخر فوراً
    const readMessages = getMessages(req.params.id);
    safeEmit(r.id, 'messages-updated', { requestId: r.id, messages: readMessages, senderId: Number(req.user.id) });
    res.json({ messages: readMessages });
  });

  // [FIX-UGC-01] الإبلاغ عن رسالة مسيئة (Google Play UGC policy)
  router.post('/requests/:id/report-message', auth, (req, res) => {
    const r = db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'الطلب غير موجود' });
    const hasOffer = req.user.role === 'technician' ? hasActiveOffer(r.id, req.user.id) : null;
    if (req.user.role !== 'admin' && req.user.id !== r.customer_id && req.user.id !== r.technician_id && !hasOffer) return res.status(403).json({ error: 'لا تملك صلاحية' });
    const messageId = parseInt(req.body.messageId, 10) || null;
    const reason = clean(req.body.reason);
    if (!reason || reason.length < 2) return res.status(400).json({ error: 'الرجاء اختيار سبب البلاغ' });
    if (reason.length > 200) return res.status(400).json({ error: 'سبب البلاغ طويل جداً' });
    let messageBody = null;
    let reportedUserId = null;
    if (messageId) {
      const msg = db.prepare('SELECT * FROM messages WHERE id=? AND request_id=?').get(messageId, r.id);
      if (msg) { messageBody = String(msg.body || '').slice(0, 500); reportedUserId = msg.sender_id; }
    }
    if (!reportedUserId) reportedUserId = getOtherPartyId(r, req.user.id);
    db.prepare('INSERT INTO message_reports(request_id,message_id,reporter_id,reported_user_id,reason,message_body) VALUES(?,?,?,?,?,?)')
      .run(r.id, messageId, req.user.id, reportedUserId, reason, messageBody);
    io.to('admin-room').emit('new-message-report', { requestId: Number(r.id) });
    res.json({ ok: true, message: 'تم إرسال البلاغ للإدارة، شكراً لك' });
  });

  // [FIX-UGC-01] حظر الطرف الآخر بهذا الطلب — يمنع التراسل بالاتجاهين فوراً.
  router.post('/requests/:id/block', auth, (req, res) => {
    const r = db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'الطلب غير موجود' });
    const hasOffer = req.user.role === 'technician' ? hasActiveOffer(r.id, req.user.id) : null;
    if (req.user.role !== 'admin' && req.user.id !== r.customer_id && req.user.id !== r.technician_id && !hasOffer) return res.status(403).json({ error: 'لا تملك صلاحية' });
    const otherPartyId = getOtherPartyId(r, req.user.id);
    if (!otherPartyId) return res.status(400).json({ error: 'لا يوجد طرف آخر لحظره بعد بهذا الطلب' });
    db.prepare('INSERT OR IGNORE INTO user_blocks(blocker_id,blocked_id) VALUES(?,?)').run(req.user.id, otherPartyId);
    res.json({ ok: true, blocked: true });
  });

  // [FIX-UGC-01] إلغاء حظر الطرف الآخر بهذا الطلب.
  router.delete('/requests/:id/block', auth, (req, res) => {
    const r = db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'الطلب غير موجود' });
    // [FIX-CHAT-01] هذا المسار لم يكن فيه أي فحص صلاحية إطلاقاً (بعكس نظيره
    // POST /block الذي يتحقق من customer_id/technician_id/admin/hasActiveOffer)
    // — أي مستخدم مسجَّل دخول كان يستطيع استدعاءه لأي requestId عشوائي.
    const hasOffer = req.user.role === 'technician' ? hasActiveOffer(r.id, req.user.id) : null;
    if (req.user.role !== 'admin' && req.user.id !== r.customer_id && req.user.id !== r.technician_id && !hasOffer) return res.status(403).json({ error: 'لا تملك صلاحية' });
    const otherPartyId = getOtherPartyId(r, req.user.id);
    if (otherPartyId) db.prepare('DELETE FROM user_blocks WHERE blocker_id=? AND blocked_id=?').run(req.user.id, otherPartyId);
    res.json({ ok: true, blocked: false });
  });

  // [FIX-UGC-01] هل أنا حاظر الطرف الآخر، أو هو حاظرني؟ (لعرض الحالة الصحيحة بالواجهة)
  router.get('/requests/:id/block-status', auth, (req, res) => {
    const r = db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'الطلب غير موجود' });
    // [FIX-CHAT-01] هذا المسار لم يكن فيه أي فحص صلاحية إطلاقاً — أي مستخدم
    // مسجَّل دخول كان يستطيع الاستعلام عن حالة الحظر بين طرفَي أي طلب عشوائي
    // لا علاقة له به. نفس فحص باقي مسارات الشات.
    const hasOffer = req.user.role === 'technician' ? hasActiveOffer(r.id, req.user.id) : null;
    if (req.user.role !== 'admin' && req.user.id !== r.customer_id && req.user.id !== r.technician_id && !hasOffer) return res.status(403).json({ error: 'لا تملك صلاحية' });
    const otherPartyId = getOtherPartyId(r, req.user.id);
    if (!otherPartyId) return res.json({ blockedByMe: false, blockedMe: false, otherUserId: null });
    const blockedByMe = !!db.prepare('SELECT id FROM user_blocks WHERE blocker_id=? AND blocked_id=?').get(req.user.id, otherPartyId);
    const blockedMe = !!db.prepare('SELECT id FROM user_blocks WHERE blocker_id=? AND blocked_id=?').get(otherPartyId, req.user.id);
    res.json({ blockedByMe, blockedMe, otherUserId: Number(otherPartyId) });
  });

  router.get('/chat-violations', auth, requireRole('admin'), (req, res) => {
    const rows = db.prepare(`SELECT v.*,u.name user_name,u.email user_email,r.service,r.status FROM chat_violations v LEFT JOIN users u ON u.id=v.user_id LEFT JOIN requests r ON r.id=v.request_id ORDER BY v.id DESC LIMIT 200`).all();
    res.json({ violations: rows });
  });

  // [FIX-UGC-01] قائمة بلاغات الرسائل للإدارة (نفس نمط chat-violations تماماً)
  router.get('/message-reports', auth, requireRole('admin'), (req, res) => {
    const rows = db.prepare(`SELECT mr.*, reporter.name reporter_name, reported.name reported_name, reported.email reported_email
      FROM message_reports mr
      LEFT JOIN users reporter ON reporter.id=mr.reporter_id
      LEFT JOIN users reported ON reported.id=mr.reported_user_id
      ORDER BY mr.id DESC LIMIT 200`).all();
    res.json({ reports: rows });
  });

  // V13 chats center and support center
  router.get('/chats', auth, pollingLimiter, (req, res) => {
    let rows = [];
    if (req.user.role === 'customer') {
      rows = db.prepare(`SELECT r.id request_id,r.service,r.status,u.name other_name,
        (SELECT body FROM messages WHERE request_id=r.id ORDER BY id DESC LIMIT 1) last_body,
        (SELECT created_at FROM messages WHERE request_id=r.id ORDER BY id DESC LIMIT 1) last_at,
        (SELECT COUNT(*) FROM messages m LEFT JOIN chat_reads cr ON cr.request_id=m.request_id AND cr.user_id=? WHERE m.request_id=r.id AND m.sender_id<>? AND m.id>COALESCE(cr.last_read_message_id,0)) unread_count
        FROM requests r LEFT JOIN users u ON u.id=r.technician_id
        WHERE r.customer_id=? AND (r.technician_id IS NOT NULL OR EXISTS(SELECT 1 FROM messages m WHERE m.request_id=r.id))
        ORDER BY COALESCE(last_at,r.created_at) DESC`).all(req.user.id, req.user.id, req.user.id);
    } else if (req.user.role === 'technician') {
      rows = db.prepare(`SELECT r.id request_id,r.service,r.status,u.name other_name,
        (SELECT body FROM messages WHERE request_id=r.id ORDER BY id DESC LIMIT 1) last_body,
        (SELECT created_at FROM messages WHERE request_id=r.id ORDER BY id DESC LIMIT 1) last_at,
        (SELECT COUNT(*) FROM messages m LEFT JOIN chat_reads cr ON cr.request_id=m.request_id AND cr.user_id=? WHERE m.request_id=r.id AND m.sender_id<>? AND m.id>COALESCE(cr.last_read_message_id,0)) unread_count
        FROM requests r JOIN users u ON u.id=r.customer_id
        WHERE r.technician_id=? OR EXISTS(SELECT 1 FROM offers o WHERE o.request_id=r.id AND o.technician_id=?)
        ORDER BY COALESCE(last_at,r.created_at) DESC`).all(req.user.id, req.user.id, req.user.id, req.user.id);
    }
    const total = rows.reduce((a, b) => a + Number(b.unread_count || 0), 0);
    res.json({ chats: rows, total_unread: total });
  });

  return router;
};
