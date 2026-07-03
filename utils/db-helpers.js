// utils/db-helpers.js
// دوال مساعدة بتحتاج db. منعملها factory حتى ما في أي require دائري
// (هالملف ما بعمل require لأي route أو لـ config/db مباشرة، الـ db بتنمرر له).

function createDbHelpers(db) {
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

  return { calcRating, getMessages, markChatRead };
}

module.exports = { createDbHelpers };
