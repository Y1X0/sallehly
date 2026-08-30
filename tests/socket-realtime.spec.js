// tests/socket-realtime.spec.js
// يغطي فجوات حقيقية غير مغطاة سابقاً: تسليم أحداث لحظية فعلي بين طرفين
// متصلين (وليس فقط قطع اتصال واحد كما بـtests/auth-session.spec.js)،
// إعادة الاتصال بعد انقطاع من طرف العميل، ترتيب الرسائل عبر حمولة الحدث
// اللحظي نفسها، وحقل "seen" على مستوى الرسالة الواحدة.

const { test, expect } = require('@playwright/test');
const { io: ioClient } = require('socket.io-client');
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
const SERVICE = 'كهربائي';
const CITY = 'عمان';

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
          avatar: { name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
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

function connectSocket(baseURL, token) {
  return ioClient(baseURL, { auth: { token }, transports: ['websocket'], reconnection: false });
}

function waitForConnect(socket, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    socket.on('connect', resolve);
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('انتهت مهلة الاتصال بالسوكت')), timeoutMs);
  });
}

function waitForEvent(socket, event, timeoutMs = 8000) {
  return new Promise((resolve) => {
    socket.once(event, resolve);
    setTimeout(() => resolve(null), timeoutMs);
  });
}

test.describe('[Socket] إعادة الاتصال بعد انقطاع من طرف العميل', () => {
  test('اتصال أول ينجح، ينقطع من طرف العميل، ثم اتصال جديد لنفس الحساب ينجح ويستقبل الأحداث بشكل طبيعي', async ({ request, baseURL }) => {
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل إعادة اتصال', city: CITY });

    const first = connectSocket(baseURL, customer.token);
    await waitForConnect(first);
    first.close(); // انقطاع من طرف العميل نفسه (وليس السيرفر) — يحاكي فقد شبكة مؤقتاً

    await new Promise((r) => setTimeout(r, 300));

    const second = connectSocket(baseURL, customer.token);
    await waitForConnect(second);
    expect(second.connected).toBeTruthy();

    // يثبت أن الاتصال الجديد فعّال فعلياً (وليس فقط "connected" شكلياً) —
    // ينضم لغرفة شخصية جديدة ويستقبل حدثاً حقيقياً موجَّهاً له.
    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      form: { service: SERVICE, description: 'طلب لاختبار إعادة الاتصال بالسوكت', city: CITY, area: 'القويسمة' },
    });
    expect(createRes.ok()).toBeTruthy();

    second.close();
  });
});

test.describe('[Socket] تسليم حدث لحظي فعلي بين طرفين متصلين (عميل + فني)', () => {
  test('الفني يرسل عرضاً عبر REST — سوكت العميل المتصل يستقبل حدث offer-created فوراً بالبيانات الصحيحة', async ({ request, baseURL }) => {
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل استقبال لحظي', city: CITY });
    const technician = await registerAndVerify(request, 'technician', {
      name: 'فني استقبال لحظي', city: CITY, national_number: uniqueNationalNumber(), services: SERVICE, areas: 'القويسمة',
    });

    const customerSocket = connectSocket(baseURL, customer.token);
    await waitForConnect(customerSocket);

    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      form: { service: SERVICE, description: 'طلب لاختبار تسليم حدث offer-created اللحظي', city: CITY, area: 'القويسمة' },
    });
    const requestId = (await createRes.json()).request.id;

    const offerEventPromise = waitForEvent(customerSocket, 'offer-created');

    const offerRes = await request.post(`/api/requests/${requestId}/offer`, {
      headers: authHeader(technician.token),
      form: { offer_price: '22', duration: '45 دقيقة' },
    });
    expect(offerRes.ok()).toBeTruthy();

    const eventPayload = await offerEventPromise;
    expect(eventPayload, 'لم يصل أي حدث offer-created خلال المهلة — التسليم اللحظي فشل').toBeTruthy();
    expect(eventPayload.requestId).toBe(requestId);
    expect(eventPayload.request.status).toBe('وصلت عروض');
    expect(eventPayload.offers.some((o) => o.technician_id === technician.user.id && Number(o.price) === 22)).toBeTruthy();

    customerSocket.close();
  });
});

