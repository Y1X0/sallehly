// middleware/auth.js
// التحقق من هوية المستخدم (JWT) وصلاحياته. أي تعديل على منطق تسجيل الدخول/الصلاحيات مكانه هون.

const jwt = require('jsonwebtoken');
const { db } = require('../config/db');
const { JWT_SECRET } = require('../config/env');

function sign(user) {
  return jwt.sign({ id: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
}

// [SEC-FIX-08] auth() — JWT verify + live is_active check to support instant revocation
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : req.cookies.token;
  if (!token) return res.status(401).json({ error: 'يرجى تسجيل الدخول' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Revocation check: ensure account still active in DB
    const liveUser = db.prepare('SELECT id, role, name, is_active FROM users WHERE id=?').get(decoded.id);
    if (!liveUser || !liveUser.is_active) return res.status(401).json({ error: 'الجلسة منتهية أو الحساب موقوف' });
    req.user = decoded;
    next();
  } catch { return res.status(401).json({ error: 'جلسة غير صالحة' }); }
}

function requireRole(...roles) {
  return (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'لا تملك صلاحية' });
}

module.exports = { auth, requireRole, sign };
