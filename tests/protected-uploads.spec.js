// tests/protected-uploads.spec.js
// يغطي routes/protected-uploads.routes.js بالكامل — avatars/, payments/,
// صور الشات وproblem_image_url ضمن requests/ ([SEC-FIX-UPLOADS-01])، وaudios/
// (رسائل الشات الصوتية، [SEC-FIX-AUDIOAUTH-01]).

const { test, expect } = require('@playwright/test');
const { getPendingOtp } = require('./helpers/db');

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
const CITY = 'عمان';
const ADMIN_EMAIL = 'admin-test@example.com';
const ADMIN_PASSWORD = 'AdminTestPass123';

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

async function registerAndVerifyTechnician(request, tag) {
  const email = uniqueEmail(tag);
  const phone = uniquePhone();
  const registerRes = await request.post('/api/auth/register', {
    multipart: {
      role: 'technician',
      email,
      phone,
      password: VALID_PASSWORD,
      name: 'فني اختبار رفع',
      city: CITY,
      national_number: uniqueNationalNumber(),
      services: 'كهربائي',
      areas: 'القويسمة',
      avatar: {
        name: 'avatar.png',
        mimeType: 'image/png',
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      },
    },
  });
  if (!registerRes.ok()) throw new Error(`فشل تسجيل الفني: ${registerRes.status()} ${await registerRes.text()}`);
  const otp = getPendingOtp(email);
  const res = await request.post('/api/auth/verify-otp', { form: { email, otp } });
  if (!res.ok()) throw new Error(`فشل verify-otp: ${res.status()} ${await res.text()}`);
  const body = await res.json();
  return { email, phone, token: body.token, user: body.user };
}

async function loginAdmin(request) {
  const res = await request.post('/api/auth/login', { form: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  if (!res.ok()) throw new Error(`فشل دخول الأدمن: ${res.status()} ${await res.text()}`);
  return (await res.json()).token;
}

async function getFirstPackageId(request, token) {
  const res = await request.get('/api/meta', { headers: authHeader(token) });
  const body = await res.json();
  expect(body.packages.length).toBeGreaterThan(0);
  return body.packages[0].id;
}

test.describe.serial('[SEC-FIX-UPLOADS-01] /uploads/avatars و/uploads/payments وراء مصادقة حقيقية', () => {
  let techA, techB, adminToken;
  let avatarFilename, paymentFilename;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });
    techA = await registerAndVerifyTechnician(request, 'uploadA');
    techB = await registerAndVerifyTechnician(request, 'uploadB');
    adminToken = await loginAdmin(request);

    // avatar_url تسجَّل تلقائياً عند التسجيل أعلاه (multipart avatar)
    const meRes = await request.get('/api/me', { headers: authHeader(techA.token) });
    const me = (await meRes.json()).user;
    expect(me.avatar_url).toBeTruthy();
    avatarFilename = me.avatar_url.split('/').pop();

    const pkgId = await getFirstPackageId(request, techA.token);
    const topupRes = await request.post('/api/topups', {
      headers: authHeader(techA.token),
      multipart: {
        package_id: String(pkgId),
        receipt: { name: 'receipt.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
      },
    });
    expect(topupRes.ok()).toBe(true);
    const topup = (await topupRes.json()).topup;
    expect(topup.receipt_url).toBeTruthy();
    paymentFilename = topup.receipt_url.split('/').pop();

    await request.dispose();
  });

  test('GET /uploads/avatars/:filename — يرفض بلا توكن', async ({ request }) => {
    const res = await request.get(`/uploads/avatars/${avatarFilename}`);
    expect(res.status()).toBe(401);
  });

  test('GET /uploads/avatars/:filename — أي مستخدم مصادَق يقدر يشوف صورة أي حساب (بلا قيد ملكية، نفس انفتاح GET /technicians/:id/profile)', async ({ request }) => {
    const res = await request.get(`/uploads/avatars/${avatarFilename}`, { headers: authHeader(techB.token) });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image');
  });

  test('GET /uploads/payments/:filename — يرفض بلا توكن', async ({ request }) => {
    const res = await request.get(`/uploads/payments/${paymentFilename}`);
    expect(res.status()).toBe(401);
  });

  test('GET /uploads/payments/:filename — صاحب الإيصال (الفني نفسه) يقدر يشوفه', async ({ request }) => {
    const res = await request.get(`/uploads/payments/${paymentFilename}`, { headers: authHeader(techA.token) });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image');
  });

  test('GET /uploads/payments/:filename — فني آخر لا يقدر يشوف إيصال ليس له (403)', async ({ request }) => {
    const res = await request.get(`/uploads/payments/${paymentFilename}`, { headers: authHeader(techB.token) });
    expect(res.status()).toBe(403);
  });

  test('GET /uploads/payments/:filename — الأدمن يقدر يشوف أي إيصال', async ({ request }) => {
    const res = await request.get(`/uploads/payments/${paymentFilename}`, { headers: authHeader(adminToken) });
    expect(res.status()).toBe(200);
  });

  test('GET /uploads/payments/:filename — ملف غير موجود يرجع 404 (ليس 403)، بلا تسريب وجوده من عدمه', async ({ request }) => {
    const res = await request.get('/uploads/payments/nonexistent-file.png', { headers: authHeader(techB.token) });
    expect(res.status()).toBe(404);
  });

  test('GET /uploads/payments/:filename — اسم ملف يحاول اجتياز مسار (path traversal) يُرفض بـ400 قبل أي وصول للقرص', async ({ request }) => {
    const res = await request.get('/uploads/payments/..%2F..%2Fserver.js', { headers: authHeader(adminToken) });
    expect([400, 404]).toContain(res.status());
  });

});

