# صلّحلي (Sallehly) — Backend

خادم Node/Express + موقع ثابت لتطبيق **صلّحلي** — منصّة تربط العميل بالفني
الموثوق لخدمات الصيانة المنزلية بالأردن. هذا المستودع هو الـbackend الذي
يخدم تطبيق الموبايل (Flutter، مستودع منفصل `sallehly_app`) والموقع
الإلكتروني معاً.

## الميزات الأساسية

- تسجيل دخول بالإيميل/كلمة السر (مع تحقق OTP بالبريد)، وتسجيل دخول بجوجل
  وأبل (Firebase Authentication).
- محفظة رصيد للفنيين: شحن عبر تحويل بنكي يراجعه الأدمن يدوياً، خصم عمولة
  تلقائي عند إكمال كل طلب، كشف تكرار إيصالات الشحن.
- دردشة لحظية بين العميل والفني (Socket.IO) لكل طلب، بفلترة تمنع مشاركة
  أرقام هواتف/روابط تواصل خارجية.
- لوحات منفصلة بصلاحيات مختلفة: عميل، فني، أدمن.
- إشعارات Push عبر Firebase Cloud Messaging.
- نسخ احتياطي دوري لقاعدة البيانات (محلي + اختياري لمستودع GitHub خارجي).
- قاعدة بيانات SQLite (`better-sqlite3`) — خفيفة، بلا خادم قاعدة بيانات
  منفصل.
- حزمة اختبارات شاملة (Playwright، أكثر من 440 اختباراً تغطي الأمان،
  السباقات، وسلامة البيانات) — راجع `DECISIONS.md` لتفاصيل كل إصلاح واختباره.

## التشغيل محلياً

1. ثبّت الحزم:

   ```bash
   npm install
   ```

2. انسخ ملف البيئة:

   ```bash
   cp .env.example .env
   ```

3. افتح `.env` واملأ القيم الإلزامية على الأقل:

   ```env
   JWT_SECRET=مفتاح_طويل_وعشوائي
   ADMIN_EMAIL=بريد_الإدارة
   ADMIN_PASSWORD=كلمة_سر_قوية
   ```

4. شغّل المشروع:

   ```bash
   npm start
   ```

   ثم افتح `http://localhost:3000`.

### متغيرات بيئة اختيارية

| المتغير | الغرض |
|---|---|
| `RESEND_API_KEY` / `RESEND_FROM` | إرسال إيميلات OTP فعلية عبر Resend — بدونها الكود يُطبع بالـconsole فقط (مفيد للتطوير المحلي). |
| `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` (أو `FIREBASE_SERVICE_ACCOUNT` كـJSON كامل) | تفعيل Firebase Admin SDK — مطلوب لتسجيل الدخول بجوجل/أبل وللإشعارات Push. |
| `REVIEWER_CUSTOMER_EMAIL` / `REVIEWER_CUSTOMER_PASSWORD` وREVIEWER_TECH_* | إنشاء حساب عميل/فني ثابت للمراجعة (Google Play / App Store) عند تشغيل السيرفر. |
| `BACKUP_GITHUB_TOKEN` / `BACKUP_GITHUB_OWNER` / `BACKUP_GITHUB_REPO` | رفع نسخة احتياطية إضافية خارج قرص Render — راجع `services/offsite-backup.js`. |
| `ALERT_EMAIL` | مستقبل تنبيهات الأخطاء (بدلاً من `ADMIN_EMAIL` الافتراضي) — راجع `services/error-alert.js`. |
| `DATA_DIR` | مسار قاعدة البيانات/الملفات المرفوعة (افتراضياً `./data`). |

## الاختبارات

```bash
npm test
```

يشغّل حزمة Playwright كاملة على سيرفر ونسخة قاعدة بيانات منفصلتين تماماً
عن التطوير/الإنتاج (`playwright.config.js` — منفذ 4001، `data-test/`).

## بنية المشروع

```
routes/       نقاط الـAPI (auth، requests، offers، chat، topups، admin...)
middleware/   المصادقة، الحماية الأمنية، رفع الملفات
services/     البريد، الإشعارات، Socket.IO، النسخ الاحتياطي
config/       الإعدادات والهجرات (migrations) — config/migrate.js
utils/        دوال مساعدة مشتركة
tests/        حزمة Playwright الكاملة
public/       الموقع الثابت
```

## قرارات وإصلاحات موثَّقة

كل إصلاح أمني أو منطقي جوهري بهذا المشروع موثَّق بالتفصيل (السياق، السبب،
الاختبار) داخل **`DECISIONS.md`** — راجعه قبل تعديل أي منطق حسّاس (الدردشة،
الرصيد، حذف الحسابات، تسجيل الدخول الاجتماعي...) لفهم القيود المقصودة.
