// routes/meta.routes.js — /api/meta, /api/payment-methods
const express = require('express');

// [PERF-METACACHE-01] راجع scripts/loadtest/report.md — اختبار حمل حقيقي على
// الإنتاج (autocannon من جهاز خارجي، لا محاكاة محلية) أظهر أول إشارة تعب
// واضحة (p97.5 يقفز من 810ms إلى 1934ms) عند 200 اتصال متزامن على هذا
// المسار تحديداً، رغم إنه أبسط مسار بالتطبيق (لا مصادقة، استعلامان فقط).
// السبب: كل طلب يعيد نفس استعلامَي service_categories/packages بالضبط —
// بيانات لا تتغيّر إلا يدوياً من الأدمن (إضافة/تعديل خدمة أو باقة)، لا مع كل
// طلب مستخدم. تخزين مؤقت بالذاكرة (60 ثانية) يُسقط هذين الاستعلامين لمعظم
// الطلبات تماماً — أسوأ حالة: تأخّر ظهور خدمة/باقة جديدة أضافها الأدمن حتى
// دقيقة واحدة، مقبول جداً مقابل التخفيف عن الخادم. لا علاقة لهذا بـcities
// (مصفوفة ثابتة أصلاً بالكود، لا تُقرأ من قاعدة البيانات).
const META_CACHE_TTL_MS = 60 * 1000;
let metaCache = null;
let metaCacheAt = 0;

// [PERF-METACACHE-01] يُستدعى من routes/admin.routes.js فور أي تعديل فعلي
// على service_categories أو packages (إضافة/تعديل/حذف/تفعيل-تعطيل) — بدون
// هذا، تعديل أدمن حقيقي كان سيبقى غير ظاهر للمستخدمين حتى انتهاء TTL (حتى
// 60 ثانية)، بدل الفورية المتوقَّعة من أي إجراء أدمن. الاعتماد على TTL وحده
// كافٍ فقط للتخفيف عن القراءة المتكررة، لا لصحة الفورية بعد كتابة فعلية —
// هذا الاستدعاء الصريح هو ما يضمن الفورية.
function invalidateMetaCache() {
  metaCache = null;
}

module.exports = function (deps) {
  const { db } = deps;
  const { auth, requireRole } = deps.middleware;
  const router = express.Router();

  router.get('/meta', (req, res) => {
    const now = Date.now();
    if (metaCache && (now - metaCacheAt) < META_CACHE_TTL_MS) {
      return res.json(metaCache);
    }
    metaCache = {
      // [FIX-SERVICES-01] فقط المهن الفعّالة تظهر للتسجيل/إنشاء الطلبات —
      // هذا الفلتر بالضبط هو الفرق بين "موجودة بالقاعدة" و"ظاهرة للمستخدم".
      services: db.prepare('SELECT * FROM service_categories WHERE is_active=1 ORDER BY name').all(),
      packages: db.prepare('SELECT id,name,amount,bonus FROM packages WHERE is_active=1 ORDER BY amount').all(),
      cities: ['عمان','الزرقاء','إربد','البلقاء','المفرق','جرش','عجلون','مادبا','الكرك','الطفيلة','معان','العقبة']
    };
    metaCacheAt = now;
    res.json(metaCache);
  });

  // Payment methods only returned to authenticated technicians
  router.get('/payment-methods', auth, requireRole('technician'), (req, res) => {
    res.json({ paymentMethods: db.prepare('SELECT * FROM payment_methods').all() });
  });

  return router;
};

module.exports.invalidateMetaCache = invalidateMetaCache;
