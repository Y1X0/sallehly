// tests/account-deletion.spec.js
// [FIX-DELETE-CRASH-01] راجع DECISIONS.md و utils/db-helpers.js (anonymizeUser).
//
// قبل هذا الإصلاح: DELETE /me و DELETE /admin/users/:id كانا يرميان
// SqliteError (FOREIGN KEY constraint failed) لأي حساب له سجل واحد فعلي
// بـrequests/offers/topups/support_tickets/support_messages — وبما أن
// /me راوت async بلا try/catch، هذا الاستثناء كان يُسقط عملية Node
// بأكملها (عطل إنتاج كامل، لا مجرد خطأ لطلب واحد).
//
// هذا الملف يبني تاريخ استخدام حقيقي كامل (طلب، عرض، قبول عرض، رسائل شات،
// إكمال، تقييم، وسجل دفتر أستاذ عبر "الطلب المجاني" الأول) لعميل وفني، ثم
// يحذف كلا الحسابين (ذاتياً وعبر الأدمن) ويثبت: نجاح الحذف، بقاء السيرفر
// حياً (طلب تالٍ ناجح لنفس العملية)، سلامة قيود FOREIGN KEY، وعدم تسريب أي
// بيانات شخصية بعد الحذف مع بقاء كل السجلات التاريخية كما هي.

const { test, expect } = require('@playwright/test');
const jwt = require('jsonwebtoken');
const { getPendingOtp, openTestDb } = require('./helpers/db');