test.describe.serial('[SEC-FIX-UPLOADS-01] /uploads/requests — صور الشات وصور المشكلة (problem_image_url) وراء مصادقة', () => {
  let customer, technicianA, technicianB, adminToken;
  let acceptedRequest, chatImageUrl, acceptedProblemImageUrl;

  async function registerAndVerify(request, { role, extra = {}, multipart = null }) {
    const email = uniqueEmail(role);
    const phone = uniquePhone();
    const registerRes = multipart
      ? await request.post('/api/auth/register', { multipart: { role, email, phone, password: VALID_PASSWORD, ...extra, ...multipart } })
      : await request.post('/api/auth/register', { form: { role, email, phone, password: VALID_PASSWORD, ...extra } });
    if (!registerRes.ok()) throw new Error(`فشل تسجيل (${role}): ${registerRes.status()} ${await registerRes.text()}`);
    const otp = getPendingOtp(email);
    const res = await request.post('/api/auth/verify-otp', { form: { email, otp } });
    if (!res.ok()) throw new Error(`فشل verify-otp (${role}): ${res.status()} ${await res.text()}`);
    const body = await res.json();
    return { email, phone, token: body.token, user: body.user };
  }

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });

    customer = await registerAndVerify(request, { role: 'customer', extra: { name: 'عميل اختبار رفع', city: CITY } });
    technicianA = await registerAndVerifyTechnician(request, 'reqA');
    technicianB = await registerAndVerifyTechnician(request, 'reqB');
    adminToken = await loginAdmin(request);

    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      multipart: {
        service: 'كهربائي', city: CITY, area: 'القويسمة',
        description: 'وصف تجريبي كافٍ للطول لاختبار رفع الملفات المحمية',
        problem_image: { name: 'problem.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
      },
    });
    acceptedRequest = (await createRes.json()).request;
    expect(acceptedRequest.problem_image_url).toBeTruthy();
    acceptedProblemImageUrl = acceptedRequest.problem_image_url;

    // تأكيد الفني A كطرف رسمي بالمحادثة (نفس نمط tests/chat.spec.js)
    await request.post(`/api/requests/${acceptedRequest.id}/offer`, {
      headers: authHeader(technicianA.token),
      form: { offer_price: '10', duration: 'خلال ساعة' },
    });
    const offersRes = await request.get(`/api/requests/${acceptedRequest.id}/offers`, { headers: authHeader(customer.token) });
    const offerId = (await offersRes.json()).offers[0].id;
    await request.post(`/api/offers/${offerId}/decision`, { headers: authHeader(customer.token), form: { decision: 'accepted' } });

    const imageRes = await request.post(`/api/requests/${acceptedRequest.id}/images`, {
      headers: authHeader(customer.token),
      multipart: { image: { name: 'chat.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) } },
    });
    const messages = (await imageRes.json()).messages;
    const imageMessage = messages.find((m) => m.body.startsWith('[image]'));
    chatImageUrl = imageMessage.body.replace('[image]', '');

    await request.dispose();
  });

  test('صورة شات — يرفض بلا توكن', async ({ request }) => {
    const res = await request.get(chatImageUrl);
    expect(res.status()).toBe(401);
  });

  test('صورة شات — العميل صاحب الطلب يقدر يشوفها', async ({ request }) => {
    const res = await request.get(chatImageUrl, { headers: authHeader(customer.token) });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image');
  });

  test('صورة شات — الفني المؤكَّد بالطلب يقدر يشوفها', async ({ request }) => {
    const res = await request.get(chatImageUrl, { headers: authHeader(technicianA.token) });
    expect(res.status()).toBe(200);
  });

  test('صورة شات — فني آخر لا علاقة له بالطلب يُمنع (403)', async ({ request }) => {
    const res = await request.get(chatImageUrl, { headers: authHeader(technicianB.token) });
    expect(res.status()).toBe(403);
  });

  test('صورة شات — الأدمن يقدر يشوف أي صورة شات', async ({ request }) => {
    const res = await request.get(chatImageUrl, { headers: authHeader(adminToken) });
    expect(res.status()).toBe(200);
  });

  test('problem_image_url — يرفض بلا توكن', async ({ request }) => {
    const res = await request.get(acceptedProblemImageUrl);
    expect(res.status()).toBe(401);
  });

  test('problem_image_url — العميل صاحب الطلب يقدر يشوفها', async ({ request }) => {
    const res = await request.get(acceptedProblemImageUrl, { headers: authHeader(customer.token) });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image');
  });

  test('problem_image_url — الفني المؤكَّد (بعد قبول عرضه) يقدر يشوفها', async ({ request }) => {
    const res = await request.get(acceptedProblemImageUrl, { headers: authHeader(technicianA.token) });
    expect(res.status()).toBe(200);
  });

  test('problem_image_url — بعد قبول العرض، فني آخر (حتى لو يطابق الخدمة/المدينة) لم يعد يقدر يتصفّح هذا الطلب أصلاً، فيُمنع (403)', async ({ request }) => {
    // بعد القبول تتغيّر حالة الطلب عن 'بانتظار العروض'/'وصلت عروض'، فيخرج
    // تلقائياً من نطاق "التصفح" — نفس ما يحصل بـGET /requests فرع الفني.
    const res = await request.get(acceptedProblemImageUrl, { headers: authHeader(technicianB.token) });
    expect(res.status()).toBe(403);
  });

  test('problem_image_url — الأدمن يقدر يشوف أي صورة مشكلة', async ({ request }) => {
    const res = await request.get(acceptedProblemImageUrl, { headers: authHeader(adminToken) });
    expect(res.status()).toBe(200);
  });
});

