// routes/chat.routes.js — /api/requests/:id/messages|audio|images, /api/chats, /api/chat-violations
const express = require('express');

// دوال فحص محاولات مشاركة أرقام هواتف/روابط تواصل خارج التطبيق — خاصة بالشات بس.

// [SEC-FIX-INVISIBLECHARS-01] راجع DECISIONS.md. النطاقات بالاسم: U+00AD
// SOFT HYPHEN، U+034F COMBINING GRAPHEME JOINER، U+061C ARABIC LETTER MARK،
// U+180E MONGOLIAN VOWEL SEPARATOR، U+200B-U+200F (ZERO WIDTH SPACE/
// NON-JOINER/JOINER، LRM/RLM)، U+202A-U+202E (bidi embedding/override)،
// U+2060-U+2064 (WORD JOINER وما شابه)، U+2066-U+2069 (bidi isolate)،
// U+2028/U+2029 (LINE/PARAGRAPH SEPARATOR)، U+FEFF (BOM/ZERO WIDTH
// NO-BREAK SPACE)، U+FFF9-U+FFFB (INTERLINEAR ANNOTATION)، U+FE00-U+FE0F
// (VARIATION SELECTORS — الفئة الموسَّعة الأولى المُضافة هنا)، وC0/C1
// control characters النادرة (U+0000-U+0008، U+000B-U+000C، U+000E-U+001F، U+007F-U+009F —
// الفئة الموسَّعة الثانية؛ \t\n\r مُستثناة عمداً، مُعالَجة أصلاً كمسافة
// عادية بـ`normalizeChatText` أدناه). استُخدمت \uXXXX الصريحة بدل حروف
// حرفية غير مرئية في الكود المصدري كي تبقى قابلة للمراجعة البصرية.
//
// مُعرَّفة بمستوى الملف (لا داخل chatViolationReason فقط) وتُطبَّق أيضاً
// داخل normalizeChatText نفسها أدناه — لو استُخدمت هذه الدالة مستقبلاً
// بموضع آخر غير chatViolationReason، تبقى الحماية سارية تلقائياً بدل
// الاعتماد على أن يتذكّر كل مستدعٍ تطبيق الإزالة بنفسه أولاً.
const INVISIBLE_CHARS_RE = new RegExp(
  '[\\u0000-\\u0008\\u000B-\\u000C\\u000E-\\u001F\\u007F-\\u009F' +
  '\\u00AD\\u034F\\u061C\\u180E\\u200B-\\u200F\\u202A-\\u202E' +
  '\\u2060-\\u2064\\u2066-\\u2069\\u2028\\u2029' +
  '\\uFE00-\\uFE0F\\uFEFF\\uFFF9-\\uFFFB]', 'g'
);
function stripInvisibleChars(input) {
  return String(input || '').replace(INVISIBLE_CHARS_RE, '');
}

function normalizeChatText(input) {
  let s = stripInvisibleChars(input).toLowerCase();
  const ar = '٠١٢٣٤٥٦٧٨٩', fa = '۰۱۲۳۴۵۶۷۸۹';
  s = s.replace(/[٠-٩]/g, ch => String(ar.indexOf(ch))).replace(/[۰-۹]/g, ch => String(fa.indexOf(ch))).replace(/[oO]/g, '0');
  s = s.replace(/[\u064B-\u065F\u0670ـ\s\-_.()\[\]{}|\\/,:;،]+/g, '');
  return s;
}
// [SEC-FIX-C1] الصيغ [image]/[audio]/[location] بأول الرسالة تُفسّرها واجهة
// فلاتر (MessageModel.isImage/isAudio/isLocation) كوسائط، وفتح الصورة الكاملة
// كان يُرفق Authorization: Bearer <JWT> لأي رابط بلا تمييز (انظر chat_bubble.dart).
// [image] و[audio] ليس لهما أي مسار شرعي عبر endpoint الرسائل النصية هذا على
// الإطلاق — الوحيدان الشرعيان لإنشائهما هما POST /requests/:id/images
// و/requests/:id/audio نفسهما (يُدرجان الرسالة مباشرة، لا يمرّان بهذا الراوت)،
// فيُرفضان دوماً هنا. [location] مختلف: SEND الموقع الشرعي بالتطبيق يمر فعلاً
// عبر هذا الـendpoint بالذات (ChatApi.sendLocation ← sendMessage) بصيغة رقمية
// صارمة فقط، فتُسمح فقط بهذه الصيغة تحديداً. أي شيء آخر بهذه البادئات الثلاث —
// مثل "[image]https://attacker.com/x.png" — كان يُقبل ويُخزَّن كرسالة نصية
// عادية بلا أي تحقق، فيفسّره الطرف الآخر كصورة ويُرسِل توكن جلسته لخادم
// المهاجم عند فتح الصورة كاملة.
const LOCATION_BODY_RE = /^\[location\]-?\d{1,2}\.\d+,-?\d{1,3}\.\d+$/;
function isSpoofedMediaBody(body) {
  const rawBody = String(body || '');
  if (rawBody.startsWith('[image]') || rawBody.startsWith('[audio]')) return true;
  if (rawBody.startsWith('[location]')) return !LOCATION_BODY_RE.test(rawBody);
  return false;
}

