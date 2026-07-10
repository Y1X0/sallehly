// routes/meta.routes.js — /api/meta, /api/payment-methods
const express = require('express');

module.exports = function (deps) {
  const { db } = deps;
  const { auth, requireRole } = deps.middleware;
  const router = express.Router();

  router.get('/meta', (req, res) => {
    res.json({
      // [FIX-SERVICES-01] فقط المهن الفعّالة تظهر للتسجيل/إنشاء الطلبات —
      // هذا الفلتر بالضبط هو الفرق بين "موجودة بالقاعدة" و"ظاهرة للمستخدم".
      services: db.prepare('SELECT * FROM service_categories WHERE is_active=1 ORDER BY name').all(),
      packages: db.prepare('SELECT id,name,amount,bonus FROM packages WHERE is_active=1 ORDER BY amount').all(),
      cities: ['عمان','الزرقاء','إربد','البلقاء','المفرق','جرش','عجلون','مادبا','الكرك','الطفيلة','معان','العقبة']
    });
  });

  // Payment methods only returned to authenticated technicians
  router.get('/payment-methods', auth, requireRole('technician'), (req, res) => {
    res.json({ paymentMethods: db.prepare('SELECT * FROM payment_methods').all() });
  });

  return router;
};
