// middleware/upload.js
// إعدادات رفع الملفات (multer) للصور والصوت. أي تعديل على أنواع/أحجام الملفات المسموحة مكانه هون.

const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { UPLOAD_DIR } = require('../config/env');
const { hasSafeExt, safeUploadName } = require('../utils/helpers');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const folder = file.fieldname === 'receipt' ? 'payments' : (file.fieldname === 'problem_image' ? 'requests' : 'avatars');
    cb(null, path.join(UPLOAD_DIR, folder));
  },
  filename: (req, file, cb) => {
    cb(null, safeUploadName(file));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype) && hasSafeExt(file, ['.jpg', '.jpeg', '.png', '.webp']);
    cb(ok ? null : new Error('نوع الملف غير مسموح'), ok);
  }
});

const audioStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(UPLOAD_DIR, 'audios')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.webm';
    cb(null, Date.now() + '-' + crypto.randomBytes(8).toString('hex') + ext);
  }
});
const uploadAudio = multer({
  storage: audioStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['audio/webm', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg'].includes(file.mimetype) && hasSafeExt(file, ['.webm', '.mp3', '.mpeg', '.wav', '.ogg']);
    cb(ok ? null : new Error('نوع التسجيل الصوتي غير مسموح'), ok);
  }
});

module.exports = { upload, uploadAudio };
