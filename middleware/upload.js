// middleware/upload.js
// إعدادات رفع الملفات (multer) للصور والصوت. أي تعديل على أنواع/أحجام الملفات المسموحة مكانه هون.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { UPLOAD_DIR } = require('../config/env');
const { hasSafeExt, safeUploadName } = require('../utils/helpers');

// [FIX-CHATIMG-01] خريطة صريحة بدل شرط متداخل — الشرط القديم كان يُسقط أي
// fieldname غير 'receipt'/'problem_image' على 'avatars' افتراضياً، وهذا كان
// يشمل رسائل الشات (fieldname='image') بالخطأ: تُحفَظ فعلياً داخل avatars/
// بينما الرابط المُخزَّن بقاعدة البيانات (routes/chat.routes.js) يشير إلى
// requests/ — فيفشل تحميل الصورة دائماً (404) لأنها غير موجودة بالمسار الذي
// يُطلَب منه. أي fieldname مستقبلي غير مُدرَج هنا سيرمي خطأً بدل الانزلاق
// بصمت لمجلد خاطئ.
const UPLOAD_FIELD_FOLDERS = {
  receipt: 'payments',
  problem_image: 'requests',
  image: 'requests',
  avatar: 'avatars'
};
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const folder = UPLOAD_FIELD_FOLDERS[file.fieldname];
    if (!folder) return cb(new Error(`حقل رفع غير معروف: ${file.fieldname}`));
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

// [SEC-FIX-UPLOADMAGIC-01] راجع DECISIONS.md — fileFilter أعلاه (multer) لا
// يتحقق إلا من file.mimetype (يُقرّره المتصفح/العميل، قابل للتلاعب بسهولة
// بطلب مُعدَّل يدوياً) وامتداد الاسم — لا من محتوى الملف الفعلي، الذي لا
// يتوفر بعد أصلاً وقت fileFilter (قبل اكتمال الكتابة للقرص). هذه middleware
// إضافية تُشغَّل بعد upload.single(...) مباشرة (الملف مكتوب فعلياً على
// القرص بهذه المرحلة) — تقرأ أول 12 بايت فقط (لا الملف كاملاً) وتتحقق أن
// "التوقيع السحري" (magic bytes) يطابق فعلياً نوع MIME الذي ادّعاه الطلب،
// لا مجرد أن الامتداد/الترويسة يبدوان معقولين. عدم تطابق (أو ملف غير قابل
// للقراءة أصلاً) يحذف الملف فوراً (لا يُترَك يتيماً بالقرص) ويرفض بنفس نمط
// رسالة "نوع الملف" التي يتعرّف عليها apiErrorHandler أصلاً (middleware/security.js)
// فيُترجَم تلقائياً لـFILE_TYPE_NOT_ALLOWED بلا أي تعديل هناك.
const IMAGE_MAGIC_BYTES = {
  'image/jpeg': (buf) => buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF,
  'image/png': (buf) => buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A,
  'image/webp': (buf) => buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
};

function verifyImageMagicBytes(req, res, next) {
  if (!req.file) return next();
  const check = IMAGE_MAGIC_BYTES[req.file.mimetype];
  try {
    const fd = fs.openSync(req.file.path, 'r');
    const buf = Buffer.alloc(12);
    // Buffer.alloc يُصفّر كل البايتات مسبقاً، فـbuf.length يبقى 12 دائماً
    // بغض النظر عن حجم الملف الفعلي — bytesRead وحده يعكس ما قُرئ فعلياً،
    // فيُمرَّر slice به لا الـbuffer المُخصَّص كاملاً لكل دوال IMAGE_MAGIC_BYTES.
    const bytesRead = fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    if (!check || !check(buf.subarray(0, bytesRead))) throw new Error('mismatch');
    next();
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch (e2) {}
    next(new Error('نوع الملف لا يطابق محتواه الفعلي'));
  }
}

module.exports = { upload, uploadAudio, verifyImageMagicBytes };
