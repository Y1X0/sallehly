// routes/support.routes.js — /api/support*, /api/fcm-token, /api/complaints
const express = require('express');

module.exports = function (deps) {
  const { db } = deps;
  const { io } = deps.realtime;
  const { auth, requireRole } = deps.middleware;
  const { clean } = deps.utils;
  const { sendPush } = deps.services;
  const router = express.Router();

  router.post('/support', auth, (req, res) => {
    const { type, title, body } = req.body || {};
    if (clean(title).length < 3 || clean(body).length < 10 || clean(title).length > 120 || clean(body).length > 2000) return res.status(400).json({ error: 'اكتب عنوان وتفاصيل واضحة للدعم' });
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
      return res.status(400).json({ error: 'نوع التذكرة غير صحيح: ' + ticketType });
    }
    // [FIX-06] السماح بتذكرة واحدة مفتوحة فقط لكل مستخدم
    const openTicket = db.prepare("SELECT id FROM support_tickets WHERE user_id=? AND status='open' LIMIT 1").get(req.user.id);
    if (openTicket) {
      return res.status(409).json({ error: 'لديك تذكرة دعم مفتوحة بالفعل. انتظر رد الإدارة أو أكمل المحادثة الحالية.' });
    }
    const info = db.prepare('INSERT INTO support_tickets(user_id,type,title,body) VALUES(?,?,?,?)')
      .run(req.user.id, ticketType, clean(title), clean(body));

    const ticket = db.prepare('SELECT * FROM support_tickets WHERE id=?').get(info.lastInsertRowid);

    // [SEC-FIX-03] Support ticket notifications only to admin + ticket owner
    io.to('admin-room').emit('support-created', { ticket });
    io.to(`user-${req.user.id}`).emit('support-created', { ticket });

    res.json({ ticket });
  });

  router.get('/support', auth, requireRole('admin'), (req, res) => {
    res.json({ tickets: db.prepare(`SELECT t.*,u.name user_name,u.role user_role,u.email FROM support_tickets t LEFT JOIN users u ON u.id=t.user_id ORDER BY t.id DESC`).all() });
  });

  router.post('/support/:id/status', auth, requireRole('admin'), (req, res) => {
    const status = clean(req.body.status || 'open');
    if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'حالة الدعم غير صحيحة' });
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
    if (!token || typeof token !== 'string') return res.status(400).json({ error: 'token مطلوب' });
    db.prepare('UPDATE users SET fcm_token=? WHERE id=?').run(token, req.user.id);
    res.json({ ok: true });
  });

  // ── شكاوى العملاء — للأدمن فقط ──
  router.post('/complaints', auth, requireRole('customer'), (req, res) => {
    const { request_id, body } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'الشكوى فارغة' });
    // جيب الـtechnician_id من الطلب
    const request = request_id ? db.prepare('SELECT technician_id FROM requests WHERE id=? AND customer_id=?').get(request_id, req.user.id) : null;
    const info = db.prepare('INSERT INTO complaints (request_id, customer_id, technician_id, body) VALUES (?,?,?,?)')
      .run(request_id || null, req.user.id, request?.technician_id || null, body.trim());
    const complaint = db.prepare('SELECT * FROM complaints WHERE id=?').get(info.lastInsertRowid);
    // إشعار للأدمن
    io.to('admin-room').emit('new-complaint', { complaint });
    // Push للأدمن
    const admins = db.prepare("SELECT fcm_token FROM users WHERE role='admin' AND fcm_token IS NOT NULL").all();
    admins.forEach(a => sendPush(a.fcm_token, '⚠️ شكوى جديدة', `العميل ${req.user.name || ''} قدّم شكوى على طلب #${request_id || ''}`, { type: 'complaint' }));
    res.json({ ok: true, complaint });
  });

  router.get('/complaints', auth, requireRole('admin'), (req, res) => {
    const complaints = db.prepare(`
      SELECT c.*, 
        cu.name as customer_name, cu.phone as customer_phone,
        t.name as technician_name, t.phone as technician_phone
      FROM complaints c
      LEFT JOIN users cu ON cu.id = c.customer_id
      LEFT JOIN users t  ON t.id  = c.technician_id
      ORDER BY c.id DESC
    `).all();
    res.json({ complaints });
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

    if (!ticket) return res.status(404).json({ error: 'التذكرة غير موجودة' });

    // IDOR guard: only the ticket owner or admin can read the ticket
    if (req.user.role !== 'admin' && ticket.user_id !== req.user.id)
      return res.status(403).json({ error: 'غير مصرح' });

    const messages = db.prepare(`
      SELECT m.*, u.name sender_name, u.role sender_role
      FROM support_messages m
      JOIN users u ON u.id=m.sender_id
      WHERE m.ticket_id=?
      ORDER BY m.id ASC
    `).all(req.params.id);

    res.json({ ticket, messages });
  });

  router.post('/support/:id/messages', auth, (req, res) => {
    const ticket = db.prepare('SELECT * FROM support_tickets WHERE id=?').get(req.params.id);

    if (!ticket) return res.status(404).json({ error: 'التذكرة غير موجودة' });

    // IDOR guard: only the ticket owner or admin can post messages
    if (req.user.role !== 'admin' && ticket.user_id !== req.user.id)
      return res.status(403).json({ error: 'غير مصرح' });

    if (ticket.status === 'closed') {
      return res.status(400).json({ error: 'الدردشة منتهية' });
    }

    const body = clean(req.body.body || '');

    if (body.length < 1) {
      return res.status(400).json({ error: 'اكتب رسالة' });
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
    res.json({ success: true });
  });

  return router;
};
