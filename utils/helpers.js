// utils/helpers.js
// دوال مساعدة عامة، ما بتعتمد على db أو io — آمنة تستدعيها من أي مكان.

const path = require('path');
const crypto = require('crypto');

// [SEC-FIX-05] Escape LIKE wildcards to prevent unintended wildcard matching
function escapeLike(str) { return String(str || '').replace(/[%_\\]/g, c => '\\' + c); }

function hasSafeExt(file, allowedExts) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  return allowedExts.includes(ext);
}

function safeUploadName(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  return Date.now() + '-' + crypto.randomBytes(8).toString('hex') + ext;
}

function clean(s) { return String(s || '').trim(); }

function userPublic(u) {
  if (!u) return null;
  // [SEC-FIX-09] token_version تفصيل داخلي لآلية إبطال الجلسات، لا فائدة منه
  // للعميل ولا يجوز تسريبه بأي استجابة تحتوي بيانات المستخدم.
  const { password_hash, token_version, ...x } = u;
  return x;
}

// [SEC-FIX-CHATSCOPE-03] راجع DECISIONS.md — دالة وحدة تستخدمها REST
// (routes/chat.routes.js) وSocket.IO (services/socket.js) لنفس القرار:
// هل يقدر هذا المستخدم يشارك بمحادثة هذا الطلب؟ كانت هذه القاعدة مكتوبة
// مرتين بشكل منفصل، وانحرفت فعلياً مرتين ([SEC-FIX-CHATSCOPE-01] ثم
// [SEC-FIX-CHATSCOPE-02]) لأن تعديل نسخة لا يضمن تعديل الأخرى. دالة واحدة
// تمنع فئة الخطأ بالكامل بدل تصحيح كل حادثة على حدة. مقصورة على الفني
// المؤكَّد (request.technician_id) أو العميل صاحب الطلب أو الأدمن — لا
// تشمل فنياً بعرض pending/rejected بأي حال.
function canAccessRequestChat(user, request) {
  if (!user || !request) return false;
  return user.role === 'admin' ||
    Number(user.id) === Number(request.customer_id) ||
    (request.technician_id != null && Number(user.id) === Number(request.technician_id));
}

// [SEC-FIX-COORDMASK-01] راجع DECISIONS.md — قرار منتج: فني قدّم عرضاً (حتى
// لو لم يُقبَل بعد، أو يتصفح فقط بلا أي عرض) يرى مدينة/منطقة الطلب فقط، لا
// إحداثيات lat/lng الدقيقة لبيت الزبون — تلك تظهر فقط بعد أن يصبح الفني
// المؤكَّد فعلياً (عرضه مقبول، request.technician_id يطابق معرّفه). دالة صرفة
// واحدة تُستدعى من كل نقطة تُعيد بيانات طلب لفني، بدل تكرار نفس الشرط يدوياً
// بكل مكان — نفس درس SEC-FIX-CHATSCOPE-03 بالضبط (نسخة مكرَّرة يدوياً انحرفت
// مرتين سابقاً لأن تعديل واحدة لا يضمن تعديل الأخرى). لا تُستدعى إطلاقاً لعميل/
// أدمن (يرون الإحداثيات دائماً) — الاستدعاء نفسه محصور على فروع الفني فقط،
// فالدالة لا تحتاج معرفة دور المُستدعي. تُعيد نسخة سطحية جديدة (لا تُعدِّل
// الكائن الأصلي) — الكائن المصدر قد يُستخدَم لبث/استجابات أخرى لأطراف تستحق
// رؤية الإحداثيات الكاملة (العميل، الفني المؤكَّد، الأدمن) بنفس اللحظة.
function maskCoordsUnlessConfirmedTechnician(request, technicianId) {
  if (!request) return request;
  if (request.technician_id != null && Number(request.technician_id) === Number(technicianId)) return request;
  return { ...request, lat: null, lng: null };
}

module.exports = { escapeLike, hasSafeExt, safeUploadName, clean, userPublic, canAccessRequestChat, maskCoordsUnlessConfirmedTechnician };
