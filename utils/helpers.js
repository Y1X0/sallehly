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
  const { password_hash, ...x } = u;
  return x;
}

module.exports = { escapeLike, hasSafeExt, safeUploadName, clean, userPublic };