function chatViolationReason(body) {
  const rawBody = String(body || '');
  // Internal app payloads are allowed: location and audio do not reveal phone/WhatsApp.
  if (LOCATION_BODY_RE.test(rawBody)) return '';
  if (/^\[audio\]\/uploads\/audios\/[A-Za-z0-9_.-]+$/.test(rawBody)) return '';
  // [SEC-FIX-INVISIBLECHARS-01] راجع DECISIONS.md — إدراج حرف Unicode غير
  // مرئي (مثل U+200B، مسافة بعرض صفر) بين أرقام رقم الهاتف يفكّك "مقطع
  // الأرقام المتصل" الذي يعتمد عليه الفحص أدناه (كل رقم يصير مقطعاً منفصلاً
  // بطول 1، لا يصل أبداً لعتبة 10 خانات)، بلا أي أثر مرئي للطرف المستقبِل —
  // الحرف نفسه لا يُعرَض إطلاقاً. نفس الحيلة تفكّك أيضاً كلمات المنصات
  // ("واتساب"/"whatsapp") المفحوصة أدناه. `INVISIBLE_CHARS_RE` (مستوى
  // الملف، أعلى `normalizeChatText`) تشرح كل النطاقات المُزالة بالاسم.
  const original = stripInvisibleChars(rawBody);
  const lower = original.toLowerCase()
    .replace(/[٠-٩]/g, ch => String('٠١٢٣٤٥٦٧٨٩'.indexOf(ch)))
    .replace(/[۰-۹]/g, ch => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(ch)))
    .replace(/[oO]/g, '0');
  const compact = normalizeChatText(original);
  // [H1] 'insta' و'wa me'/'t me'/'fb com' أُزيلت من هذه القائمة — substring
  // بلا حدود كلمة كانت تُصادف كلمات عادية شائعة (انظر boundaryChecks أسفل).
  const groups = [
    { reason: 'واتساب', words: ['واتساب', 'واتس', 'وتساب', 'whatsapp', 'watsapp'] },
    { reason: 'تيليجرام', words: ['تيليجرام', 'تليجرام', 'تلجرام', 'telegram'] },
    { reason: 'فيسبوك أو ماسنجر', words: ['facebook', 'messenger', 'فيسبوك', 'ماسنجر'] },
    { reason: 'إنستغرام أو سناب', words: ['instagram', 'انستا', 'إنستا', 'snapchat', 'سناب'] },
    { reason: 'بريد إلكتروني', words: ['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'gmail', 'hotmail', 'outlook', 'yahoo'] }
  ];
  for (const g of groups) {
    for (const w of g.words) {
      const wl = String(w).toLowerCase();
      const wc = normalizeChatText(w);
      if ((wl && lower.includes(wl)) || (wc && compact.includes(wc))) return g.reason;
    }
  }
  // [H1] أُثبت ديناميكياً (إرسال رسائل حقيقية لسيرفر يعمل فعلياً) أن substring
  // بلا حدود كلمة لـ"insta"/"t me"/"wa me"/"fb com" يصطاد كلمات إنجليزية عادية
  // شائعة الاستخدام بالمحادثة: "install"/"installment"/"Instapay" (طريقة دفع
  // أردنية حقيقية) عبر "insta"، و"chat me"/"text me"/"let me"/"meet me"/"at me"
  // عبر "t me" (compact يحذف كل المسافات فتتكوّن "tme" من كلمتين منفصلتين
  // تماماً). الحل: نفس الأنماط لكن بحدود كلمة صريحة (\b) — تصطاد فقط الرمز
  // المستقل فعلاً (مثل "insta" وحدها، أو "t"/"wa"/"fb" كتوكن منفصل تماماً قبل
  // مسافة أو نقطة ثم me/com) ولا تُصادف كلمة إنجليزية أطول تحوي نفس الحروف.
  // fb.../c0m: lower أعلاه يستبدل كل 'o' بـ'0' مسبقاً (لالتقاط أرقام هاتف
  // مكتوبة بحرف O بدل صفر) فـ"com" تصل هنا "c0m" دوماً.
  const boundaryChecks = [
    { reason: 'إنستغرام أو سناب', re: /\binsta\b/ },
    { reason: 'تيليجرام', re: /\bt[.\s]+me\b/ },
    { reason: 'واتساب', re: /\bwa[.\s]+me\b/ },
    { reason: 'فيسبوك أو ماسنجر', re: /\bfb[.\s]+c0m\b/ }
  ];
  for (const c of boundaryChecks) {
    if (c.re.test(lower)) return c.reason;
  }
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(original)) return 'بريد إلكتروني';
  // [H1] كانت أرقام الرسالة كلها (بصرف النظر عن موقعها بالجملة) تُلصَق ببعضها
  // كسلسلة واحدة قبل الفحص — أُثبت ديناميكياً أن رقمين غير مرتبطين بجملة
  // واحدة (مثل وقت الوصول "7" ورقم الباب "12345678"، أو رقم الطابق + رقم
  // الشقة + رقم الطلب) قد يتلاصقان مصادفة فيبدوان كرقم هاتف فتُرفض رسالة
  // عادية تماماً. الفحص الآن على مستوى "مقطع أرقام متصل" فعلي فقط (قد يحوي
  // مسافات/شرطات ضمنه فقط — كصيغة كتابة رقم هاتف حقيقي)، وليس كل أرقام
  // الرسالة مجتمعة. digitNormalized (تطبيع أرقام عربية/فارسية + O⇐0) قبل
  // الاستخراج حتى لا يُفقَد اصطياد رقم مموَّه بحرف O وسط تسلسل أرقام متصل.
  // ملاحظة: مقطع مستقل من 10 خانات فأكثر (بلا سياق) يبقى يُرفض عمداً — لا
  // يمكن تمييزه عن رقم هاتف حقيقي بلا صفر بداية، وهذا تحفّظ مقصود لا يجوز إضعافه.
  const digitNormalized = original
    .replace(/[٠-٩]/g, ch => String('٠١٢٣٤٥٦٧٨٩'.indexOf(ch)))
    .replace(/[۰-۹]/g, ch => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(ch)))
    .replace(/[oO]/g, '0');
  const numberRuns = digitNormalized.match(/\+?[0-9](?:[0-9\s-]*[0-9])?/g) || [];
  for (const run of numberRuns) {
    const cleaned = run.replace(/[\s-]/g, '');
    if (/^(\+?962|00962)?0?7[789]\d{7}$/.test(cleaned)) return 'رقم هاتف';
    if (cleaned.replace(/[^0-9]/g, '').length >= 10) return 'رقم هاتف';
  }
  return '';
}

