// utils/notification.js
// دالة موحّدة لإدراج إشعار دائم بقاعدة البيانات. Factory تاخد db بدل ما تعمل
// require لـconfig/db مباشرة — نفس نمط utils/db-helpers.js بالضبط (يمنع أي
// require دائري).
//
// [NOTIF-PHASE1] هاي طبقة التخزين (persistence) فقط. لا تبعث أي Socket.IO
// event ولا أي Push حقيقي، ولا تستبدل أي من ذلك — القنوات الحيّة الحالية
// (io.to(...).emit(...) المباشر بكل route، وsendPush بـservices/push.js)
// تبقى تماماً كما هي بدون أي تعديل بهذه المرحلة. notify() فقط تضيف نسخة
// دائمة بقاعدة البيانات يقدر المستخدم يشوفها لاحقاً (عبر endpoint قادم
// بمرحلة تالية) حتى لو فاته الحدث اللحظي (كان offline أو socket مقطوع وقتها).
// الربط الفعلي لاستدعاء notify() من داخل الـroutes، وربطها بالـsocket/push،
// كلاهما خارج نطاق هذه المرحلة عمداً.

function createNotificationHelper(db) {
  const insertStmt = db.prepare(`
    INSERT INTO notifications(user_id,type,title,body,data,request_id,ticket_id)
    VALUES(?,?,?,?,?,?,?)
  `);

  // notify({ userId, type, title, body, data, requestId, ticketId })
  // يرجع id الصف المُدرَج، أو null لو فشل الإدراج (لا يرمي استثناءً — استدعاء
  // إشعار فاشل لا يجوز أن يُسقط العملية الأصلية التي استدعته، بنفس فلسفة
  // logAudit بـutils/db-helpers.js تماماً).
  function notify({ userId, type, title, body, data = null, requestId = null, ticketId = null } = {}) {
    const uid = Number(userId);
    if (!Number.isFinite(uid) || uid <= 0) return null;
    const notifType = String(type || '').trim();
    if (!notifType) return null;
    const notifTitle = String(title || '').trim();
    if (!notifTitle) return null;
    const notifBody = body == null ? null : String(body);
    const dataStr = data == null ? null : (typeof data === 'string' ? data : JSON.stringify(data));
    const reqId = requestId == null || requestId === '' ? null : (Number.isFinite(Number(requestId)) ? Number(requestId) : null);
    const tkId = ticketId == null || ticketId === '' ? null : (Number.isFinite(Number(ticketId)) ? Number(ticketId) : null);

    try {
      const info = insertStmt.run(uid, notifType, notifTitle, notifBody, dataStr, reqId, tkId);
      return info.lastInsertRowid;
    } catch (e) {
      console.error('notify() failed:', e.message);
      return null;
    }
  }

  return { notify };
}

module.exports = { createNotificationHelper };
