// tests/auth-session.spec.js
// يغطي إبطال الجلسات (SEC-FIX-09) وتناسق بيانات req.user الحية (FIX-AUTH-03-REST):
// - تسجيل الخروج يُبطل التوكن القديم فوراً (لا ينتظر انتهاء صلاحيته 7 أيام).
// - تغيير كلمة السر يُبطل التوكن القديم، لكن يُصدر توكناً جديداً صالحاً لنفس الجهاز.
// - إيقاف الأدمن لحساب يقطع فوراً أي اتصال Socket.IO حي بهذا الحساب (SEC-FIX-10).
// - req.user.name يُبنى من بيانات القاعدة الحيّة لا من التوكن المجمَّد وقت إصداره.
// - userPublic() لا يسرّب عمود token_version الداخلي بأي استجابة.

const { test, expect } = require('@playwright/test');
const { io: ioClient } = require('socket.io-client');
const { getPendingOtp } = require('./helpers/db');

function uniqueEmail(tag) {
  return `test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}
function uniquePhone() {
  const suffix = Math.floor(10000000 + Math.random() * 89999999);
  return `07${suffix}`;
}

const VALID_PASSWORD = 'TestPass123';
const CITY = 'عمان';
const ADMIN_EMAIL = 'admin-test@example.com';
const ADMIN_PASSWORD = 'AdminTestPass123';

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

async function registerAndVerify(request, role, extra = {}) {
  const email = uniqueEmail(role);
  const phone = uniquePhone();
  const registerRes = await request.post('/api/auth/register', {
    form: { role, email, phone, password: VALID_PASSWORD, ...extra },
  });
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

test.describe.serial('إبطال الجلسات (token_version) وتناسق req.user الحيّ', () => {
  test('POST /auth/logout — يُبطل التوكن القديم فوراً، لا ينتظر انتهاء صلاحيته', async ({ request }) => {
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل جلسات', city: CITY });

    const before = await request.get('/api/me', { headers: authHeader(customer.token) });
    expect(before.status()).toBe(200);

    const logoutRes = await request.post('/api/auth/logout', { headers: authHeader(customer.token) });
    expect(logoutRes.status()).toBe(200);
    expect((await logoutRes.json()).ok).toBe(true);

    // نفس التوكن بالضبط — كان صالحاً قبل قليل، يجب أن يُرفض الآن فوراً
    const after = await request.get('/api/me', { headers: authHeader(customer.token) });
    expect(after.status()).toBe(401);
  });

  test('POST /me/password — يُبطل التوكن القديم، لكن يُصدر توكناً جديداً صالحاً لنفس الجهاز', async ({ request }) => {
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل تغيير كلمة سر', city: CITY });
    const oldToken = customer.token;

    const changeRes = await request.post('/api/me/password', {
      headers: authHeader(oldToken),
      data: { current_password: VALID_PASSWORD, new_password: 'NewPass456' },
    });
    expect(changeRes.status()).toBe(200);
    const changeBody = await changeRes.json();
    expect(changeBody.ok).toBe(true);
    expect(typeof changeBody.token).toBe('string');
    expect(changeBody.token).not.toBe(oldToken);

    // التوكن القديم أصبح مرفوضاً فوراً (لو كان مسروقاً، لم يعد ينفع بعد الآن)
    const oldStillWorks = await request.get('/api/me', { headers: authHeader(oldToken) });
    expect(oldStillWorks.status()).toBe(401);

    // التوكن الجديد (لنفس الجهاز الذي غيّر كلمة سره) يجب أن يعمل مباشرة —
    // بدون هذا، تغيير كلمة السر كان سيُسجّل خروج المستخدم من جهازه هو أيضاً.
    const newWorks = await request.get('/api/me', { headers: authHeader(changeBody.token) });
    expect(newWorks.status()).toBe(200);
  });

  test('GET /me وغيرها — لا تُسرّب عمود token_version الداخلي إطلاقاً', async ({ request }) => {
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل فحص التسريب', city: CITY });
    const res = await request.get('/api/me', { headers: authHeader(customer.token) });
    const body = await res.json();
    expect(body.user).not.toHaveProperty('token_version');

    const adminToken = await loginAdmin(request);
    const usersRes = await request.get('/api/admin/users', { headers: authHeader(adminToken) });
    const users = (await usersRes.json()).users;
    for (const u of users) expect(u).not.toHaveProperty('token_version');
  });

  test('req.user.name يُبنى من بيانات القاعدة الحيّة — سجل التدقيق يعكس الاسم الجديد فوراً بنفس التوكن القديم', async ({ request }) => {
    const adminToken = await loginAdmin(request);
    const target = await registerAndVerify(request, 'customer', { name: 'عميل هدف', city: CITY });

    // الأدمن يغيّر اسمه هو (بنفس adminToken، بدون تسجيل خروج/دخول جديد إطلاقاً)
    const newAdminName = `أدمن اختبار ${Date.now()}`;
    const updateRes = await request.post('/api/me/profile', {
      multipart: { name: newAdminName, phone: uniquePhone(), city: '', areas: '' },
      headers: authHeader(adminToken),
    });
    expect(updateRes.status()).toBe(200);
    expect((await updateRes.json()).user.name).toBe(newAdminName);

    // نفّذ إجراءً مدقَّقاً بنفس توكن الأدمن القديم (نفس التوكن المُصدَر قبل
    // تغيير الاسم). لو req.user.name كان لا يزال يُبنى من بيانات التوكن
    // المجمَّدة وقت الإصدار (كما كان الحال قبل هذا الإصلاح)، لظهر بسجل
    // التدقيق اسم الأدمن *القديم* رغم أنه غيّره للتو بنفس هذا التوكن بالضبط.
    const toggleRes = await request.post(`/api/admin/users/${target.user.id}/toggle`, {
      headers: authHeader(adminToken),
    });
    expect(toggleRes.status()).toBe(200);
    await request.post(`/api/admin/users/${target.user.id}/toggle`, { headers: authHeader(adminToken) }); // إعادة تفعيل

    const logsRes = await request.get('/api/admin/audit-logs?limit=5', { headers: authHeader(adminToken) });
    const logs = (await logsRes.json()).logs;
    const relevant = logs.find((l) => l.target_type === 'user' && l.target_id === target.user.id);
    expect(relevant).toBeTruthy();
    expect(relevant.actor_name).toBe(newAdminName);
  });

  test('POST /admin/users/:id/toggle — يقطع فوراً اتصال Socket.IO الحي بهذا الحساب', async ({ request, baseURL }) => {
    const adminToken = await loginAdmin(request);
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل سوكت حي', city: CITY });

    const socket = ioClient(baseURL, {
      auth: { token: customer.token },
      transports: ['websocket'],
      reconnection: false,
    });

    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
      setTimeout(() => reject(new Error('انتهت مهلة الاتصال بالسوكت')), 8000);
    });

    const disconnected = new Promise((resolve) => {
      socket.on('disconnect', (reason) => resolve(reason));
      setTimeout(() => resolve(null), 8000);
    });

    const toggleRes = await request.post(`/api/admin/users/${customer.user.id}/toggle`, {
      headers: authHeader(adminToken),
    });
    expect(toggleRes.status()).toBe(200);

    const reason = await disconnected;
    expect(reason).toBe('io server disconnect');

    socket.close();
  });
});
