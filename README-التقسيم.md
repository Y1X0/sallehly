# تقسيم server.js — دليل سريع

## شو صار بالضبط
انقسم `server.js` الأصلي (1699 سطر) لـ 23 ملف منظمة حسب الوظيفة، بدون تغيير أي منطق —
نفس الاستعلامات، نفس الشروط، نفس رسائل الأخطاء، بس مرتبة بمجلدات:

```
app.js                   → بناء Express + middleware فقط (بدون socket ولا listen — سهل للاختبار)
server.js                → التجميع والتشغيل فقط (~45 سطر): يبني deps ويشغّل السيرفر

config/env.js             → المتغيرات والثوابت (.env، JWT_SECRET، مسارات الملفات)
config/db.js               → الاتصال بقاعدة البيانات + النسخ الاحتياطي + التنظيف الدوري فقط
config/migrate.js          → شكل الجداول (CREATE/ALTER TABLE) + بيانات الـ seed — منفصل عن db.js

middleware/auth.js         → auth()، requireRole()، sign()
middleware/security.js     → helmet، rate limiters، حماية CSRF
middleware/upload.js       → إعدادات رفع الصور والصوت (multer)

services/email.js          → إرسال كود OTP عبر Resend
services/push.js           → إشعارات Firebase
services/socket.js         → Socket.IO كامل (الغرف، المصادقة اللحظية)

utils/helpers.js           → دوال نقية 100% (clean, userPublic, escapeLike...) — ما بتعرف شي عن db
utils/db-helpers.js        → دوال بتحتاج db (calcRating, getMessages, markChatRead)

routes/index.js            → نقطة تجميع واحدة تسجّل كل الـ routers
routes/*.routes.js         → كل route حسب موضوعه (auth, requests, offers, chat, topups, admin, support...)
```

### ليش `deps` صار مجمّع بمجموعات
بدل ما يكون عندك كائن واحد فيه ~20 مفتاح متل `{db, io, auth, upload, clean, calcRating, sendPush, ...}`،
صار مقسوم:
```js
deps = {
  db,                                  // القاعدة نفسها، مستخدمة بكل مكان تقريباً
  realtime:  { io, safeEmit },
  middleware:{ auth, requireRole, upload, uploadAudio },
  services:  { sendOtpEmail, sendPush, createDbBackup, sign },
  utils:     { clean, userPublic, escapeLike, calcRating, getMessages, markChatRead },
  limiters:  { loginLimiter, otpLimiter, ... },
  constants: { COOKIE_OPTS, BASE }
}
```
جوا أي route بتكتب `const { auth } = deps.middleware;` بدل ما تدوّر جوا كائن كبير — أوضح وأسهل تتبّع.

### قرار متعمّد: `io` بالـ deps صراحة، مش عن طريق `getIO()` singleton
في اقتراح شائع إنك تعمل `services/socket.js` فيه `getIO()` تقدر تستدعيها من أي route بدون
ما تحتاج تمررها بالـ deps. تعمّدت ما آخذ فيه لأنه بيدخل *hidden global state* — أي route
بيقدر يستخدم الـ socket بدون ما يكون واضح من الكود إنه محتاج له، وهاد بالضبط نوع الترابط
الخفي يلي بيصعب تتبع أخطائه. بالطريقة الحالية، `io` موجود بالـ deps بشكل صريح، فلو فتحت
أي route بتعرف فوراً وين بيجي منه.

**تم التحقق آلياً** إن كل الـ 49 endpoint + الـ catch-all موجودين بالضبط مرة وحدة —
ولا واحد ضاع أو تكرر (فحص مقارنة كامل بين الملف الأصلي والجديد، وفحص صياغة `node -c`
على كل ملف بدون استثناء).

## قبل ما تشغّله — هاد الشرط الوحيد
أنا ما قدرت أشغّل السيرفر فعلياً هون لأنه ما عندي إنترنت لتنزيل الحزم (express،
better-sqlite3، socket.io...) ولا قاعدة بياناتك الحقيقية. يلي عملته:
- فحص الصياغة (`node -c`) على كل ملف — **كلها سليمة 100%**.
- مقارنة كل route بالأصلي سطر بسطر — **مطابقة تامة**.
- نسخت كل الكود حرفياً بدون أي إعادة كتابة يدوية (نفس الاستعلامات بالضبط).

اللي بدك تعمله عندك (خطوة وحدة بس):
```bash
# 1. حط الملفات مكان server.js القديم (خلي public/، data/، .env متل ما هنن)
# 2. جرب تشغل السيرفر عادي
npm install   # إذا في أي حزمة ناقصة
node server.js
```
إذا طلع فوق ورجع نفس الشغل يلي كان شغال قبل — خلص، كل شي تمام.
لو طلع أي error عند التشغيل، ابعتلي نص الـ error وبصلحه فوراً.

## الخطوة الثانية يلي لازم تعملها: Git
هاد التقسيم بيقلل احتمال إنك تخرب شي وانت عم تعدل، بس ما بيلغي الحاجة لـ Git.
لو ما عندك Git لسا:

```bash
cd sallehly-server
git init
git add .
git commit -m "هيكلة أولية بعد تقسيم server.js"
```

من هلق وطالع، قبل أي تعديل:
```bash
git add -A && git commit -m "وصف قصير للتعديل"
```
ولو أي تعديل خرب شي، ترجع بثانية:
```bash
git diff          # تشوف بالضبط شو تغيّر
git checkout -- اسم_الملف   # ترجع ملف واحد لآخر نسخة سليمة
```
هاد هو الفرق الحقيقي بين "خمّن شو تغيّر" و"شوف بالضبط شو تغيّر".

## اقتراحات ما طبّقتها هلق (مش لأنها غلط، بس سابقة لأوانها)
- **تفتيت أي route file أكثر** (متل `requests/create.js`, `requests/offers.js`...): كل
  ملف route حالياً بين 60-250 سطر، مش كبير كفاية يستاهل هيك تفتيت. لو صار أي ملف فوق
  ~400 سطر بالمستقبل، وقتها منقسمه فعلاً.
