// tests/security-hardening.spec.js
// يغطي فجوات أمنية لم تكن مغطاة صراحة رغم وجود الحماية فعلياً بالكود:
// CSRF (Origin/Referer)، فلترة IDOR على قائمة العروض، رفض REST فوري لحساب
// موقوف (وليس فقط قطع Socket.IO)، وحارس ثابت على قيم Rate Limit الحقيقية
// بالإنتاج (يمنع أي تعديل غير مقصود يُضعفها بصمت).

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { getPendingOtp, openTestDb } = require('./helpers/db');

function uniqueEmail(tag) {
  return `test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}
function uniquePhone() {
  return `07${Math.floor(10000000 + Math.random() * 89999999)}`;
}
function uniqueNationalNumber() {
  let n = '';
  for (let i = 0; i < 10; i++) n += Math.floor(Math.random() * 10);
  return n;
}

const VALID_PASSWORD = 'TestPass123';
const SERVICE = 'كهربائي';
const CITY = 'عمان';
const ADMIN_EMAIL = 'admin-test@example.com';
const ADMIN_PASSWORD = 'AdminTestPass123';

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
    : await request.post('/api/auth/register', { form: { role, email, phone, password: VALID_PASSWORD, ...extra } });
  if (!registerRes.ok()) throw new Error(`فشل تسجيل (${role}): ${registerRes.status()} ${await registerRes.text()}`);
  const otp = getPendingOtp(email);
  const res = await request.post('/api/auth/verify-otp', { form: { email, otp } });
  if (!res.ok()) throw new Error(`فشل verify-otp (${role}): ${res.status()} ${await res.text()}`);
  const body = await res.json();
  return { email, phone, token: body.token, user: body.user };
}

async function loginAdmin(request) {
  const res = await request.post('/api/auth/login', { form: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  if (!res.ok()) throw new Error(`فشل دخول الأدمن: ${res.status()} ${await res.text()}`);
  return (await res.json()).token;
}

// [SEC-FIX-06] الحماية موجودة أصلاً بـ middleware/security.js (csrfCheck)، لكن
// لا يوجد أي اختبار يثبت أنها تعمل فعلياً على السيرفر الحي. تطبيق Flutter لا
// يرسل Origin/Referer إطلاقاً (طلب HTTP مباشر وليس متصفحاً) لذا هذه الاختبارات
// لا تكسر أي شيء يخص التطبيق — تتحقق فقط من سلوك متصفح مهاجم افتراضي.
test.describe('[CSRF] حماية Origin/Referer على الطلبات المُغيِّرة للحالة', () => {
  test('Origin غير مسموح على POST يُرفض بـ403 قبل الوصول لأي منطق مصادقة', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      headers: { Origin: 'https://evil-attacker.example' },
      form: { email: 'nonexistent@example.com', password: 'whatever123' },
    });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('CSRF');
  });

  test('Referer غير مسموح (بلا Origin) على POST يُرفض أيضاً بـ403', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      headers: { Referer: 'https://evil-attacker.example/phish' },
      form: { email: 'nonexistent@example.com', password: 'whatever123' },
    });
    expect(res.status()).toBe(403);
  });

  test('Origin مسموح ضمن ALLOWED_ORIGINS لا يُرفض — يصل لمنطق التحقق الطبيعي', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      headers: { Origin: 'http://localhost:3000' },
      form: { email: 'nonexistent@example.com', password: 'whatever123' },
    });
    // لا يُرفض بـ403 (CSRF) — يصل لمنطق تسجيل الدخول فيرفض ببريد غير موجود (401)
    expect(res.status()).not.toBe(403);
    expect(res.status()).toBe(401);
  });

  test('بلا Origin وبلا Referer إطلاقاً (حال تطبيق Flutter الحقيقي) لا يُرفض أبداً', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      form: { email: 'nonexistent@example.com', password: 'whatever123' },
    });
    expect(res.status()).not.toBe(403);
  });

  test('GET لا يخضع أصلاً لفحص CSRF حتى مع Origin مهاجم', async ({ request }) => {
    const res = await request.get('/api/requests', { headers: { Origin: 'https://evil-attacker.example' } });
    // يصل لمنطق auth() الطبيعي (401 لعدم وجود توكن) وليس 403 CSRF
    expect(res.status()).toBe(401);
  });
});

// [SEC-FIX-10] auth() (middleware/auth.js) يتحقق من is_active حياً بكل طلب —
// مختبر سابقاً فقط عبر Socket.IO (tests/auth-session.spec.js). هذا يثبت نفس
// الضمان على REST مباشرة: توكن صادر *قبل* الإيقاف يُرفض فوراً بالطلب التالي.
test.describe('[SEC-FIX-10] رفض REST فوري لحساب مُوقَف (وليس فقط عند تسجيل دخول جديد)', () => {
  test('عميل يُوقَف بينما توكنه القديم لا يزال صالحاً: الطلب التالي بنفس التوكن يُرفض 401', async ({ request }) => {
    const adminToken = await loginAdmin(request);
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل سيُوقَف', city: CITY });

    // التوكن لا يزال صالحاً الآن
    const before = await request.get('/api/me', { headers: authHeader(customer.token) });
    expect(before.status()).toBe(200);

    const toggle = await request.post(`/api/admin/users/${customer.user.id}/toggle`, {
      headers: authHeader(adminToken),
      form: { reason: 'اختبار أمني' },
    });
    expect(toggle.ok()).toBeTruthy();

    // نفس التوكن القديم بالضبط — لم يُسجَّل خروج، لم تنتهِ صلاحيته
    const after = await request.get('/api/me', { headers: authHeader(customer.token) });
    expect(after.status()).toBe(401);

    // إعادة التفعيل تعيد الوصول فوراً بنفس التوكن القديم أيضاً
    await request.post(`/api/admin/users/${customer.user.id}/toggle`, { headers: authHeader(adminToken) });
    const reactivated = await request.get('/api/me', { headers: authHeader(customer.token) });
    expect(reactivated.status()).toBe(200);
  });

  test('فني موقوف لا يقدر ينشئ عرضاً جديداً حتى لو أرسل الطلب بتوكن قديم صالح شكلياً', async ({ request }) => {
    const adminToken = await loginAdmin(request);
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل لطلب', city: CITY });
    const technician = await registerAndVerify(request, 'technician', {
      name: 'فني سيُوقَف', city: CITY, national_number: uniqueNationalNumber(), services: SERVICE, areas: 'القويسمة',
    });

    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      form: { service: SERVICE, description: 'وصف كافٍ لاختبار الإيقاف', city: CITY, area: 'القويسمة' },
    });
    expect(createRes.ok()).toBeTruthy();
    const requestId = (await createRes.json()).request.id;

    await request.post(`/api/admin/users/${technician.user.id}/toggle`, { headers: authHeader(adminToken) });

    const offerRes = await request.post(`/api/requests/${requestId}/offer`, {
      headers: authHeader(technician.token),
      form: { offer_price: '10', duration: '30 دقيقة' },
    });
    expect(offerRes.status()).toBe(401);
  });
});

// GET /api/requests/:id/offers لا يُخفي كامل الاستجابة عن فني غير مرتبط بالطلب
// (يراها كي يعرف عدد المنافسين)، لكن يجب ألا يكشف سعر/ملاحظة عروض فنيين آخرين —
// فقط عرضه الخاص إن وُجد. هذا السلوك موجود بالكود (سطر الـ filter) لكن بلا اختبار مباشر.
test.describe('[IDOR] فلترة عروض الفنيين غير المرتبطين بالطلب', () => {
  test('فني ثالث لا علاقة له بالطلب يرى عروضه الخاصة فقط، لا أسعار/ملاحظات الفنيين الآخرين', async ({ request }) => {
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل لاختبار IDOR', city: CITY });
    const techA = await registerAndVerify(request, 'technician', {
      name: 'فني أ', city: CITY, national_number: uniqueNationalNumber(), services: SERVICE, areas: 'القويسمة',
    });
    const techB = await registerAndVerify(request, 'technician', {
      name: 'فني ب', city: CITY, national_number: uniqueNationalNumber(), services: SERVICE, areas: 'القويسمة',
    });
    const techC = await registerAndVerify(request, 'technician', {
      name: 'فني ج (لا يقدّم عرضاً)', city: CITY, national_number: uniqueNationalNumber(), services: SERVICE, areas: 'القويسمة',
    });

    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      form: { service: SERVICE, description: 'وصف كافٍ لاختبار IDOR بالعروض', city: CITY, area: 'القويسمة' },
    });
    const requestId = (await createRes.json()).request.id;

    await request.post(`/api/requests/${requestId}/offer`, { headers: authHeader(techA.token), form: { offer_price: '15', duration: '30 دقيقة', note: 'ملاحظة سرية أ' } });
    await request.post(`/api/requests/${requestId}/offer`, { headers: authHeader(techB.token), form: { offer_price: '25', duration: '45 دقيقة', note: 'ملاحظة سرية ب' } });

    const viewC = await request.get(`/api/requests/${requestId}/offers`, { headers: authHeader(techC.token) });
    expect(viewC.status()).toBe(200);
    const bodyC = await viewC.json();
    // لا يرى أي عرض (لم يقدّم شيئاً بعد) ولا يُسرَّب أي سعر/ملاحظة لفني منافس
    expect(bodyC.offers).toHaveLength(0);

    await request.post(`/api/requests/${requestId}/offer`, { headers: authHeader(techC.token), form: { offer_price: '20', duration: '20 دقيقة', note: 'ملاحظة ج' } });
    const viewCAfter = await request.get(`/api/requests/${requestId}/offers`, { headers: authHeader(techC.token) });
    const bodyCAfter = await viewCAfter.json();
    // يرى عرضه فقط الآن، رغم وجود 3 عروض إجمالاً على الطلب
    expect(bodyCAfter.offers).toHaveLength(1);
    expect(bodyCAfter.offers[0].technician_id).toBe(techC.user.id);
    const allNotes = bodyCAfter.offers.map((o) => o.note);
    expect(allNotes).not.toContain('ملاحظة سرية أ');
    expect(allNotes).not.toContain('ملاحظة سرية ب');
  });
});

// حارس تراجع: يضمن أن حدود الطلبات (express-rate-limit) بالإنتاج لم تتغيّر
// بصمت لقيمة أضعف. القيم بالاختبار (IS_PROD=false) مضبوطة عمداً على 1000 لكل
// حد (راجع middleware/security.js) لمنع فشل عشوائي بالاختبارات الآلية، لذا لا
// يمكن إثبات 429 حقيقي هنا دون آلاف الطلبات — هذا الاختبار يتحقق مباشرة من
// قيم الإنتاج المُهيَّأة بالمصدر بدل ذلك.
test.describe('[Rate Limits] قيم حدود الإنتاج لم تتغيّر بصمت', () => {
  test('كل حد إنتاج (max) وكل نافذة زمنية (windowMs) مطابقة للقيم الموثّقة', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'middleware', 'security.js'), 'utf8');
    const expected = {
      loginLimiter: { max: 20, windowMs: 15 * 60 * 1000 },
      registerLimiter: { max: 10, windowMs: 60 * 60 * 1000 },
      passwordResetLimiter: { max: 5, windowMs: 15 * 60 * 1000 },
      messageLimiter: { max: 30, windowMs: 60 * 1000 },
      offerLimiter: { max: 20, windowMs: 15 * 60 * 1000 },
    };
    for (const [name, { max, windowMs }] of Object.entries(expected)) {
      const block = src.slice(src.indexOf(`const ${name} = rateLimit({`));
      const maxMatch = block.match(/max:\s*IS_PROD\s*\?\s*(\d+)\s*:/);
      const windowMatch = block.match(/windowMs:\s*([\d*\s]+),/);
      expect(maxMatch, `تعذّر إيجاد قيمة max لـ ${name}`).not.toBeNull();
      expect(Number(maxMatch[1]), `${name}.max بالإنتاج تغيّر`).toBe(max);
      const windowValue = windowMatch[1].split('*').map((n) => Number(n.trim())).reduce((a, b) => a * b, 1);
      expect(windowValue, `${name}.windowMs تغيّر`).toBe(windowMs);
    }
  });

  test('حد الطلبات المعلّقة لشحن الرصيد (منطق أعمال، ليس express-rate-limit) لا يزال 2', async ({ request }) => {
    // يتحقق من نفس السلوك المُختبَر أصلاً بـ topups.spec.js لكن كحارس صريح
    // منفصل هنا ضمن ملف الأمان — يمنع اعتماد التقرير النهائي على قراءة غير مباشرة.
    const technician = await registerAndVerify(request, 'technician', {
      name: 'فني حد الشحن', city: CITY, national_number: uniqueNationalNumber(), services: SERVICE, areas: 'القويسمة',
    });
    const receipt = { name: 'r.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) };
    const first = await request.post('/api/topups', { headers: authHeader(technician.token), multipart: { package_id: '1', receipt } });
    const second = await request.post('/api/topups', { headers: authHeader(technician.token), multipart: { package_id: '1', receipt } });
    const third = await request.post('/api/topups', { headers: authHeader(technician.token), multipart: { package_id: '1', receipt } });
    expect(first.ok()).toBeTruthy();
    expect(second.ok()).toBeTruthy();
    expect(third.status()).toBe(429);
  });
});

// مدخلات خبيثة: better-sqlite3 مع prepared statements بكل مكان يمنع SQL
// Injection بنيوياً، لكن هذا يثبته تجريبياً بدل افتراضه، ويثبت أن نصوصاً تحتوي
// رموز HTML/JS تُخزَّن وتُرجَع كنص خام بدون أي تنفيذ أو كسر بالاستجابة (الحماية
// من XSS مسؤولية طرف العرض بـ Flutter، لا داعي لتعقيم الخادم للنص نفسه).
test.describe('[Malicious Input] مدخلات خبيثة لا تكسر الخادم ولا تُنفَّذ', () => {
  test("SQL injection payload بحقل البريد عند تسجيل الدخول يُرفض بأمان (بلا 500)", async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      form: { email: "' OR '1'='1", password: "' OR '1'='1" },
    });
    expect(res.status()).toBe(401);
    const db = openTestDb();
    try {
      // يثبت أن جدول users لم يتأثر إطلاقاً (لا حذف/تسريب) جراء المحاولة
      const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
      expect(count).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test('نص وصف طلب يحتوي <script> يُخزَّن ويُرجَع كنص خام دون تنفيذ أو كسر JSON', async ({ request }) => {
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل XSS', city: CITY });
    const payload = '<script>alert(1)</script> \' " ; DROP TABLE users; --';
    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      form: { service: SERVICE, description: `وصف يحتوي محتوى خبيث ${payload}`, city: CITY, area: 'القويسمة' },
    });
    expect(createRes.ok()).toBeTruthy();
    const body = await createRes.json();
    expect(body.request.description).toContain('<script>alert(1)</script>');

    const db = openTestDb();
    try {
      const usersStillExist = db.prepare('SELECT COUNT(*) c FROM users').get().c;
      expect(usersStillExist).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test('حمولة نصية ضخمة جداً (200 ألف حرف) بوصف الطلب تُرفض بـ400 بأمان (بلا تعليق أو 500)', async ({ request }) => {
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل نص ضخم', city: CITY });
    const huge = 'أ'.repeat(200000);
    const res = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      form: { service: SERVICE, description: huge, city: CITY, area: 'القويسمة' },
      timeout: 15000,
    });
    // حد الـ1000 حرف (routes/requests.routes.js) يرفضها بأمان قبل أي إدراج بقاعدة البيانات
    expect(res.status()).toBe(400);
  });
});
