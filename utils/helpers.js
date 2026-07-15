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

module.exports = { escapeLike, hasSafeExt, safeUploadName, clean, userPublic };