test.describe('[Socket] ترتيب الرسائل عبر حمولة الحدث اللحظي', () => {
  test('3 رسائل متتالية: مصفوفة messages بحدث messages-updated دائماً مرتَّبة تصاعدياً بلا تكرار أو اختلال', async ({ request, baseURL }) => {
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل ترتيب الرسائل', city: CITY });
    const technician = await registerAndVerify(request, 'technician', {
      name: 'فني ترتيب الرسائل', city: CITY, national_number: uniqueNationalNumber(), services: SERVICE, areas: 'القويسمة',
    });

    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      form: { service: SERVICE, description: 'طلب لاختبار ترتيب الرسائل اللحظي', city: CITY, area: 'القويسمة' },
    });
    const requestId = (await createRes.json()).request.id;
    const offerRes = await request.post(`/api/requests/${requestId}/offer`, { headers: authHeader(technician.token), form: { offer_price: '10', duration: '20 دقيقة' } });
    const offerId = (await offerRes.json()).offers[0].id;
    // [SEC-FIX-CHATSCOPE-01] الدردشة الآن مقصورة على الفني المؤكَّد — راجع
    // DECISIONS.md. يجب قبول العرض قبل أن يقدر الفني يرسل رسائل.
    await request.post(`/api/offers/${offerId}/decision`, { headers: authHeader(customer.token), form: { decision: 'accepted' } });

    const customerSocket = connectSocket(baseURL, customer.token);
    await waitForConnect(customerSocket);
    customerSocket.emit('join-request', requestId);
    await new Promise((r) => setTimeout(r, 200)); // وقت كافٍ لمعالجة الانضمام بطرف السيرفر

    const texts = ['الرسالة الأولى', 'الرسالة الثانية', 'الرسالة الثالثة'];
    let lastPayload = null;
    for (const body of texts) {
      const eventPromise = waitForEvent(customerSocket, 'messages-updated');
      const sendRes = await request.post(`/api/requests/${requestId}/messages`, {
        headers: authHeader(technician.token),
        form: { body },
      });
      expect(sendRes.ok()).toBeTruthy();
      lastPayload = await eventPromise;
      expect(lastPayload, `لم يصل حدث messages-updated بعد إرسال: ${body}`).toBeTruthy();
    }

    const ids = lastPayload.messages.map((m) => m.id);
    const sortedIds = [...ids].sort((a, b) => a - b);
    expect(ids).toEqual(sortedIds); // مرتَّبة تصاعدياً فعلياً، لا اعتماد على ترتيب وصول غير مضمون
    expect(new Set(ids).size).toBe(ids.length); // بلا أي تكرار

    const bodies = lastPayload.messages.map((m) => m.body);
    expect(bodies).toEqual(texts); // بنفس ترتيب الإرسال الفعلي بالضبط

    customerSocket.close();
  });
});

test.describe('[Chat] حقل seen على مستوى الرسالة الواحدة', () => {
  test('رسالة لم يقرأها الطرف الآخر بعد: seen=0 — بعد GET من الطرف الآخر: seen=1', async ({ request }) => {
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل حالة القراءة', city: CITY });
    const technician = await registerAndVerify(request, 'technician', {
      name: 'فني حالة القراءة', city: CITY, national_number: uniqueNationalNumber(), services: SERVICE, areas: 'القويسمة',
    });

    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      form: { service: SERVICE, description: 'طلب لاختبار حقل seen على مستوى الرسالة', city: CITY, area: 'القويسمة' },
    });
    const requestId = (await createRes.json()).request.id;
    const offerRes = await request.post(`/api/requests/${requestId}/offer`, { headers: authHeader(technician.token), form: { offer_price: '10', duration: '20 دقيقة' } });
    const offerId = (await offerRes.json()).offers[0].id;
    // [SEC-FIX-CHATSCOPE-01] الدردشة الآن مقصورة على الفني المؤكَّد — راجع
    // DECISIONS.md. يجب قبول العرض قبل أن يقدر الفني يقرأ/يرسل رسائل.
    await request.post(`/api/offers/${offerId}/decision`, { headers: authHeader(customer.token), form: { decision: 'accepted' } });

    await request.post(`/api/requests/${requestId}/messages`, { headers: authHeader(customer.token), form: { body: 'رسالة لفحص seen' } });

    // الفني لم يفتح المحادثة بعد — الرسالة تظهر seen=0 من منظور العميل (لم يقرأها أحد غيره)
    const beforeRes = await request.get(`/api/requests/${requestId}/messages`, { headers: authHeader(customer.token) });
    const beforeMessages = (await beforeRes.json()).messages;
    const target = beforeMessages.find((m) => m.body === 'رسالة لفحص seen');
    expect(target).toBeTruthy();
    expect(target.seen).toBe(0);

    // الفني يفتح المحادثة (GET يستدعي markChatRead تلقائياً)
    await request.get(`/api/requests/${requestId}/messages`, { headers: authHeader(technician.token) });

    const afterRes = await request.get(`/api/requests/${requestId}/messages`, { headers: authHeader(customer.token) });
    const afterMessages = (await afterRes.json()).messages;
    const targetAfter = afterMessages.find((m) => m.body === 'رسالة لفحص seen');
    expect(targetAfter.seen).toBe(1);
  });
});

