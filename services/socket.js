// services/socket.js
// تهيئة Socket.IO كامل: المصادقة، الغرف، ودالة safeEmit. أي تعديل على منطق الغرف
// أو المصادقة اللحظية مكانه هون بس — ما بأثر على أي route.

const http = require('http');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { db } = require('../config/db');
const { JWT_SECRET, IO_CORS_ORIGINS } = require('../config/env');

function createSocket(app) {
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: IO_CORS_ORIGINS, credentials: true }
  });

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.cookie?.match(/token=([^;]+)/)?.[1];
      if (!token) return next(new Error('غير مصرح'));
      const decoded = jwt.verify(token, JWT_SECRET);
      // [FIX-AUTH-01] نفس فحص is_active الحي المطبَّق أصلاً على كل طلب REST
      // بـmiddleware/auth.js — بدونه، حساب أُوقف بينما اتصال Socket.IO لا يزال
      // مفتوحاً فعلياً يستمر بإرسال/استقبال رسائل رغم رفض كل REST endpoint له.
      const liveUser = db.prepare('SELECT id, role, is_active, token_version FROM users WHERE id=?').get(decoded.id);
      if (!liveUser || !liveUser.is_active) return next(new Error('الجلسة منتهية أو الحساب موقوف'));
      // [SEC-FIX-09] نفس فحص token_version المطبَّق بـmiddleware/auth.js —
      // توكن أُبطل بتسجيل خروج/تغيير كلمة سر لا يجوز أن يفتح اتصال Socket.IO
      // جديداً، تماماً كما لا يجوز أن يمرّ أي طلب REST به.
      if ((decoded.tokenVersion || 0) !== (liveUser.token_version || 0)) {
        return next(new Error('الجلسة منتهية أو الحساب موقوف'));
      }
      // [FIX-AUTH-03] socket.user كان يُبنى من decoded (بيانات التوكن وقت
      // إصداره، تبقى كما هي حتى 7 أيام) بدل liveUser (بيانات القاعدة الحية) —
      // فلو تغيّر دور المستخدم بعد إصدار التوكن، يبقى السوكت يستخدم الدور
      // القديم طوال عمر التوكن. الآن يُبنى socket.user من القيم الحية دائماً.
      socket.user = { id: liveUser.id, role: liveUser.role };
      next();
    } catch { next(new Error('جلسة غير صالحة')); }
  });

  // [SEC-FIX-03] Socket.IO — join personal room on connect for targeted emits
  io.on('connection', (socket) => {
    // Each authenticated user joins their personal room: "user-{id}" and role room
    socket.join(`user-${socket.user.id}`);
    if (socket.user.role === 'admin') socket.join('admin-room');
    if (socket.user.role === 'technician') socket.join('technicians-room');

    socket.on('join-request', (requestId) => {
      if (!requestId) return;
      // Only allow joining rooms for requests the user is part of
      const r = db.prepare('SELECT * FROM requests WHERE id=?').get(requestId);
      if (!r) return;
      // [FIX-CHAT-01] نفس فحص حالة العرض المُضاف بـchat.routes.js — بدونه هنا
      // تحديداً، فني رُفض عرضه (status='rejected') يبقى قادراً على الانضمام
      // للغرفة اللحظية واستقبال كل رسالة جديدة، حتى لو مُنع من REST.
      const isAllowed = socket.user.role === 'admin' || r.customer_id === socket.user.id || r.technician_id === socket.user.id ||
        (socket.user.role === 'technician' && db.prepare("SELECT id FROM offers WHERE request_id=? AND technician_id=? AND status IN ('pending','accepted') LIMIT 1").get(requestId, socket.user.id));
      if (isAllowed) socket.join(String(requestId));
    });
    socket.on('leave-request', (requestId) => { if (requestId) socket.leave(String(requestId)); });
  });

  function safeEmit(room, event, payload) { try { io.to(String(room)).emit(event, payload); } catch (e) {} }

  return { server, io, safeEmit };
}

module.exports = { createSocket };
