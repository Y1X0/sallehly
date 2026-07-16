// tests/chat.spec.js
// يغطي: رسائل الدردشة بين عميل وفني بطلب مقبول، منع الأطراف الخارجية، ومنع مشاركة
// أرقام الهواتف/واتساب/إيميل داخل الشات (حماية نموذج العمولة).

const { test, expect } = require('@playwright/test');
const { getPendingOtp } = require('./helpers/db');

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
const CITY = 'عمان';
const SERVICE = 'كهربائي';
const AREA = 'القويسمة';

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

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
  if (!body.token) throw new Error(`لا يوجد توكن (${role}): ${JSON.stringify(body)}`);
  return { email, phone, token: body.token, user: body.user };
}

test.describe.serial('الدردشة على الطلبات', () => {
  let customer;
  let technician;
  let outsider; // فني آخر غير طرف بهذا الطلب
  let acceptedRequest;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });

    customer = await registerAndVerify(request, { role: 'customer', extra: { name: 'عميل اختبار شات', city: CITY } });
    technician = await registerAndVerify(request, {
      role: 'technician',
      extra: { name: 'فني اختبار شات', city: CITY, national_number: uniqueNationalNumber(), services: SERVICE, areas: AREA },
      multipart: { avatar: { name: 'a.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) } },
    });
    outsider = await registerAndVerify(request, {
      role: 'technician',
      extra: { name: 'فني خارج الطلب', city: CITY, national_number: uniqueNationalNumber(), services: SERVICE, areas: AREA },
      multipart: { avatar: { name: 'a.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) } },
    });

    // إنشاء طلب وقبول عرض الفني عليه حتى يصير طرفاً رسمياً بالمحادثة
    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      multipart: { service: SERVICE, city: CITY, area: AREA, description: 'وصف تجريبي كافٍ للطول لاختبار الدردشة' },
    });
    acceptedRequest = (await createRes.json()).request;

    await request.post(`/api/requests/${acceptedRequest.id}/offer`, {
      headers: authHeader(technician.token),
      form: { offer_price: '10', duration: 'خلال ساعة' },
    });
    const offersRes = await request.get(`/api/requests/${acceptedRequest.id}/offers`, { headers: authHeader(customer.token) });
    const offerId = (await offersRes.json()).offers[0].id;
    await request.post(`/api/offers/${offerId}/decision`, { headers: authHeader(customer.token), form: { decision: 'accepted' } });

    await request.dispose();
  });

  test('POST /requests/:id/messages — يرفض طرفاً خارجياً غير مرتبط بالطلب', async ({ request }) => {
    const res = await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
      headers: authHeader(outsider.token),
      form: { body: 'مرحباً، أريد المساعدة' },
    });
    expect(res.status()).toBe(403);
  });

  test('POST /requests/:id/messages — العميل يرسل رسالة عادية بنجاح', async ({ request }) => {
    const res = await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
      headers: authHeader(customer.token),
      form: { body: 'أهلاً، متى تصل تقريباً؟' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.messages.some((m) => m.body.includes('متى تصل'))).toBe(true);
  });

  test('POST /requests/:id/messages — الفني يرد ورسالته تظهر بالمحادثة', async ({ request }) => {
    const res = await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
      headers: authHeader(technician.token),
      form: { body: 'خلال نصف ساعة إن شاء الله' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.messages.length).toBeGreaterThanOrEqual(2);
  });

  test('POST /requests/:id/messages — يرفض رسالة تحتوي رقم هاتف أردني ويسجّلها كمخالفة', async ({ request }) => {
    const res = await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
      headers: authHeader(customer.token),
      form: { body: 'تواصل معي على 0791234567 مباشرة' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('هاتف');
  });

  test('POST /requests/:id/messages — يرفض رسالة تحتوي واتساب', async ({ request }) => {
    const res = await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
      headers: authHeader(customer.token),
      form: { body: 'أضفني على الواتساب أسهل' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /requests/:id/messages — يرفض رسالة فارغة', async ({ request }) => {
    const res = await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
      headers: authHeader(customer.token),
      form: { body: '   ' },
    });
    expect(res.status()).toBe(400);
  });

  test('GET /requests/:id/messages — يرفض طرفاً خارجياً', async ({ request }) => {
    const res = await request.get(`/api/requests/${acceptedRequest.id}/messages`, {
      headers: authHeader(outsider.token),
    });
    expect(res.status()).toBe(403);
  });

  test('GET /requests/:id/messages — الطرفان يريان نفس سجل المحادثة', async ({ request }) => {
    const asCustomer = await request.get(`/api/requests/${acceptedRequest.id}/messages`, { headers: authHeader(customer.token) });
    const asTechnician = await request.get(`/api/requests/${acceptedRequest.id}/messages`, { headers: authHeader(technician.token) });
    expect(asCustomer.status()).toBe(200);
    expect(asTechnician.status()).toBe(200);
    const c = (await asCustomer.json()).messages;
    const t = (await asTechnician.json()).messages;
    expect(c.length).toBe(t.length);
  });

  test('GET /chats — العميل يرى الطلب ضمن قائمة محادثاته', async ({ request }) => {
    const res = await request.get('/api/chats', { headers: authHeader(customer.token) });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.chats.some((c) => c.request_id === acceptedRequest.id)).toBe(true);
  });

  // [FIX-CHATUNREAD-01] يتحقق من أن unread_count/total_unread بـGET /chats
  // يعكسان فعلياً رسالة جديدة لم تُقرأ، ويُصفَّران فور فتح المحادثة (نفس
  // آلية markChatRead المستخدَمة أصلاً بـGET /requests/:id/messages) —
  // هذه هي البنية التي يعتمد عليها تطبيق الفلاتر بالواجهة (شارات غير المقروء).
  test('GET /chats — unread_count يعكس رسالة جديدة لم تُقرأ، ويُصفّر بعد القراءة', async ({ request }) => {
    await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
      headers: authHeader(technician.token),
      form: { body: 'وصلت تقريباً، افتح الباب من فضلك' },
    });

    const beforeRead = await request.get('/api/chats', { headers: authHeader(customer.token) });
    const beforeBody = await beforeRead.json();
    const chatBefore = beforeBody.chats.find((c) => c.request_id === acceptedRequest.id);
    expect(chatBefore.unread_count).toBeGreaterThanOrEqual(1);
    expect(beforeBody.total_unread).toBeGreaterThanOrEqual(chatBefore.unread_count);

    // العميل يفتح المحادثة — GET /messages يستدعي markChatRead تلقائياً.
    await request.get(`/api/requests/${acceptedRequest.id}/messages`, { headers: authHeader(customer.token) });

    const afterRead = await request.get('/api/chats', { headers: authHeader(customer.token) });
    const afterBody = await afterRead.json();
    const chatAfter = afterBody.chats.find((c) => c.request_id === acceptedRequest.id);
    expect(chatAfter.unread_count).toBe(0);

    // رسالة الفني نفسها (مُرسِلها) لا تُحسب أبداً ضمن غير مقروء الفني.
    const technicianChats = await request.get('/api/chats', { headers: authHeader(technician.token) });
    const technicianBody = await technicianChats.json();
    const chatForTechnician = technicianBody.chats.find((c) => c.request_id === acceptedRequest.id);
    expect(chatForTechnician.unread_count).toBe(0);
  });

  test('GET /chat-violations — الأدمن فقط يقدر يشوف سجل المخالفات', async ({ request }) => {
    const forbidden = await request.get('/api/chat-violations', { headers: authHeader(customer.token) });
    expect(forbidden.status()).toBe(403);
  });

  // [FIX-CHATIMG-01] كانت صور الشات تُحفَظ فعلياً بمجلد avatars/ بينما الرابط
  // المُرجَع بالرسالة يشير لمجلد requests/ — فيفشل تحميلها دائماً بـ404. هذا
  // الاختبار يتأكد أن الرابط المُرجَع فعلياً قابل للجلب، لا فقط أن الرفع نجح.
  test('POST /requests/:id/images — الصورة المرفوعة تُخزَّن وتُقرأ من نفس الرابط المُرجَع', async ({ request }) => {
    const uploadRes = await request.post(`/api/requests/${acceptedRequest.id}/images`, {
      headers: authHeader(customer.token),
      multipart: { image: { name: 'chat.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) } },
    });
    expect(uploadRes.status()).toBe(200);
    const messages = (await uploadRes.json()).messages;
    const imageMessage = messages.find((m) => m.body.startsWith('[image]'));
    expect(imageMessage).toBeTruthy();

    const imageUrl = imageMessage.body.replace('[image]', '');
    expect(imageUrl).toMatch(/^\/uploads\/requests\//);

    // الفحص الحقيقي لهذا الإصلاح: الرابط نفسه يرجع الصورة فعلاً، وليس 404.
    const fetchRes = await request.get(imageUrl);
    expect(fetchRes.status()).toBe(200);
    expect(fetchRes.headers()['content-type']).toContain('image');
  });

  test('POST /requests/:id/images — يرفض طرفاً خارجياً غير مرتبط بالطلب', async ({ request }) => {
    const res = await request.post(`/api/requests/${acceptedRequest.id}/images`, {
      headers: authHeader(outsider.token),
      multipart: { image: { name: 'chat.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) } },
    });
    expect(res.status()).toBe(403);
  });

  // [FIX-AUDIODUR-01] المدة المُرسَلة مع التسجيل تُخزَّن وتُرجَع ضمن body،
  // والرابط المُرجَع يبقى قابلاً للجلب فعلياً رغم إضافة '|<duration>' له
  // (نفس فحص "الرابط الحقيقي يعمل" المُطبَّق أعلاه على الصور).
  test('POST /requests/:id/audio — المدة المُرسَلة تُخزَّن وتُرجَع، والرابط يبقى صالحاً', async ({ request }) => {
    const uploadRes = await request.post(`/api/requests/${acceptedRequest.id}/audio`, {
      headers: authHeader(customer.token),
      multipart: {
        audio: { name: 'voice.wav', mimeType: 'audio/wav', buffer: Buffer.from([0x52, 0x49, 0x46, 0x46]) },
        duration: '42',
      },
    });
    expect(uploadRes.status()).toBe(200);
    const messages = (await uploadRes.json()).messages;
    const audioMessage = messages.findLast((m) => m.body.startsWith('[audio]'));
    expect(audioMessage).toBeTruthy();
    expect(audioMessage.body).toMatch(/\|42$/);

    const audioUrl = audioMessage.body.replace('[audio]', '').split('|')[0];
    expect(audioUrl).toMatch(/^\/uploads\/audios\//);

    const fetchRes = await request.get(audioUrl);
    expect(fetchRes.status()).toBe(200);
  });

  test('POST /requests/:id/audio — بلا مدة (توافق قديم)، أو بمدة غير صالحة: لا يُضاف أي لاحقة كسر الرابط', async ({ request }) => {
    const noDuration = await request.post(`/api/requests/${acceptedRequest.id}/audio`, {
      headers: authHeader(technician.token),
      multipart: { audio: { name: 'voice.wav', mimeType: 'audio/wav', buffer: Buffer.from([0x52, 0x49, 0x46, 0x46]) } },
    });
    expect(noDuration.status()).toBe(200);
    const msgs1 = (await noDuration.json()).messages;
    const m1 = msgs1.findLast((m) => m.body.startsWith('[audio]'));
    expect(m1.body).not.toContain('|');

    const invalidDuration = await request.post(`/api/requests/${acceptedRequest.id}/audio`, {
      headers: authHeader(technician.token),
      multipart: {
        audio: { name: 'voice.wav', mimeType: 'audio/wav', buffer: Buffer.from([0x52, 0x49, 0x46, 0x46]) },
        duration: '99999',
      },
    });
    expect(invalidDuration.status()).toBe(200);
    const msgs2 = (await invalidDuration.json()).messages;
    const m2 = msgs2.findLast((m) => m.body.startsWith('[audio]'));
    expect(m2.body).not.toContain('|');
  });
});
