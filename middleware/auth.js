// middleware/auth.js
// التحقق من هوية المستخدم (JWT) وصلاحياته. أي تعديل على منطق تسجيل الدخول/الصلاحيات مكانه هون.

const jwt = require('jsonwebtoken');
const { db } = require('../config/db');
const { JWT_SECRET } = require('../config/env');

function sign(user) {
  // [SEC-FIX-09] tokenVersion يُثبَّت وقت الإصدار — لو تغيّر token_version
  // بقاعدة البيانات لاحقاً (تسجيل خروج أو تغيير كلمة سر)، يصبح أي توكن يحمل
  // القيمة القديمة مرفوضاً فوراً بغض النظر عن تاريخ انتهاء صلاحيته (7 أيام).
  return jwt.sign(
    { id: user.id, role: user.role, name: user.name, tokenVersion: user.token_version || 0 },
    JWT_SECRET,
    { expiresIn: '7d' },
  );
}

// [SEC-FIX-08] auth() — JWT verify + live is_active check to support instant revocation
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : req.cookies.token;
  if (!token) return res.status(401).json({ error: 'يرجى تسجيل الدخول' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Revocation check: ensure account still active in DB
    const liveUser = db.prepare('SELECT id, role, name, is_active, token_version FROM users WHERE id=?').get(decoded.id);
    if (!liveUser || !liveUser.is_active) return res.status(401).json({ error: 'الجلسة منتهية أو الحساب موقوف' });
    // [SEC-FIX-09] توكن صادر قبل آخر تسجيل خروج/تغيير كلمة سر لهذا الحساب —
    // decoded.tokenVersion غير موجود أصلاً بالتوكنات القديمة الموقّعة قبل هذا
    // التعديل، فتُعامَل كـ0 (تبقى صالحة ما لم يُسجَّل خروج فعلي بعد الترقية).
    if ((decoded.tokenVersion || 0) !== (liveUser.token_version || 0)) {
      return res.status(401).json({ error: 'الجلسة منتهية أو الحساب موقوف' });
    }
    // [FIX-AUTH-03-REST] نفس إصلاح السوكت تماماً (services/socket.js) — يُبنى
    // req.user من بيانات القاعدة الحيّة (role/name) بدل القيم المجمّدة داخل
    // التوكن وقت إصداره، حتى لا يبقى اسم قديم (بعد تعديل بروفايل) أو دور قديم
    // مستخدَماً بأي مكان بالسيرفر (سجلّات التدقيق، إشعارات Push، صلاحيات).
    req.user = { id: liveUser.id, role: liveUser.role, name: liveUser.name };
    next();
  } catch { return res.status(401).json({ error: 'جلسة غير صالحة' }); }
}

function requireRole(...roles) {
  return (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'لا تملك صلاحية' });
}

module.exports = { auth, requireRole, sign };