function uniqueEmail(tag) {
  return `test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}
function uniquePhone() {
  const suffix = Math.floor(10000000 + Math.random() * 89999999);
  return `07${suffix}`;
}
function uniqueNationalNumber() {
  let n = '';
  for (let i = 0; i < 10; i++) n += Math.floor(Math.random() * 10);
  return n;
}

const VALID_PASSWORD = 'TestPass123';
const SERVICE = 'كهربائي'; // موجودة أصلاً ضمن بيانات الـ seed الافتراضية بـ migrate.js
const CITY = 'عمان';
const ADMIN_EMAIL = 'admin-test@example.com';

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

async function registerAndVerify(request, role, extra = {}) {
  const email = uniqueEmail(role);
  const phone = uniquePhone();
  const registerRes = role === 'technician'
    ? await request.post('/api/auth/register', {
        multipart: {
          role, email, phone, password: VALID_PASSWORD, ...extra,
          avatar: { name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
        },
      })
    : await request.post('/api/auth/register', {
        form: { role, email, phone, password: VALID_PASSWORD, ...extra },
      });
  if (!registerRes.ok()) throw new Error(`فشل تسجيل (${role}) أثناء تجهيز الاختبار: ${registerRes.status()} ${await registerRes.text()}`);
  const otp = getPendingOtp(email);
  const res = await request.post('/api/auth/verify-otp', { form: { email, otp } });
  if (!res.ok()) throw new Error(`فشل verify-otp (${role}) أثناء تجهيز الاختبار: ${res.status()} ${await res.text()}`);
  const body = await res.json();
  return { email, phone, token: body.token, user: body.user };
}

// [TEST-ISOLATION-01] هذا الملف الوحيد بين ملفات الاختبار الذي يبني توكن
// الأدمن مباشرة (jsonwebtoken) بدل استدعاء POST /auth/login. كل ملفات
// الاختبار الأخرى تستدعي /auth/login في beforeAll الخاص بها، وكلها تتشارك
// نفس عملية السيرفر الواحدة (playwright.config.js: workers=1, webServer
// واحد) — أي بالتالي نفس عدّاد loginLimiter (20 محاولة/15 دقيقة). ثبت
// عملياً أن مجموع محاولات الدخول عبر كل الملفات يصل قريباً جداً من هذا الحد
// بنهاية التشغيل الكامل؛ استدعاء دخول حقيقي إضافي هنا كان يكفي لتجاوزه
// ويُسقط اختبار topups.spec.js (غير مرتبط بهذا الإصلاح إطلاقاً) بخطأ 429
// عرَضي. توليد التوكن مباشرة بنفس آلية sign() في middleware/auth.js
// (jsonwebtoken + JWT_SECRET بيئة الاختبار المعروفة من playwright.config.js)
// يختبر نفس الشيء المطلوب هنا (سلوك /me و/admin/users/:id عند الحذف) دون
// استهلاك أي حصة من محدودية دخول مشتركة بين كل ملفات الاختبار.
const TEST_JWT_SECRET = 'test_only_secret_not_for_real_use_1234567890';

function loginAdmin() {
  const db = openTestDb();
  try {
    const admin = db.prepare("SELECT id, name, token_version FROM users WHERE role='admin' AND email=?").get(ADMIN_EMAIL);
    if (!admin) throw new Error(`لا يوجد حساب أدمن بالبريد ${ADMIN_EMAIL} بقاعدة بيانات الاختبار`);
    return jwt.sign(
      { id: admin.id, role: 'admin', name: admin.name, tokenVersion: admin.token_version || 0 },
      TEST_JWT_SECRET,
      { expiresIn: '7d' },
    );
  } finally {
    db.close();
  }
}

test.describe.serial('[FIX-DELETE-CRASH-01] حذف حساب له تاريخ استخدام حقيقي لا يُسقط السيرفر', () => {
  let customer;
  let technician;
  let adminToken;
  let requestId;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });

    customer = await registerAndVerify(request, 'customer', { name: 'عميل اختبار حذف الحساب', city: CITY });
    technician = await registerAndVerify(request, 'technician', {
      name: 'فني اختبار حذف الحساب',
      city: CITY,
      national_number: uniqueNationalNumber(),
      services: SERVICE,
      areas: 'القويسمة',
    });
    adminToken = loginAdmin();

    // ── يبني تاريخ استخدام حقيقي كامل: طلب → عرض → قبول → رسائل شات →
    // إكمال (يُنشئ سجل دفتر أستاذ "طلب مجاني" تلقائياً) → تقييم ──
    const reqRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      multipart: {
        service: SERVICE,
        city: CITY,
        area: 'القويسمة',
        description: 'وصف تجريبي كافٍ للطول لاختبار حذف الحساب مع تاريخ حقيقي',
      },
    });
    if (!reqRes.ok()) throw new Error(`فشل إنشاء الطلب أثناء تجهيز الاختبار: ${reqRes.status()} ${await reqRes.text()}`);
    requestId = (await reqRes.json()).request.id;

    const offerRes = await request.post(`/api/requests/${requestId}/offer`, {
      headers: authHeader(technician.token),
      form: { offer_price: 15, duration: '30 دقيقة' },
    });
    if (!offerRes.ok()) throw new Error(`فشل تقديم العرض أثناء تجهيز الاختبار: ${offerRes.status()} ${await offerRes.text()}`);

    const offersListRes = await request.get(`/api/requests/${requestId}/offers`, { headers: authHeader(customer.token) });
    const offerId = (await offersListRes.json()).offers[0].id;

    const decisionRes = await request.post(`/api/offers/${offerId}/decision`, {
      headers: authHeader(customer.token),
      form: { decision: 'accepted' },
    });
    if (!decisionRes.ok()) throw new Error(`فشل قبول العرض أثناء تجهيز الاختبار: ${decisionRes.status()} ${await decisionRes.text()}`);

    const msg1 = await request.post(`/api/requests/${requestId}/messages`, {
      headers: authHeader(customer.token),
      form: { body: 'مرحباً، متى تقدر توصل؟' },
    });
    if (!msg1.ok()) throw new Error(`فشل إرسال رسالة العميل أثناء تجهيز الاختبار: ${msg1.status()} ${await msg1.text()}`);

    const msg2 = await request.post(`/api/requests/${requestId}/messages`, {
      headers: authHeader(technician.token),
      form: { body: 'أهلاً، بعد نص ساعة إن شاء الله' },
    });
    if (!msg2.ok()) throw new Error(`فشل إرسال رسالة الفني أثناء تجهيز الاختبار: ${msg2.status()} ${await msg2.text()}`);

    const inProgressRes = await request.post(`/api/requests/${requestId}/status`, {
      headers: authHeader(technician.token),
      form: { status: 'قيد التنفيذ' },
    });
    if (!inProgressRes.ok()) throw new Error(`فشل تحديث الحالة لـ"قيد التنفيذ": ${inProgressRes.status()} ${await inProgressRes.text()}`);

    const completeRes = await request.post(`/api/requests/${requestId}/status`, {
      headers: authHeader(customer.token),
      form: { status: 'مكتمل' },
    });
    if (!completeRes.ok()) throw new Error(`فشل إكمال الطلب أثناء تجهيز الاختبار: ${completeRes.status()} ${await completeRes.text()}`);

    const rateRes = await request.post(`/api/requests/${requestId}/rate`, {
      headers: authHeader(customer.token),
      form: { stars: 5, comment: 'ممتاز' },
    });
    if (!rateRes.ok()) throw new Error(`فشل التقييم أثناء تجهيز الاختبار: ${rateRes.status()} ${await rateRes.text()}`);

    // شكوى مرتبطة بنفس العميل والطلب — يثبت أن complaints (بلا FOREIGN KEY
    // فعلي لكن تاريخ حقيقي مرتبط بـuser_id) لا يمنع ولا يتأثر بالحذف
    const complaintRes = await request.post('/api/complaints', {
      headers: authHeader(customer.token),
      form: { request_id: requestId, subject: 'ملاحظة بسيطة', body: 'تأخر الفني قليلاً عن الموعد المتفق عليه' },
    });
    if (!complaintRes.ok()) throw new Error(`فشل إنشاء الشكوى أثناء تجهيز الاختبار: ${complaintRes.status()} ${await complaintRes.text()}`);

    await request.dispose();
  });

  test('Test 1 — DELETE /api/me لفني له عروض/رسائل/تقييم/سجل دفتر أستاذ: ينجح والسيرفر يبقى حياً', async ({ request }) => {
    const res = await request.delete('/api/me', {
      headers: authHeader(technician.token),
      form: { password: VALID_PASSWORD },
    });

    // قبل الإصلاح: هذا الطلب كان يُسقط عملية Node بأكملها (لا رد إطلاقاً).
    // بعد الإصلاح: يجب أن ينجح (لا يوجد طلب نشط ولا رصيد > 0 لهذا الفني).
    expect(res.status(), await res.text()).toBe(200);

    // الدليل الحاسم على أن السيرفر لم يُسقَط: طلب تالٍ لنفس العملية ينجح.
    const health = await request.get('/api/meta');
    expect(health.status()).toBe(200);

    const db = openTestDb();
    try {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('Test 2 — DELETE /api/admin/users/:id لعميل له طلبات/رسائل/تقييم/شكوى: لا يُسقط السيرفر', async ({ request }) => {
    const res = await request.delete(`/api/admin/users/${customer.user.id}`, {
      headers: authHeader(adminToken),
    });

    expect(res.status(), await res.text()).toBe(200);

    const health = await request.get('/api/meta');
    expect(health.status()).toBe(200);

    const db = openTestDb();
    try {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('Test 3 — بعد الحذف: لا تُكشَف بيانات شخصية، السجلات التاريخية باقية، والقيود الخارجية سليمة', async ({ request }) => {
    const db = openTestDb();
    try {
      const techRow = db.prepare('SELECT * FROM users WHERE id=?').get(technician.user.id);
      expect(techRow).toBeTruthy();
      expect(techRow.name).toBe('مستخدم محذوف');
      expect(techRow.email).not.toBe(technician.email);
      expect(techRow.phone).not.toBe(technician.phone);
      expect(techRow.national_number).toBeNull();
      expect(techRow.avatar_url).toBeNull();
      expect(techRow.is_active).toBe(0);
      expect(techRow.deleted_at).toBeTruthy();

      const custRow = db.prepare('SELECT * FROM users WHERE id=?').get(customer.user.id);
      expect(custRow).toBeTruthy();
      expect(custRow.name).toBe('مستخدم محذوف');
      expect(custRow.email).not.toBe(customer.email);
      expect(custRow.phone).not.toBe(customer.phone);
      expect(custRow.is_active).toBe(0);
      expect(custRow.deleted_at).toBeTruthy();

      // السجلات التاريخية باقية بلا حذف أو تعديل (نفس روح DECISIONS.md الأصلية)
      const reqRow = db.prepare('SELECT * FROM requests WHERE id=?').get(requestId);
      expect(reqRow).toBeTruthy();
      expect(reqRow.status).toBe('مكتمل');
      expect(reqRow.customer_id).toBe(customer.user.id);
      expect(reqRow.technician_id).toBe(technician.user.id);

      const msgCount = db.prepare('SELECT COUNT(*) c FROM messages WHERE request_id=?').get(requestId).c;
      expect(msgCount).toBeGreaterThanOrEqual(2);

      const ratingRow = db.prepare('SELECT * FROM ratings WHERE request_id=?').get(requestId);
      expect(ratingRow).toBeTruthy();
      expect(ratingRow.stars).toBe(5);

      const ledgerCount = db.prepare('SELECT COUNT(*) c FROM ledger WHERE user_id=?').get(technician.user.id).c;
      expect(ledgerCount).toBeGreaterThan(0);

      const complaintRow = db.prepare('SELECT * FROM complaints WHERE request_id=?').get(requestId);
      expect(complaintRow).toBeTruthy();

      // القيود الخارجية سليمة تماماً — لا صفوف يتيمة فعلياً رغم بقاء الإشارة لنفس id
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      db.close();
    }
  });

  test('حساب محذوف لا يستطيع تسجيل الدخول بعد الآن', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      form: { email: technician.email, password: VALID_PASSWORD },
    });
    expect(res.status()).not.toBe(200);
  });

  test('GET /api/requests/:id/messages لطلب فيه طرف محذوف يبقى يعمل (JOIN مع users لا ينكسر)', async ({ request }) => {
    // الفني محذوف، لكن الطلب يخص العميل (محذوف أيضاً هنا) — نتحقق فقط أن
    // الاستعلام بحد ذاته لا يرمي خطأً (getMessages تعتمد JOIN users)، عبر
    // تسجيل دخول أدمن جديد والوصول من زاويته كحساب إداري له صلاحية العرض.
    const res = await request.get(`/api/requests/${requestId}/messages`, {
      headers: authHeader(adminToken),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.messages.length).toBeGreaterThanOrEqual(2);
  });
});
