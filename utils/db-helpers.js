// utils/db-helpers.js
// دوال مساعدة بتحتاج db. منعملها factory حتى ما في أي require دائري
// (هالملف ما بعمل require لأي route أو لـ config/db مباشرة، الـ db بتنمرر له).

// [PERF-05] bcryptjs -> bcrypt (native) — see routes/auth.routes.js. This
// file's only use (anonymizeUser) is a throwaway low-cost hash never checked
// against a real login; hashSync() signature is identical either way.
const bcrypt = require('bcrypt');
// [SEC-FIX-CHATACCESS-CHOKEPOINT-01] راجع DECISIONS.md — utils/helpers.js لا
// تعتمد على db/io إطلاقاً (موثَّق بأعلاها)، فـrequire هنا آمن بلا أي دورة
// اعتماد (helpers.js نفسها لا تستورد db-helpers.js).
const { canAccessRequestChat } = require('./helpers');
const { ForbiddenError } = require('./errors');

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

  // [SEC-FIX-CHATACCESS-CHOKEPOINT-01] راجع DECISIONS.md — هذه الدالة كانت
  // (ولا تزال) نقطة الوصول الوحيدة الفعلية لقراءة محتوى محادثة طلب بعينه
  // بكامله (raise/تحقُّق مباشر: لا استعلام آخر بكل المشروع يجلب صفوف messages
  // كاملة بهذا الشكل). لكنها كانت تثق بالمُستدعي تماماً لفحص canAccessRequestChat
  // *قبل* استدعائها — لا شيء كان يمنع موقع استدعاء مستقبلي من نسيان ذلك الفحص.
  // الآن تفرض الفحص داخلياً بنفسها (تجلب الطلب، تتحقق، ترمي ForbiddenError لو
  // رُفض) — طبقة دفاع مستقلة لا تعتمد على انضباط أي مُستدعٍ، حالي أو مستقبلي.
  // مواقع الاستدعاء الأربعة الحالية بـroutes/chat.routes.js تبقي فحصها الصريح
  // المسبق كما هو (يحمي أيضاً عمليات جانبية سابقة كإدراج رسالة/بث Socket.IO —
  // هذا الفحص الداخلي إضافي، لا بديل عنه).
  // [FEAT-CHATPAGINATION-01] راجع DECISIONS.md — options اختياري تماماً؛ بلا
  // تمريره (كل مواقع الاستدعاء الأربعة الحالية بـroutes/chat.routes.js، وأي
  // نسخة تطبيق مثبَّتة سابقاً لهذا الإصلاح) السلوك القديم حرفياً بلا أي تغيير:
  // كل رسائل الطلب دفعة واحدة، تصاعدياً. limit موجود فقط يُفعِّل صفحة محدودة
  // الحجم (آخر limit رسالة قبل beforeId، أو الأحدث إطلاقاً بلا beforeId) —
  // تُعاد النتيجة تصاعدياً دائماً بغض النظر عن استخدام limit، فلا يحتاج أي
  // مُستهلِك (حالي أو جديد) معرفة اتجاه فرز مختلف حسب المسار المُستخدَم.
  function getMessages(user, requestId, options = {}) {
    const { limit, beforeId } = options;
    const request = db.prepare('SELECT * FROM requests WHERE id=?').get(requestId);
    if (!canAccessRequestChat(user, request)) throw new ForbiddenError();
    let msgs;
    if (limit) {
      const params = [requestId];
      let query = 'SELECT m.*,u.name sender_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE request_id=?';
      if (beforeId) { query += ' AND m.id<?'; params.push(Number(beforeId)); }
      query += ' ORDER BY m.id DESC LIMIT ?';
      params.push(Number(limit));
      msgs = db.prepare(query).all(...params).reverse();
    } else {
      msgs = db.prepare('SELECT m.*,u.name sender_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE request_id=? ORDER BY id').all(requestId);
    }
    // أعلى رقم رسالة قرأها أي طرف آخر في هذا الطلب (لإظهار "تمت المشاهدة")
    const reads = db.prepare('SELECT user_id, last_read_message_id FROM chat_reads WHERE request_id=?').all(requestId);
    msgs.forEach(m => {
      // الرسالة تُعتبر "تمت مشاهدتها" إذا قرأها طرف غير المُرسِل
      m.seen = reads.some(r => r.user_id !== m.sender_id && Number(r.last_read_message_id) >= Number(m.id)) ? 1 : 0;
    });
    return msgs;
  }

  // [SEC-FIX-CHATACCESS-CHOKEPOINT-01] راجع DECISIONS.md — طبقة دفاع ثانية
  // مستقلة عن جملة WHERE بـgetChatsList أدناه: تُعيد استخدام نفس
  // canAccessRequestChat الحقيقية المستخدَمة بكل مكان آخر بالمشروع (لا نسخة
  // SQL موازية منها قد تنحرف عنها مستقبلاً — بالضبط ما حدث فعلياً بـ
  // SEC-FIX-CHATSCOPE-04)، بدل الاعتماد فقط على جملة WHERE. دالة صرفة مصدَّرة
  // بشكل منفصل لتمكين اختبارها مباشرة بمعزل عن قاعدة بيانات حقيقية.
  function filterChatRowsForUser(rows, user) {
    return rows.filter(row => canAccessRequestChat(user, { customer_id: row.customer_id, technician_id: row.technician_id }));
  }

  // [SEC-FIX-CHATACCESS-CHOKEPOINT-01] راجع DECISIONS.md — كانت هذه الاستعلامات
  // مكتوبة مباشرة بـrouter.get('/chats', ...) بـroutes/chat.routes.js، مكرَّرة
  // منطقياً مرتين (عميل/فني) بلا أي طبقة تحقق مستقلة عن جملة WHERE نفسها —
  // بالضبط الموقع الذي ظهرت به SEC-FIX-CHATSCOPE-04 سابقاً. نُقلت هنا لتصبح
  // بجوار getMessages (نفس الملف = نفس نقطة الوصول الوحيدة لأي محتوى محادثة)،
  // مع طبقة دفاع ثانية عبر filterChatRowsForUser أعلاه.
  function getChatsList(user) {
    let rows = [];
    if (user.role === 'customer') {
      rows = db.prepare(`SELECT r.id request_id,r.service,r.status,r.customer_id,r.technician_id,u.name other_name,
        (SELECT body FROM messages WHERE request_id=r.id ORDER BY id DESC LIMIT 1) last_body,
        (SELECT created_at FROM messages WHERE request_id=r.id ORDER BY id DESC LIMIT 1) last_at,
        (SELECT COUNT(*) FROM messages m LEFT JOIN chat_reads cr ON cr.request_id=m.request_id AND cr.user_id=? WHERE m.request_id=r.id AND m.sender_id<>? AND m.id>COALESCE(cr.last_read_message_id,0)) unread_count
        FROM requests r LEFT JOIN users u ON u.id=r.technician_id
        WHERE r.customer_id=? AND (r.technician_id IS NOT NULL OR EXISTS(SELECT 1 FROM messages m WHERE m.request_id=r.id))
        ORDER BY COALESCE(last_at,r.created_at) DESC LIMIT 1000`).all(user.id, user.id, user.id);
    } else if (user.role === 'technician') {
      rows = db.prepare(`SELECT r.id request_id,r.service,r.status,r.customer_id,r.technician_id,u.name other_name,
        (SELECT body FROM messages WHERE request_id=r.id ORDER BY id DESC LIMIT 1) last_body,
        (SELECT created_at FROM messages WHERE request_id=r.id ORDER BY id DESC LIMIT 1) last_at,
        (SELECT COUNT(*) FROM messages m LEFT JOIN chat_reads cr ON cr.request_id=m.request_id AND cr.user_id=? WHERE m.request_id=r.id AND m.sender_id<>? AND m.id>COALESCE(cr.last_read_message_id,0)) unread_count
        FROM requests r JOIN users u ON u.id=r.customer_id
        WHERE r.technician_id=?
        ORDER BY COALESCE(last_at,r.created_at) DESC LIMIT 1000`).all(user.id, user.id, user.id);
    }
    rows = filterChatRowsForUser(rows, user);
    const total = rows.reduce((a, b) => a + Number(b.unread_count || 0), 0);
    // customer_id/technician_id أُضيفا للـSELECT فقط لتمكين الفلتر أعلاه — لم
    // يكونا جزءاً من شكل الاستجابة السابق لهذا الـendpoint، فيُحذفان قبل
    // الإرجاع حتى لا يتغيّر شكل الاستجابة للعميل بلا داعٍ.
    rows.forEach(row => { delete row.customer_id; delete row.technician_id; });
    return { chats: rows, total_unread: total };
  }

  // [SEC-FIX-CHATACCESS-CHOKEPOINT-01] راجع DECISIONS.md — نُقلت من داخل
  // router.post('/requests/:id/report-message', ...) لنفس سبب getChatsList
  // أعلاه (نقطة وصول واحدة لأي قراءة محتوى من جدول messages). لا فحص صلاحية
  // داخلي هنا عمداً: المُستدعي الوحيد الحالي (نفس الراوت) يتحقق من
  // canAccessRequestChat على الطلب الأب *قبل* الوصول لهذا السطر أصلاً، وmessageId
  // مقيَّد بـrequestId بجملة WHERE نفسها (لا تسرّب عبر طلب آخر بأي حال حتى بلا
  // ذلك الفحص). موقع استدعاء مستقبلي يحتاج نفس الضمان الذي توفره getMessages
  // (فحص مستقل عن انضباط المُستدعي) يجب أن يستخدم تلك الدالة بدل هذه.
  function getMessageForReport(requestId, messageId) {
    return db.prepare('SELECT * FROM messages WHERE id=? AND request_id=?').get(messageId, requestId);
  }

  // [FEAT-CHATPAGINATION-01] راجع DECISIONS.md — ترجع last الآن (كانت بلا
  // قيمة إرجاع) حتى يقدر المُستدعي (GET /requests/:id/messages) بث حدث
  // messages-seen المضغوط بلا استعلام إضافي لنفس القيمة التي حسبتها هذه
  // الدالة للتو. لا تغيير على أي مُستدعٍ حالي — كلهم يتجاهلون القيمة المُعادة
  // أصلاً (جافاسكربت لا يفرض استهلاك قيمة إرجاع دالة).
  function markChatRead(requestId, userId) {
    const row = db.prepare('SELECT COALESCE(MAX(id),0) max_id FROM messages WHERE request_id=?').get(requestId);
    const last = Number(row?.max_id || 0);
    db.prepare(`INSERT INTO chat_reads(request_id,user_id,last_read_message_id,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(request_id,user_id) DO UPDATE SET last_read_message_id=excluded.last_read_message_id, updated_at=CURRENT_TIMESTAMP`).run(requestId, userId, last);
    return last;
  }

  // يسجّل فعل إداري بجدول audit_logs. details ممكن يكون نص أو كائن (بيتحوّل لـ JSON تلقائياً).
  function logAudit({ adminId, actorName, action, targetType = null, targetId = null, details = null }) {
    try {
      const detailsStr = details == null ? null : (typeof details === 'string' ? details : JSON.stringify(details));
      db.prepare('INSERT INTO audit_logs(admin_id,actor_name,action,target_type,target_id,details) VALUES(?,?,?,?,?,?)')
        .run(adminId || null, actorName || 'النظام', action, targetType, targetId || null, detailsStr);
    } catch (e) { console.error('audit log failed:', e.message); }
  }

  return {
    calcRating, getMessages, markChatRead, logAudit, anonymizeUser,
    getChatsList, getMessageForReport,
    // [SEC-FIX-CHATACCESS-CHOKEPOINT-01] مصدَّرة أساساً لتمكين اختبارها مباشرة
    // بمعزل عن قاعدة بيانات حقيقية (تنتهي أيضاً بـdeps.utils عبر spread
    // server.js المعتاد — بلا ضرر، لا راوت يستخدمها مباشرة اليوم).
    filterChatRowsForUser,
  };
}

module.exports = { createDbHelpers };