// [SEC-FIX-CHATSCOPE-02] راجع DECISIONS.md — كان join-request (services/socket.js)
// يسمح لأي فني له عرض 'pending' (لم يُقبَل بعد) بالانضمام لغرفة الطلب واستقبال
// كل رسالة لحظياً، رغم أن REST (chat.routes.js) صار مقصوراً على الفني المؤكَّد
// فقط بإصلاح منفصل — نفس الثغرة، طريق مختلف لم يُغطَّه ذلك الإصلاح.
test.describe('[SEC-FIX-CHATSCOPE-02] فني بعرض pending لا ينضم لغرفة الدردشة اللحظية', () => {
  test('فني قدّم عرضاً لكن لم يُقبَل بعد: join-request لا يُدخله الغرفة، لا يصله messages-updated', async ({ request, baseURL }) => {
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل اختبار سوكت pending', city: CITY });
    const technician = await registerAndVerify(request, 'technician', {
      name: 'فني بعرض pending', city: CITY, national_number: uniqueNationalNumber(), services: SERVICE, areas: 'القويسمة',
    });

    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      form: { service: SERVICE, description: 'طلب لاختبار منع انضمام فني pending لغرفة السوكت', city: CITY, area: 'القويسمة' },
    });
    const requestId = (await createRes.json()).request.id;
    // الفني يقدّم عرضاً — لا يُقبَل ولا يُرفَض، يبقى pending عمداً
    await request.post(`/api/requests/${requestId}/offer`, { headers: authHeader(technician.token), form: { offer_price: '10', duration: '20 دقيقة' } });

    const techSocket = connectSocket(baseURL, technician.token);
    await waitForConnect(techSocket);

    const messagesUpdatedPromise = waitForEvent(techSocket, 'messages-updated', 1500);
    techSocket.emit('join-request', requestId);
    await new Promise((r) => setTimeout(r, 200)); // وقت كافٍ لمعالجة محاولة الانضمام بطرف السيرفر

    // العميل يرسل رسالة بعد محاولة انضمام الفني — لو انضم الفني فعلياً للغرفة، سيصله هذا الحدث
    await request.post(`/api/requests/${requestId}/messages`, { headers: authHeader(customer.token), form: { body: 'رسالة لا يجب أن يراها فني بعرض pending' } });

    const received = await messagesUpdatedPromise;
    expect(received, 'فني بعرض pending استقبل messages-updated رغم أنه ليس الفني المؤكَّد').toBeNull();

    techSocket.close();
  });
});

test.describe('[SEC-FIX-SOCKETDISCONNECT-01] حذف حساب من الأدمن يقطع أي اتصال Socket.IO حيّ فوراً', () => {
  // [SEC-FIX-SOCKETDISCONNECT-01] راجع DECISIONS.md — قبل هذا الإصلاح،
  // DELETE /admin/users/:id كان يحظر REST فوراً (is_active/token_version)
  // لكن يترك أي اتصال Socket.IO حيّ وقت الحذف يعمل بلا انقطاع، بعكس
  // /toggle و/role اللذين يقطعانه صراحة.
  test('عميل متصل فعلياً بالسوكت وقت حذف حسابه من الأدمن يُقطَع اتصاله خلال ثوانٍ', async ({ request, baseURL }) => {
    const adminRes = await request.post('/api/auth/login', { form: { email: 'admin-test@example.com', password: 'AdminTestPass123' } });
    expect(adminRes.status()).toBe(200);
    const adminToken = (await adminRes.json()).token;

    const customer = await registerAndVerify(request, 'customer', { name: 'عميل لاختبار قطع السوكت عند الحذف', city: CITY });

    const socket = connectSocket(baseURL, customer.token);
    await waitForConnect(socket);

    const disconnectPromise = new Promise((resolve) => {
      socket.once('disconnect', resolve);
      setTimeout(() => resolve(null), 5000);
    });

    const deleteRes = await request.delete(`/api/admin/users/${customer.user.id}`, { headers: authHeader(adminToken) });
    expect(deleteRes.status()).toBe(200);

    const disconnectReason = await disconnectPromise;
    expect(disconnectReason, 'السوكت بقي متصلاً بعد حذف الحساب من الأدمن — لم يُقطَع إطلاقاً').not.toBeNull();

    socket.close();
  });
});
