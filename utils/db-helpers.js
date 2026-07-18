// utils/db-helpers.js
// دوال مساعدة بتحتاج db. منعملها factory حتى ما في أي require دائري
// (هالملف ما بعمل require لأي route أو لـ config/db مباشرة، الـ db بتنمرر له).

const bcrypt = require('bcryptjs');

function createDbHelpers(db) {
  // [FIX-DELETE-CRASH-01] راجع DECISIONS.md — القرار الموثَّق كان "حذف فعلي
  // للمستخدم، مع إبقاء السجلات التاريخية (requests/offers/messages/ratings/
  // ledger/topups...) يتيمة (customer_id/technician_id يشير لمستخدم لم يعد
  // موجوداً)". هذا كان يعمل فقط لأن قيود FOREIGN KEY لم تكن مُفعَّلة فعلياً.
  // بعد ترقية better-sqlite3 (يُفعِّل foreign_keys افتراضياً)، أي DELETE FROM
  // users لأي حساب له سجل واحد فعلي بأي من الجداول المرتبطة فعلياً بمفتاح
  // خارجي حقيقي (topups.technician_id، requests.customer_id/technician_id،
  // offers.technician_id، support_tickets.user_id، support_messages.sender_id
  // — كلها NOT NULL تقريباً) يفشل بـ"FOREIGN KEY constraint failed"، وبما أن
  // /me كانت async بلا try/catch، هذا الاستثناء كان يُسقط العملية بأكملها
  // (Node يُنهي نفسه تلقائياً عند unhandled rejection).
  //
  // الحل المطبَّق هنا يحقق نفس هدف القرار الأصلي بالضبط (إزالة أي بيانات
  // شخصية تعرّف صاحب الحساب، مع الحفاظ الكامل على كل السجلات التاريخية/
  // المالية الحقيقية بلا حذف أو تغيير) لكن بآلية متوافقة مع تفعيل FOREIGN
  // KEY: بدل حذف صف users نفسه (مستحيل الآن دون كسر القيد)، يُعاد كتابته في
  // مكانه — يبقى موجوداً (فلا ينكسر أي FOREIGN KEY ولا أي JOIN حالي بالكود)،
  // لكن كل حقل يعرّف صاحبه فعلياً يُصفَّى بشكل لا رجعة فيه، ويُبطَل تسجيل
  // الدخول والتوكنات القائمة فوراً. البريد/الهاتف يُستبدَلان بقيمة فريدة
  // مبنية على id نفسه لضمان عدم تعارضها مع قيد UNIQUE.
  function anonymizeUser(id) {
    const randomHash = bcrypt.hashSync(
      `deleted-${id}-${Date.now()}-${Math.random()}`,
      4, // لا حاجة لتكلفة حوسبة عالية — هذا الهاش لا يُفترض أن يطابق أي كلمة سر حقيقية إطلاقاً
    );
    db.prepare(`
      UPDATE users SET
        name = 'مستخدم محذوف',
        email = ?,
        phone = ?,
        password_hash = ?,
        national_number = NULL,
        avatar_url = NULL,
        city = NULL,
        areas = NULL,
        services = NULL,
        fcm_token = NULL,
        is_active = 0,
        token_version = token_version + 1,
        deleted_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(`deleted-user-${id}@deleted.local`, `deleted-user-${id}`, randomHash, id);
  }

  function calcRating(techId) {
    const r = db.prepare('SELECT AVG(stars) avg, COUNT(*) c FROM ratings WHERE technician_id=?').get(techId);
    db.prepare('UPDATE users SET rating_avg=?, rating_count=? WHERE id=?').run(Number(r.avg || 0).toFixed(2), r.c || 0, techId);
  }

  function getMessages(requestId) {
    const msgs = db.prepare('SELECT m.*,u.name sender_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE request_id=? ORDER BY id').all(requestId);
    // أعلى رقم رسالة قرأها أي طرف آخر في هذا الطلب (لإظهار "تمت المشاهدة")
    const reads = db.prepare('SELECT user_id, last_read_message_id FROM chat_reads WHERE request_id=?').all(requestId);
    msgs.forEach(m => {
      // الرسالة تُعتبر "تمت مشاهدتها" إذا قرأها طرف غير المُرسِل
      m.seen = reads.some(r => r.user_id !== m.sender_id && Number(r.last_read_message_id) >= Number(m.id)) ? 1 : 0;
    });
    return msgs;
  }

  function markChatRead(requestId, userId) {
    const row = db.prepare('SELECT COALESCE(MAX(id),0) max_id FROM messages WHERE request_id=?').get(requestId);
    const last = Number(row?.max_id || 0);
    db.prepare(`INSERT INTO chat_reads(request_id,user_id,last_read_message_id,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(request_id,user_id) DO UPDATE SET last_read_message_id=excluded.last_read_message_id, updated_at=CURRENT_TIMESTAMP`).run(requestId, userId, last);
  }

  // يسجّل فعل إداري بجدول audit_logs. details ممكن يكون نص أو كائن (بيتحوّل لـ JSON تلقائياً).
  function logAudit({ adminId, actorName, action, targetType = null, targetId = null, details = null }) {
    try {
      const detailsStr = details == null ? null : (typeof details === 'string' ? details : JSON.stringify(details));
      db.prepare('INSERT INTO audit_logs(admin_id,actor_name,action,target_type,target_id,details) VALUES(?,?,?,?,?,?)')
        .run(adminId || null, actorName || 'النظام', action, targetType, targetId || null, detailsStr);
    } catch (e) { console.error('audit log failed:', e.message); }
  }

  return { calcRating, getMessages, markChatRead, logAudit, anonymizeUser };
}

module.exports = { createDbHelpers };