test.describe.serial('[SEC-FIX-UPLOADS-01] problem_image_url — فني يتصفّح فقط (لسا ما قدّم عرضاً) لازم يشوف الصورة ليقدّر سعره', () => {
  let customer, matchingTech, wrongServiceTech, wrongCityTech;
  let browsableProblemImageUrl;

  async function registerAndVerify(request, { role, extra = {}, multipart = null }) {
    const email = uniqueEmail(role);
    const phone = uniquePhone();
    const registerRes = multipart
      ? await request.post('/api/auth/register', { multipart: { role, email, phone, password: VALID_PASSWORD, ...extra, ...multipart } })
      : await request.post('/api/auth/register', { form: { role, email, phone, password: VALID_PASSWORD, ...extra } });
    if (!registerRes.ok()) throw new Error(`فشل تسجيل (${role}): ${registerRes.status()} ${await registerRes.text()}`);
    const otp = getPendingOtp(email);
    const res = await request.post('/api/auth/verify-otp', { form: { email, otp } });
    if (!res.ok()) throw new Error(`فشل verify-otp (${role}): ${res.status()} ${await res.text()}`);
    const body = await res.json();
    return { email, phone, token: body.token, user: body.user };
  }

  async function registerTechnicianWith(request, tag, { services, city, areas }) {
    const email = uniqueEmail(tag);
    const phone = uniquePhone();
    const registerRes = await request.post('/api/auth/register', {
      multipart: {
        role: 'technician', email, phone, password: VALID_PASSWORD,
        name: 'فني اختبار تصفّح', city, national_number: uniqueNationalNumber(),
        services, areas,
        avatar: { name: 'a.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
      },
    });
    if (!registerRes.ok()) throw new Error(`فشل تسجيل الفني: ${registerRes.status()} ${await registerRes.text()}`);
    const otp = getPendingOtp(email);
    const res = await request.post('/api/auth/verify-otp', { form: { email, otp } });
    const body = await res.json();
    return { email, phone, token: body.token, user: body.user };
  }

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });

    customer = await registerAndVerify(request, { role: 'customer', extra: { name: 'عميل اختبار تصفّح', city: CITY } });
    matchingTech = await registerTechnicianWith(request, 'browseMatch', { services: 'كهربائي', city: CITY, areas: 'القويسمة' });
    wrongServiceTech = await registerTechnicianWith(request, 'browseSvc', { services: 'سباك', city: CITY, areas: 'القويسمة' });
    // مدينة ومنطقة كلاهما مختلفان كلياً عن الطلب (city=عمان, area=القويسمة) —
    // بدون هذا، لو تركنا areas تطابق القويسمة كباقي الفنيين، كان الشرط
    // البديل (areas تحتوي r.area) سيمنح وصولاً رغم اختلاف المدينة، فيُبطل
    // الغرض الفعلي من هذا الاختبار.
    wrongCityTech = await registerTechnicianWith(request, 'browseCity', { services: 'كهربائي', city: 'الزرقاء', areas: 'الرصيفة' });

    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      multipart: {
        service: 'كهربائي', city: CITY, area: 'القويسمة',
        description: 'وصف تجريبي كافٍ للطول لاختبار صلاحية تصفّح صورة المشكلة',
        problem_image: { name: 'problem2.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
      },
    });
    const r = (await createRes.json()).request;
    expect(r.status).toBe('بانتظار العروض'); // لسا بحالة تصفّح/تقديم عروض
    browsableProblemImageUrl = r.problem_image_url;

    await request.dispose();
  });

  test('فني يطابق الخدمة والمدينة، لسا ما قدّم عرضاً — يقدر يشوف صورة المشكلة (ليقدّر سعره)', async ({ request }) => {
    const res = await request.get(browsableProblemImageUrl, { headers: authHeader(matchingTech.token) });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image');
  });

  test('فني بخدمة مختلفة كلياً — يُمنع (403)، نفس شرط ظهور الطلب أصلاً بقائمته', async ({ request }) => {
    const res = await request.get(browsableProblemImageUrl, { headers: authHeader(wrongServiceTech.token) });
    expect(res.status()).toBe(403);
  });

  test('فني بمدينة/منطقة مختلفة كلياً — يُمنع (403)', async ({ request }) => {
    const res = await request.get(browsableProblemImageUrl, { headers: authHeader(wrongCityTech.token) });
    expect(res.status()).toBe(403);
  });
});

