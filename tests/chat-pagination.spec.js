// tests/chat-pagination.spec.js
// [FEAT-CHATPAGINATION-01] راجع DECISIONS.md — من قائمة `[DEFERRED-AUDIT-10]`
// (مستودع sallehly_app): "لا تصفّح (Pagination) لسجل رسائل الشات — كل رسالة
// جديدة تُعيد تحميل/تحليل المحادثة الكاملة". الحل يمس نقطتين: (1) GET
// /requests/:id/messages تدعم الآن limit/before اختياريَّين لصفحة محدودة
// الحجم، (2) حدثان لحظيان جديدان (message-added لرسالة واحدة جديدة،
// messages-seen لتحديث "تمت المشاهدة" المضغوط) يُبَثان *بالإضافة* للحدث
// القديم messages-updated (الحمولة الكاملة) — لا بدلاً عنه، حتى لا تنكسر أي
// نسخة تطبيق مثبَّتة سابقاً لهذا الإصلاح تعتمد عليه وحده.
//
// يثبت هذا الملف: التوافق الرجعي الكامل (بلا أي معامل، السلوك القديم
// حرفياً)، صفحة limit/before تعمل بشكل صحيح (حجم، ترتيب، hasMore)، وأن
// الحدثين الجديدين يصلان فعلياً بالحمولة الصحيحة بجانب الحدث القديم.

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

// يهيّئ طلباً بعرض مقبول (شات مفتوح فعلياً) ويرسل عدد معيَّن من الرسائل
// النصية بالترتيب، يرجع {requestId, customer, technician}.
async function setupChatWithMessages(request, count) {
  const customer = await registerAndVerify(request, 'customer', { name: 'عميل تصفح الشات', city: CITY });
  const technician = await registerAndVerify(request, 'technician', {
    name: 'فني تصفح الشات', city: CITY, national_number: uniqueNationalNumber(), services: SERVICE, areas: 'القويسمة',
  });

  const createRes = await request.post('/api/requests', {
    headers: authHeader(customer.token),
    form: { service: SERVICE, description: 'طلب لاختبار تصفّح رسائل الشات', city: CITY, area: 'القويسمة' },
  });
  const requestId = (await createRes.json()).request.id;
  const offerRes = await request.post(`/api/requests/${requestId}/offer`, { headers: authHeader(technician.token), form: { offer_price: '10', duration: '20 دقيقة' } });
  const offerId = (await offerRes.json()).offers[0].id;
  await request.post(`/api/offers/${offerId}/decision`, { headers: authHeader(customer.token), form: { decision: 'accepted' } });

  for (let i = 1; i <= count; i++) {
    const res = await request.post(`/api/requests/${requestId}/messages`, {
      headers: authHeader(technician.token),
      form: { body: `رسالة رقم ${i}` },
    });
    expect(res.ok()).toBeTruthy();
  }

  return { requestId, customer, technician };
}

test.describe('[FEAT-CHATPAGINATION-01] GET /requests/:id/messages — limit/before', () => {
  test('بلا أي معامل: السلوك القديم حرفياً — كل الرسائل، تصاعدياً، بلا hasMore', async ({ request }) => {
    const { requestId, customer } = await setupChatWithMessages(request, 5);

    const res = await request.get(`/api/requests/${requestId}/messages`, { headers: authHeader(customer.token) });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    expect(body.messages.length).toBe(5);
    expect(body.messages.map((m) => m.body)).toEqual(['رسالة رقم 1', 'رسالة رقم 2', 'رسالة رقم 3', 'رسالة رقم 4', 'رسالة رقم 5']);
    expect(body.hasMore).toBe(false);
  });

  test('limit=2 يرجع آخر رسالتين فقط، تصاعدياً، مع hasMore=true', async ({ request }) => {
    const { requestId, customer } = await setupChatWithMessages(request, 5);

    const res = await request.get(`/api/requests/${requestId}/messages?limit=2`, { headers: authHeader(customer.token) });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    expect(body.messages.map((m) => m.body)).toEqual(['رسالة رقم 4', 'رسالة رقم 5']);
    expect(body.hasMore).toBe(true);
  });

  test('limit=2&before=<أقدم معرّف بالصفحة الأولى> يرجع الصفحة السابقة مباشرة بلا تكرار', async ({ request }) => {
    const { requestId, customer } = await setupChatWithMessages(request, 5);

    const firstPageRes = await request.get(`/api/requests/${requestId}/messages?limit=2`, { headers: authHeader(customer.token) });
    const firstPage = (await firstPageRes.json()).messages; // رقم 4، رقم 5
    const oldestIdInFirstPage = firstPage[0].id;

    const secondPageRes = await request.get(
      `/api/requests/${requestId}/messages?limit=2&before=${oldestIdInFirstPage}`,
      { headers: authHeader(customer.token) },
    );
    expect(secondPageRes.ok()).toBeTruthy();
    const secondPage = await secondPageRes.json();

    expect(secondPage.messages.map((m) => m.body)).toEqual(['رسالة رقم 2', 'رسالة رقم 3']);
    expect(secondPage.hasMore).toBe(true); // لا تزال رسالة رقم 1 أقدم منها

    // صفحة ثالثة تصل لآخر رسالة متبقية فقط، وhasMore يعود false
    const thirdPageRes = await request.get(
      `/api/requests/${requestId}/messages?limit=2&before=${secondPage.messages[0].id}`,
      { headers: authHeader(customer.token) },
    );
    const thirdPage = await thirdPageRes.json();
    expect(thirdPage.messages.map((m) => m.body)).toEqual(['رسالة رقم 1']);
    expect(thirdPage.hasMore).toBe(false);
  });

  test('limit خارج الحد المعقول (300) يُهمَل بصمت — يرجع لسلوك بلا صفحة', async ({ request }) => {
    const { requestId, customer } = await setupChatWithMessages(request, 3);

    const res = await request.get(`/api/requests/${requestId}/messages?limit=300`, { headers: authHeader(customer.token) });
    const body = await res.json();

    expect(body.messages.length).toBe(3);
    expect(body.hasMore).toBe(false);
  });
});

