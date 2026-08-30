// services/socket.js
// تهيئة Socket.IO كامل: المصادقة، الغرف، ودالة safeEmit. أي تعديل على منطق الغرف
// أو المصادقة اللحظية مكانه هون بس — ما بأثر على أي route.

const http = require('http');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { db } = require('../config/db');
const { JWT_SECRET, IO_CORS_ORIGINS } = require('../config/env');
const { canAccessRequestChat } = require('../utils/helpers');

function createSocket(app) {
  const server = http.createServer(app);
  // [BW-FIX-01] بلا تحديد transports كانت الافتراضية Engine.IO تسمح بـ
  // ['polling','websocket'] معاً — أي عميل لا يُكمل ترقية WebSocket بنجاح
  // (شبكة جوال غير مستقرة، أو محاولات إعادة اتصال متتالية) يبقى (أو يعلق)
  // على HTTP long-polling: طلب HTTP حقيقي فعلي كل ~25 ثانية لكل عميل متصل،
  // إلى ما لا نهاية — يظهر في مقاييس Render كطلبات HTTP عادية تماماً، وهذا
  // ما فسّر الحجم الكبير من الطلبات (261,751 خلال 7 أيام) رغم أن REST API
  // نفسها لا علاقة لها بهذا إطلاقاً (Socket.IO منفصل كلياً عن أي route).
  // websocket فقط هنا يمنع أي عميل من الاتصال عبر polling من الأساس —
  // يفشل الاتصال بوضوح فوراً بدل توليد حجم طلبات صامت. Render يدعم
  // WebSocket رسمياً على كل الخطط، فلا حاجة لإبقاء polling كـfallback.
  // pingInterval/pingTimeout مطابقتان تماماً لقيم Engine.IO الافتراضية —
  // تُكتَبان صراحة هنا فقط لتوثيقهما وتثبيتهما بدل الاعتماد على افتراضي
  // ضمني قد يتغيّر بترقية مستقبلية للمكتبة.
  const io = new Server(server, {
    cors: { origin: IO_CORS_ORIGINS, credentials: true },
    transports: ['websocket'],
    pingInterval: 25000,
    pingTimeout: 20000
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
      // [SEC-FIX-SOCKETCRASH-01] راجع DECISIONS.md — requestId كان يصل خاماً
      // لـdb.prepare(...).get() بلا أي تحقق من نوعه. better-sqlite3 يرمي
      // RangeError متزامناً لو الوسيط كائناً/مصفوفة بدل رقم/نص بسيط — أي عميل
      // متصل (بلا أي صلاحية خاصة، فقط تسجيل دخول عادي) يقدر يرسل
      // socket.emit('join-request', {...}) بحمولة مشوَّهة. socket.io 4.8.3
      // يستدعي مستمعي الأحداث مباشرة داخل process.nextTick بلا أي try/catch
      // بمكتبته نفسها — استثناء غير مُلتقَط هنا يصل مباشرة لـ
      // process.on('uncaughtException') بـserver.js، الذي يُنفِّذ gracefulShutdown
      // كاملاً: **يُسقط السيرفر بأكمله لكل المستخدمين المتصلين**، لا فقط طلب
      // العميل المُرسِل. try/catch هنا كافٍ وحده تقنياً، لكن التحقق الصريح من
      // النوع أولاً أوضح للقارئ ويطابق نمط استخدام parseInt+isNaN المُستخدَم
      // بكل مسارات REST المشابهة (مثال: routes/offers.routes.js).
      try {
        const id = parseInt(requestId, 10);
        if (!id || isNaN(id)) return;
        // Only allow joining rooms for requests the user is part of
        const r = db.prepare('SELECT * FROM requests WHERE id=?').get(id);
        if (!r) return;
        // [SEC-FIX-CHATSCOPE-03] راجع DECISIONS.md — دالة مشتركة مع
        // routes/chat.routes.js (utils/helpers.js) بدل نسخة مكتوبة هنا يدوياً.
        // هذا الفحص تحديداً انحرف مرتين ([SEC-FIX-CHATSCOPE-01]، [SEC-FIX-CHATSCOPE-02])
        // قبل التوحيد — دالة واحدة تمنع تكرار الانحراف بدل الاعتماد على تذكّر تحديث نسختين.
        if (canAccessRequestChat(socket.user, r)) socket.join(String(r.id));
      } catch (e) {}
    });
    socket.on('leave-request', (requestId) => { if (requestId) socket.leave(String(requestId)); });
  });

  function safeEmit(room, event, payload) { try { io.to(String(room)).emit(event, payload); } catch (e) {} }

  return { server, io, safeEmit };
}

module.exports = { createSocket };