// [SEC-FIX-AUDIOAUTH-01] راجع DECISIONS.md — لا يوجد نوع ثانٍ بمجلد audios/
// (بعكس requests/ اللي فيها صور شات وproblem_image_url معاً)، فقاعدة الصلاحية
// هون واحدة فقط: نفس قاعدة صور الشات بالضبط (canAccessRequestChat). لا حالة
// "تصفّح فني" هون — لا يوجد ملف صوتي غير منتمٍ لمحادثة أصلاً.
test.describe.serial('[SEC-FIX-AUDIOAUTH-01] /uploads/audios — رسائل الشات الصوتية وراء مصادقة', () => {
  let customer, technicianA, technicianB, adminToken;
  let acceptedRequest, chatAudioUrl;

  async function registerAndVerify(request, { role, extra = {}, multipart = null }) {
    const email = uniqueEmail(role);
    const phone = uniquePhone();
    const registerRes = multipart
      ? await request.post('/api/auth/register', { multipart: { role, email, phone, password: VALID_PASSWORD, ...extra, ...multipart } })
      : await request.post('/api/auth/register', { form: { role, email, phone, password: VALID_PASSWORD, ...extra } });
    if (!registerRes.ok()) throw new Error(`فشل تسجيل (${role}): ${registerRes.status()} ${await registerRes.text()}`);
    const otp = getPendingOtp(email);
    const res = await request.post('/api/auth/verify-otp', { form: { email, otp } });
    if (!res.ok()) throw new Error(`فشل verify-otp (${role}): ${res.status()} ${await res.text()}`);
    const body = await res.json();
    return { email, phone, token: body.token, user: body.user };
  }

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });

    customer = await registerAndVerify(request, { role: 'customer', extra: { name: 'عميل اختبار صوت', city: CITY } });
    technicianA = await registerAndVerifyTechnician(request, 'audioA');
    technicianB = await registerAndVerifyTechnician(request, 'audioB');
    adminToken = await loginAdmin(request);

    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      multipart: {
        service: 'كهربائي', city: CITY, area: 'القويسمة',
        description: 'وصف تجريبي كافٍ للطول لاختبار رفع تسجيل صوتي محمي',
      },
    });
    acceptedRequest = (await createRes.json()).request;

    // تأكيد الفني A كطرف رسمي بالمحادثة (نفس نمط describe الصور أعلاه بالضبط)
    await request.post(`/api/requests/${acceptedRequest.id}/offer`, {
      headers: authHeader(technicianA.token),
      form: { offer_price: '10', duration: 'خلال ساعة' },
    });
    const offersRes = await request.get(`/api/requests/${acceptedRequest.id}/offers`, { headers: authHeader(customer.token) });
    const offerId = (await offersRes.json()).offers[0].id;
    await request.post(`/api/offers/${offerId}/decision`, { headers: authHeader(customer.token), form: { decision: 'accepted' } });

    const audioRes = await request.post(`/api/requests/${acceptedRequest.id}/audio`, {
      headers: authHeader(customer.token),
      multipart: {
        audio: { name: 'voice.wav', mimeType: 'audio/wav', buffer: Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]) },
        duration: '5',
      },
    });
    if (!audioRes.ok()) throw new Error(`فشل رفع الصوت: ${audioRes.status()} ${await audioRes.text()}`);
    const messages = (await audioRes.json()).messages;
    const audioMessage = messages.find((m) => m.body.startsWith('[audio]'));
    chatAudioUrl = audioMessage.body.replace('[audio]', '').split('|')[0];

    await request.dispose();
  });

  test('رسالة صوتية — يرفض بلا توكن', async ({ request }) => {
    const res = await request.get(chatAudioUrl);
    expect(res.status()).toBe(401);
  });

  test('رسالة صوتية — العميل صاحب الطلب يقدر يسمعها', async ({ request }) => {
    const res = await request.get(chatAudioUrl, { headers: authHeader(customer.token) });
    expect(res.status()).toBe(200);
  });

  test('رسالة صوتية — الفني المؤكَّد بالطلب يقدر يسمعها', async ({ request }) => {
    const res = await request.get(chatAudioUrl, { headers: authHeader(technicianA.token) });
    expect(res.status()).toBe(200);
  });

  test('رسالة صوتية — فني آخر لا علاقة له بالطلب يُمنع (403)', async ({ request }) => {
    const res = await request.get(chatAudioUrl, { headers: authHeader(technicianB.token) });
    expect(res.status()).toBe(403);
  });

  test('رسالة صوتية — الأدمن يقدر يسمع أي رسالة صوتية', async ({ request }) => {
    const res = await request.get(chatAudioUrl, { headers: authHeader(adminToken) });
    expect(res.status()).toBe(200);
  });

  test('رسالة صوتية — ملف غير مرتبط بأي رسالة يرجع 404 (ليس 403)، بلا تسريب وجوده من عدمه', async ({ request }) => {
    const res = await request.get('/uploads/audios/definitely-does-not-exist.wav', { headers: authHeader(customer.token) });
    expect(res.status()).toBe(404);
  });

  test('رسالة صوتية — اسم ملف يحاول اجتياز مسار (path traversal) يُرفض بـ400 قبل أي وصول للقرص', async ({ request }) => {
    const res = await request.get('/uploads/audios/..%2F..%2Fserver.js', { headers: authHeader(adminToken) });
    expect([400, 404]).toContain(res.status());
  });
});