test.describe('[FEAT-CHATPAGINATION-01] حدثا message-added وmessages-seen اللحظيان الجديدان', () => {
  test('إرسال رسالة نصية: message-added يصل بالرسالة الجديدة فقط، بجانب messages-updated القديم كاملاً', async ({ request, baseURL }) => {
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل حدث الرسالة الجديدة', city: CITY });
    const technician = await registerAndVerify(request, 'technician', {
      name: 'فني حدث الرسالة الجديدة', city: CITY, national_number: uniqueNationalNumber(), services: SERVICE, areas: 'القويسمة',
    });

    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      form: { service: SERVICE, description: 'طلب لاختبار حدث message-added', city: CITY, area: 'القويسمة' },
    });
    const requestId = (await createRes.json()).request.id;
    const offerRes = await request.post(`/api/requests/${requestId}/offer`, { headers: authHeader(technician.token), form: { offer_price: '10', duration: '20 دقيقة' } });
    const offerId = (await offerRes.json()).offers[0].id;
    await request.post(`/api/offers/${offerId}/decision`, { headers: authHeader(customer.token), form: { decision: 'accepted' } });

    const customerSocket = connectSocket(baseURL, customer.token);
    await waitForConnect(customerSocket);
    customerSocket.emit('join-request', requestId);
    await new Promise((r) => setTimeout(r, 200));

    const messageAddedPromise = waitForEvent(customerSocket, 'message-added');
    const messagesUpdatedPromise = waitForEvent(customerSocket, 'messages-updated');

    const sendRes = await request.post(`/api/requests/${requestId}/messages`, {
      headers: authHeader(technician.token),
      form: { body: 'رسالة اختبار الحدث الجديد' },
    });
    expect(sendRes.ok()).toBeTruthy();

    const [addedPayload, updatedPayload] = await Promise.all([messageAddedPromise, messagesUpdatedPromise]);

    expect(addedPayload, 'لم يصل حدث message-added').toBeTruthy();
    expect(addedPayload.requestId).toBe(requestId);
    expect(addedPayload.message.body).toBe('رسالة اختبار الحدث الجديد');
    expect(addedPayload.message.sender_name).toBeTruthy();

    // الحدث القديم لا يزال يصل بالحمولة الكاملة (توافق رجعي) — لم يُستبدَل.
    expect(updatedPayload, 'الحدث القديم messages-updated توقّف عن الوصول — كسر توافق رجعي').toBeTruthy();
    expect(updatedPayload.messages.some((m) => m.body === 'رسالة اختبار الحدث الجديد')).toBeTruthy();

    customerSocket.close();
  });

  test('فتح الشات (GET) يبث messages-seen بمعرّف آخر رسالة قُرئت للطرف الآخر', async ({ request, baseURL }) => {
    const { requestId, customer, technician } = await setupChatWithMessages(request, 2);

    const technicianSocket = connectSocket(baseURL, technician.token);
    await waitForConnect(technicianSocket);
    technicianSocket.emit('join-request', requestId);
    await new Promise((r) => setTimeout(r, 200));

    const lastMessageId = (await (await request.get(`/api/requests/${requestId}/messages`, { headers: authHeader(technician.token) })).json())
      .messages.slice(-1)[0].id;

    const seenPromise = waitForEvent(technicianSocket, 'messages-seen');
    // العميل يفتح الشات (يقرأ الرسالتين اللتين أرسلهما الفني).
    const readRes = await request.get(`/api/requests/${requestId}/messages`, { headers: authHeader(customer.token) });
    expect(readRes.ok()).toBeTruthy();

    const seenPayload = await seenPromise;
    expect(seenPayload, 'لم يصل حدث messages-seen').toBeTruthy();
    expect(seenPayload.requestId).toBe(requestId);
    expect(seenPayload.readerId).toBe(customer.user.id);
    expect(seenPayload.upToMessageId).toBe(lastMessageId);

    technicianSocket.close();
  });
});