module.exports = function (deps) {
  const { db } = deps;
  const { io, safeEmit } = deps.realtime;
  const { auth, requireRole, upload, uploadAudio } = deps.middleware;
  const { clean, getMessages, markChatRead, logAudit, canAccessRequestChat } = deps.utils;
  const { sendPush } = deps.services;
  const { messageLimiter, supportLimiter } = deps.limiters;
  const router = express.Router();

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
    return res.status(400).json({ error: '⚠️ الرسائل العادية مسموحة. الممنوع فقط مشاركة رقم هاتف أو واتساب أو تيليجرام أو إيميل أو روابط تواصل خارجية.', code: 'CHAT_MESSAGE_BLOCKED' });
  }

  router.post('/requests/:id/messages', auth, messageLimiter, (req, res) => {
    const r = db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'الطلب غير موجود', code: 'REQUEST_NOT_FOUND' });
    // [SEC-FIX-CHATSCOPE-01] راجع DECISIONS.md — كان يسمح لأي فني قدّم عرضاً
    // (بأي حالة، حتى مرفوض) بالوصول، لا الفني المؤكَّد فقط. الآن مطابق تماماً
    // لما تفترضه الواجهة أصلاً (لا شاشة تفتح الشات قبل قبول عرض).
    // [SEC-FIX-CHATSCOPE-03] راجع DECISIONS.md — دالة مشتركة مع services/socket.js.
    if (!canAccessRequestChat(req.user, r)) return res.status(403).json({ error: 'لا تملك صلاحية', code: 'AUTH_FORBIDDEN' });
    if (['مكتمل', 'ملغي'].includes(r.status) && req.user.role !== 'admin') return res.status(400).json({ error: 'لا يمكن إرسال رسائل على طلب مغلق', code: 'CHAT_ON_CLOSED_REQUEST' });
    if (req.user.role !== 'admin' && isBlockedEitherWay(req.user.id, getOtherPartyId(r, req.user.id))) {
      return res.status(403).json({ error: 'لا يمكنك إرسال رسائل — تم حظر التواصل بين الطرفين', code: 'CHAT_BLOCKED_BY_USER' });
    }
    const body = clean(req.body.body); if (body.length < 1) return res.status(400).json({ error: 'الرسالة فارغة', code: 'CHAT_MESSAGE_EMPTY' });
    if (body.length > 1000) return res.status(400).json({ error: 'الرسالة طويلة جداً، الحد الأقصى 1000 حرف', code: 'CHAT_MESSAGE_TOO_LONG' });
    // [SEC-FIX-C1] راجع التعليق فوق isSpoofedMediaBody أعلى الملف.
    if (isSpoofedMediaBody(body)) return res.status(400).json({ error: 'صيغة رسالة غير مسموحة', code: 'CHAT_SPOOFED_MEDIA' });
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

  // [PERF-HARDEN-02] كانت هذه بلا أي حد طلبات إطلاقاً — بعكس /messages
  // (messageLimiter) رغم أن كل تسجيل صوتي يُنفّذ نفس تكلفة رسالة نصية (كتابة
  // قرص + إدراج قاعدة بيانات + بث Socket.IO + إشعار Push) وأكثر (رفع ملف
  // فعلي). أُثبت هذا الغياب بمراجعة الكود مباشرة (audit إنتاجية 2026-07-19)،
  // وليس بحادثة فعلية — نفس الحد المطبَّق على الرسائل النصية بالضبط، بلا أي
  // تغيير على سلوك الاستخدام الطبيعي (30 رسالة/دقيقة بالإنتاج تكفي أي محادثة حقيقية).
  router.post('/requests/:id/audio', auth, messageLimiter, uploadAudio.single('audio'), (req, res) => {
    const r = db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'الطلب غير موجود', code: 'REQUEST_NOT_FOUND' });
    // [SEC-FIX-CHATSCOPE-01] راجع DECISIONS.md — كان يسمح لأي فني قدّم عرضاً
    // (بأي حالة، حتى مرفوض) بالوصول، لا الفني المؤكَّد فقط. الآن مطابق تماماً
    // لما تفترضه الواجهة أصلاً (لا شاشة تفتح الشات قبل قبول عرض).
    // [SEC-FIX-CHATSCOPE-03] راجع DECISIONS.md — دالة مشتركة مع services/socket.js.
    if (!canAccessRequestChat(req.user, r)) return res.status(403).json({ error: 'لا تملك صلاحية', code: 'AUTH_FORBIDDEN' });
    if (['مكتمل', 'ملغي'].includes(r.status) && req.user.role !== 'admin') return res.status(400).json({ error: 'لا يمكن إرسال رسائل على طلب مغلق', code: 'CHAT_ON_CLOSED_REQUEST' });
    if (req.user.role !== 'admin' && isBlockedEitherWay(req.user.id, getOtherPartyId(r, req.user.id))) {
      return res.status(403).json({ error: 'لا يمكنك إرسال رسائل — تم حظر التواصل بين الطرفين', code: 'CHAT_BLOCKED_BY_USER' });
    }
    if (!req.file) return res.status(400).json({ error: 'لم يتم استقبال التسجيل الصوتي', code: 'CHAT_AUDIO_NOT_RECEIVED' });
    const url = '/uploads/audios/' + req.file.filename;
    // [FIX-AUDIODUR-01] مدة التسجيل الفعلية بالثواني (يرسلها العميل — يعرفها
    // بدقة من مؤقّت التسجيل نفسه). اختيارية ومُتحقَّق منها: عدد صحيح موجب
    // ضمن حد معقول (10 دقائق)، وإلا تُهمَل بصمت بدل رفض الرفع كله لأجل حقل ثانوي.
    const durationRaw = parseInt(req.body.duration, 10);
    const duration = Number.isInteger(durationRaw) && durationRaw > 0 && durationRaw <= 600 ? durationRaw : null;
    const body = '[audio]' + url + (duration ? '|' + duration : '');
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
  // [PERF-HARDEN-02] نفس تعليق /requests/:id/audio أعلاه بالضبط — كانت بلا
  // أي حد طلبات، الآن نفس حد الرسائل النصية.
  router.post('/requests/:id/images', auth, messageLimiter, upload.single('image'), (req, res) => {
    const r = db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'الطلب غير موجود', code: 'REQUEST_NOT_FOUND' });
    // [SEC-FIX-CHATSCOPE-01] راجع DECISIONS.md — كان يسمح لأي فني قدّم عرضاً
    // (بأي حالة، حتى مرفوض) بالوصول، لا الفني المؤكَّد فقط. الآن مطابق تماماً
    // لما تفترضه الواجهة أصلاً (لا شاشة تفتح الشات قبل قبول عرض).
    // [SEC-FIX-CHATSCOPE-03] راجع DECISIONS.md — دالة مشتركة مع services/socket.js.
    if (!canAccessRequestChat(req.user, r)) return res.status(403).json({ error: 'لا تملك صلاحية', code: 'AUTH_FORBIDDEN' });
    if (['مكتمل', 'ملغي'].includes(r.status) && req.user.role !== 'admin') return res.status(400).json({ error: 'لا يمكن إرسال رسائل على طلب مغلق', code: 'CHAT_ON_CLOSED_REQUEST' });
    if (req.user.role !== 'admin' && isBlockedEitherWay(req.user.id, getOtherPartyId(r, req.user.id))) {
      return res.status(403).json({ error: 'لا يمكنك إرسال رسائل — تم حظر التواصل بين الطرفين', code: 'CHAT_BLOCKED_BY_USER' });
    }
    if (!req.file) return res.status(400).json({ error: 'لم يتم استقبال الصورة', code: 'CHAT_IMAGE_NOT_RECEIVED' });
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
    if (!r) return res.status(404).json({ error: 'الطلب غير موجود', code: 'REQUEST_NOT_FOUND' });
    // [SEC-FIX-CHATSCOPE-01] راجع DECISIONS.md — كان يسمح لأي فني قدّم عرضاً
    // (بأي حالة، حتى مرفوض) بالوصول، لا الفني المؤكَّد فقط. الآن مطابق تماماً
    // لما تفترضه الواجهة أصلاً (لا شاشة تفتح الشات قبل قبول عرض).
    // [SEC-FIX-CHATSCOPE-03] راجع DECISIONS.md — دالة مشتركة مع services/socket.js.
    if (!canAccessRequestChat(req.user, r)) return res.status(403).json({ error: 'لا تملك صلاحية', code: 'AUTH_FORBIDDEN' });
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
  // [SEC-FIX-SUPPORTSPAM-01] راجع DECISIONS.md — كان بلا أي حد طلبات، وبلا
  // فحص تكرار (نفس المستخدم يقدر يُبلّغ نفس الرسالة عشرات المرات، كل بلاغ
  // يُنشئ صفاً جديداً ويُطلق حدث Socket.IO منفصل لغرفة الأدمن).
  router.post('/requests/:id/report-message', auth, supportLimiter, (req, res) => {
    const r = db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'الطلب غير موجود', code: 'REQUEST_NOT_FOUND' });
    // [SEC-FIX-CHATSCOPE-01] راجع DECISIONS.md — كان يسمح لأي فني قدّم عرضاً
    // (بأي حالة، حتى مرفوض) بالوصول، لا الفني المؤكَّد فقط. الآن مطابق تماماً
    // لما تفترضه الواجهة أصلاً (لا شاشة تفتح الشات قبل قبول عرض).
    // [SEC-FIX-CHATSCOPE-03] راجع DECISIONS.md — دالة مشتركة مع services/socket.js.
    if (!canAccessRequestChat(req.user, r)) return res.status(403).json({ error: 'لا تملك صلاحية', code: 'AUTH_FORBIDDEN' });
    const messageId = parseInt(req.body.messageId, 10) || null;
    const reason = clean(req.body.reason);
    if (!reason || reason.length < 2) return res.status(400).json({ error: 'الرجاء اختيار سبب البلاغ', code: 'REPORT_REASON_REQUIRED' });
    if (reason.length > 200) return res.status(400).json({ error: 'سبب البلاغ طويل جداً', code: 'REPORT_REASON_TOO_LONG' });
    // [SEC-FIX-SUPPORTSPAM-01] فحص تكرار: نفس المستخدم لا يقدر يُبلّغ نفس
    // الرسالة (أو نفس الطلب عموماً لو messageId فارغ) مرتين. messageId يمكن
    // أن يكون NULL شرعياً (بلاغ عام على الطلب لا رسالة بعينها)، فـ`=?`
    // العادي لا يطابق NULL بـSQL — `IS` صريحة بدل `=` تتعامل مع الحالتين معاً.
    const existingReport = db.prepare(
      'SELECT id FROM message_reports WHERE request_id=? AND reporter_id=? AND message_id IS ?'
    ).get(r.id, req.user.id, messageId);
    if (existingReport) return res.status(409).json({ error: 'أبلغت عن هذا بالفعل، الإدارة تراجع بلاغك', code: 'REPORT_ALREADY_SUBMITTED' });
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
    if (!r) return res.status(404).json({ error: 'الطلب غير موجود', code: 'REQUEST_NOT_FOUND' });
    // [SEC-FIX-CHATSCOPE-01] راجع DECISIONS.md — كان يسمح لأي فني قدّم عرضاً
    // (بأي حالة، حتى مرفوض) بالوصول، لا الفني المؤكَّد فقط. الآن مطابق تماماً
    // لما تفترضه الواجهة أصلاً (لا شاشة تفتح الشات قبل قبول عرض).
    // [SEC-FIX-CHATSCOPE-03] راجع DECISIONS.md — دالة مشتركة مع services/socket.js.
    if (!canAccessRequestChat(req.user, r)) return res.status(403).json({ error: 'لا تملك صلاحية', code: 'AUTH_FORBIDDEN' });
    const otherPartyId = getOtherPartyId(r, req.user.id);
    if (!otherPartyId) return res.status(400).json({ error: 'لا يوجد طرف آخر لحظره بعد بهذا الطلب', code: 'CHAT_NO_OTHER_PARTY' });
    db.prepare('INSERT OR IGNORE INTO user_blocks(blocker_id,blocked_id) VALUES(?,?)').run(req.user.id, otherPartyId);
    res.json({ ok: true, blocked: true });
  });

  // [FIX-UGC-01] إلغاء حظر الطرف الآخر بهذا الطلب.
  // [SEC-FIX-BLOCKSCOPE-01] راجع DECISIONS.md — كان هذا المسار (وGET
  // /block-status أدناه) الوحيدين بهذا الملف بلا فحص canAccessRequestChat،
  // بعكس كل مسار آخر يخص محادثة طلب بعينه (بما فيها POST /block المجاور
  // مباشرة). getOtherPartyId ترجع customer_id افتراضياً لأي مستخدم لا علاقة
  // له بالطلب (الفرع "لا شيء" بالشرط الثلاثي)، فيقدر أي مستخدم مسجَّل دخول
  // يستهدف request_id عشوائياً ليس طرفاً فيه إطلاقاً.
  router.delete('/requests/:id/block', auth, (req, res) => {
    const r = db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'الطلب غير موجود', code: 'REQUEST_NOT_FOUND' });
    if (!canAccessRequestChat(req.user, r)) return res.status(403).json({ error: 'لا تملك صلاحية', code: 'AUTH_FORBIDDEN' });
    const otherPartyId = getOtherPartyId(r, req.user.id);
    if (otherPartyId) db.prepare('DELETE FROM user_blocks WHERE blocker_id=? AND blocked_id=?').run(req.user.id, otherPartyId);
    res.json({ ok: true, blocked: false });
  });

  // [FIX-UGC-01] هل أنا حاظر الطرف الآخر، أو هو حاظرني؟ (لعرض الحالة الصحيحة بالواجهة)
  // [SEC-FIX-BLOCKSCOPE-01] راجع DECISIONS.md وتعليق DELETE /block أعلاه —
  // نفس الثغرة بالضبط: بلا هذا الفحص، أي مستخدم مسجَّل دخول يقدر يكتشف
  // customer_id الحقيقي لأي طلب عشوائي (عبر otherUserId بالرد) وهل هناك
  // حظر قائم، رغم عدم كونه طرفاً بذلك الطلب إطلاقاً.
  router.get('/requests/:id/block-status', auth, (req, res) => {
    const r = db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'الطلب غير موجود', code: 'REQUEST_NOT_FOUND' });
    if (!canAccessRequestChat(req.user, r)) return res.status(403).json({ error: 'لا تملك صلاحية', code: 'AUTH_FORBIDDEN' });
    const otherPartyId = getOtherPartyId(r, req.user.id);
    if (!otherPartyId) return res.json({ blockedByMe: false, blockedMe: false, otherUserId: null });
    const blockedByMe = !!db.prepare('SELECT id FROM user_blocks WHERE blocker_id=? AND blocked_id=?').get(req.user.id, otherPartyId);
    const blockedMe = !!db.prepare('SELECT id FROM user_blocks WHERE blocker_id=? AND blocked_id=?').get(otherPartyId, req.user.id);
    res.json({ blockedByMe, blockedMe, otherUserId: Number(otherPartyId) });
  });

  router.get('/chat-violations', auth, requireRole('admin'), (req, res) => {
    // [FIX-MODERATION-01] v.* الآن يتضمّن v.status (حالة متابعة المخالفة نفسها،
    // العمود الجديد) — لازم تسمية صريحة لـr.status (حالة الطلب) حتى لا يبتلع
    // أحدهما الآخر بصمت بنفس اسم الحقل بالنتيجة النهائية (كلاهما اسمه status).
    const rows = db.prepare(`SELECT v.*,u.name user_name,u.email user_email,r.service,r.status request_status FROM chat_violations v LEFT JOIN users u ON u.id=v.user_id LEFT JOIN requests r ON r.id=v.request_id ORDER BY v.id DESC LIMIT 200`).all();
    res.json({ violations: rows });
  });

  // [FIX-MODERATION-01] تحديث حالة متابعة مخالفة شات — نفس نمط complaints/:id/status
  // تماماً. لا تحذف أي محتوى ولا تحظر أي حساب من هنا؛ فقط توثّق أن الأدمن راجعها.
  router.post('/chat-violations/:id/status', auth, requireRole('admin'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صحيح', code: 'INVALID_ID' });
    const status = clean(req.body.status || '');
    const allowed = ['مفتوح', 'تمت المراجعة', 'تم اتخاذ إجراء'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'حالة غير صحيحة', code: 'STATUS_INVALID' });
    const existing = db.prepare('SELECT id FROM chat_violations WHERE id=?').get(id);
    if (!existing) return res.status(404).json({ error: 'المخالفة غير موجودة', code: 'VIOLATION_NOT_FOUND' });
    db.prepare('UPDATE chat_violations SET status=? WHERE id=?').run(status, id);
    logAudit({
      adminId: req.user.id, actorName: req.user.name,
      action: 'تحديث حالة مخالفة شات', targetType: 'chat_violation', targetId: id,
      details: { status }
    });
    res.json({ ok: true, violation: db.prepare('SELECT * FROM chat_violations WHERE id=?').get(id) });
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

  // [FIX-MODERATION-01] تحديث حالة متابعة بلاغ رسالة — الجدول أصلاً فيه عمود
  // status ('قيد المراجعة' افتراضياً) لم يكن أي مسار يحدّثه إطلاقاً.
  router.post('/message-reports/:id/status', auth, requireRole('admin'), (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'معرّف غير صحيح', code: 'INVALID_ID' });
    const status = clean(req.body.status || '');
    const allowed = ['قيد المراجعة', 'تم اتخاذ إجراء', 'مرفوض'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'حالة غير صحيحة', code: 'STATUS_INVALID' });
    const existing = db.prepare('SELECT id FROM message_reports WHERE id=?').get(id);
    if (!existing) return res.status(404).json({ error: 'البلاغ غير موجود', code: 'REPORT_NOT_FOUND' });
    db.prepare('UPDATE message_reports SET status=? WHERE id=?').run(status, id);
    logAudit({
      adminId: req.user.id, actorName: req.user.name,
      action: 'تحديث حالة بلاغ رسالة', targetType: 'message_report', targetId: id,
      details: { status }
    });
    res.json({ ok: true, report: db.prepare('SELECT * FROM message_reports WHERE id=?').get(id) });
  });

  // V13 chats center and support center
  // [PERF-HARDEN-02] بلا سقف سابقاً — كل صف يُنفّذ 3 استعلامات فرعية مترابطة
  // (آخر رسالة، وقتها، وعدد غير المقروء عبر LEFT JOIN+COUNT) لكل طلب يخص هذا
  // المستخدم. سقف 1000 وقائي بحت (لا يوجد سيناريو واقعي حالي فيه أكثر من 1000
  // محادثة لمستخدم واحد) بنفس نمط GET /technicians و/admin/users تماماً —
  // ORDER BY آخر نشاط DESC يضمن بقاء المحادثات الأحدث (وأي رسالة غير مقروءة
  // منطقياً حديثة) ضمن النطاق المُرجَع دائماً.
  router.get('/chats', auth, (req, res) => {
    let rows = [];
    if (req.user.role === 'customer') {
      rows = db.prepare(`SELECT r.id request_id,r.service,r.status,u.name other_name,
        (SELECT body FROM messages WHERE request_id=r.id ORDER BY id DESC LIMIT 1) last_body,
        (SELECT created_at FROM messages WHERE request_id=r.id ORDER BY id DESC LIMIT 1) last_at,
        (SELECT COUNT(*) FROM messages m LEFT JOIN chat_reads cr ON cr.request_id=m.request_id AND cr.user_id=? WHERE m.request_id=r.id AND m.sender_id<>? AND m.id>COALESCE(cr.last_read_message_id,0)) unread_count
        FROM requests r LEFT JOIN users u ON u.id=r.technician_id
        WHERE r.customer_id=? AND (r.technician_id IS NOT NULL OR EXISTS(SELECT 1 FROM messages m WHERE m.request_id=r.id))
        ORDER BY COALESCE(last_at,r.created_at) DESC LIMIT 1000`).all(req.user.id, req.user.id, req.user.id);
    } else if (req.user.role === 'technician') {
      rows = db.prepare(`SELECT r.id request_id,r.service,r.status,u.name other_name,
        (SELECT body FROM messages WHERE request_id=r.id ORDER BY id DESC LIMIT 1) last_body,
        (SELECT created_at FROM messages WHERE request_id=r.id ORDER BY id DESC LIMIT 1) last_at,
        (SELECT COUNT(*) FROM messages m LEFT JOIN chat_reads cr ON cr.request_id=m.request_id AND cr.user_id=? WHERE m.request_id=r.id AND m.sender_id<>? AND m.id>COALESCE(cr.last_read_message_id,0)) unread_count
        FROM requests r JOIN users u ON u.id=r.customer_id
        WHERE r.technician_id=? OR EXISTS(SELECT 1 FROM offers o WHERE o.request_id=r.id AND o.technician_id=?)
        ORDER BY COALESCE(last_at,r.created_at) DESC LIMIT 1000`).all(req.user.id, req.user.id, req.user.id, req.user.id);
    }
    const total = rows.reduce((a, b) => a + Number(b.unread_count || 0), 0);
    res.json({ chats: rows, total_unread: total });
  });

  return router;
};
