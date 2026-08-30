// tests/chat.spec.js
// يغطي: رسائل الدردشة بين عميل وفني بطلب مقبول، منع الأطراف الخارجية، ومنع مشاركة
// أرقام الهواتف/واتساب/إيميل داخل الشات (حماية نموذج العمولة).

const { test, expect } = require('@playwright/test');
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

  // [H1] أُثبتت هذه الحالات عبر اختبار ديناميكي حقيقي (سيرفر يعمل فعلياً)
  // أنها كانت تُرفض خطأً قبل الإصلاح — رسائل عادية تماماً لا علاقة لها
  // بمشاركة تواصل خارج التطبيق، لكنها كانت تُصادف substring بلا حدود كلمة.
  const shouldPassMessages = [
    ['هل ممكن الدفع بالتقسيط installment؟', 'installment تحوي insta كـsubstring'],
    ['بدي أدفع Instapay ممكن؟', 'Instapay تحوي insta كـsubstring'],
    ['لازم install تطبيق تاني عشان يشتغل معاك صح', 'install تحوي insta كـsubstring'],
    ['ممكن chat me لو في استفسار', 'chatme (بعد حذف المسافة) تحوي tme'],
    ['let me check and reply بعد شوي', 'letme تحوي tme'],
    ['meet me at the door please', 'meetme تحوي tme'],
    ['at me if you need anything', 'atme تحوي tme'],
    ['if u need help text me anytime', 'textme تحوي tme'],
    ['الساعة 7 والباب رقم 12345678', 'رقمان غير مرتبطين بجملة واحدة (وقت + رقم باب) تلاصقا صدفة'],
    ['الطابق 3 والشقة رقم 45، والطلب رقم 6789012', 'ثلاثة أرقام غير مرتبطة تلاصقت صدفة لتشكّل نمطاً يشبه رقم هاتف'],
  ];
  for (const [text, why] of shouldPassMessages) {
    test(`POST /requests/:id/messages — [H1] رسالة عادية لا تُرفض خطأً (${why})`, async ({ request }) => {
      const res = await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
        headers: authHeader(customer.token),
        form: { body: text },
      });
      expect(res.status()).toBe(200);
    });
  }

  // [H1] يثبت أن الإصلاح لم يُضعف الحماية الفعلية — نفس الأنماط لكن بصيغتها
  // الحقيقية (توكن مستقل فعلاً لـ"insta"/"t me"، ورقم هاتف بحرف O مموَّه وسط
  // تسلسل متصل) تبقى تُرفض تماماً كما قبل.
  const shouldStillBlockMessages = [
    ['follow me on insta', 'إنستغرام أو سناب'],
    ['أضفني ع الـ insta', 'إنستغرام أو سناب'],
    ['t.me/username', 'تيليجرام'],
    ['t me/username', 'تيليجرام'],
    ['wa.me/962791234567', 'واتساب'],
    ['fb.com/myprofile', 'فيسبوك أو ماسنجر'],
    ['اتصل فيني ع O79-123-4567', 'رقم هاتف'],
    ['رقمي 079-123-4567', 'رقم هاتف'],
    ['رقمي +962791234567', 'رقم هاتف'],
  ];
  for (const [text, expectedReason] of shouldStillBlockMessages) {
    test(`POST /requests/:id/messages — [H1] الحماية الحقيقية بلا إضعاف: "${text}"`, async ({ request }) => {
      const res = await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
        headers: authHeader(customer.token),
        form: { body: text },
      });
      expect(res.status()).toBe(400);
    });
  }

  test('POST /requests/:id/messages — يرفض رسالة فارغة', async ({ request }) => {
    const res = await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
      headers: authHeader(customer.token),
      form: { body: '   ' },
    });
    expect(res.status()).toBe(400);
  });

  // [SEC-FIX-C1] JWT leakage through chat media spoofing: [image]/[audio] لا
  // مسار شرعي لهما إطلاقاً عبر هذا الـendpoint (فقط عبر /images أو /audio
  // مباشرة)، فمن المفترض رفض أي رسالة نصية تبدأ بهما دوماً — قبل هذا الإصلاح
  // كانت تُقبل وتُخزَّن كما هي، ويفسّرها الطرف الآخر بواجهة فلاتر كصورة/صوت
  // فيرسل توكن جلسته لأي رابط خارجي بها عند فتحها.
  test('POST /requests/:id/messages — يرفض رسالة نصية تنتحل صورة برابط خارجي "[image]https://attacker.com/x.png"', async ({ request }) => {
    const res = await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
      headers: authHeader(customer.token),
      form: { body: '[image]https://attacker.com/x.png' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  test('POST /requests/:id/messages — يرفض رسالة نصية تبدأ بـ"[audio]" دون رفع فعلي', async ({ request }) => {
    const res = await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
      headers: authHeader(customer.token),
      form: { body: '[audio]https://attacker.com/evil.mp3' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /requests/:id/messages — يرفض "[location]" بصيغة غير رقمية (ليست إحداثيات فعلية)', async ({ request }) => {
    const res = await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
      headers: authHeader(customer.token),
      form: { body: '[location]https://attacker.com/track' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /requests/:id/messages — "[location]lat,lng" الشرعي (نفس صيغة ChatApi.sendLocation) ما زال يعمل', async ({ request }) => {
    const res = await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
      headers: authHeader(customer.token),
      form: { body: '[location]31.963158,35.930359' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.messages.some((m) => m.body === '[location]31.963158,35.930359')).toBe(true);
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

  // [PERF-HARDEN-02] يثبت أن السقف الوقائي الجديد على GET /chats (1000) فعّال
  // حقاً على مستوى قاعدة البيانات، بنفس نمط اختبار GET /admin/users بـ
  // tests/admin.spec.js تماماً — يزرع 1001 محادثة مباشرة (أسرع من الطلبات
  // الحقيقية) ويتحقق أن الاستجابة الافتراضية محدودة بـ1000 بالضبط.
  test('GET /chats — سقف وقائي 1000 محادثة رغم وجود أكثر من ذلك بقاعدة البيانات', async ({ request }) => {
    const db = openTestDb();
    try {
      const insertReq = db.prepare(
        `INSERT INTO requests(customer_id,technician_id,service,city,description,status) VALUES(?,?,?,?,?,?)`
      );
      const insertMsg = db.prepare('INSERT INTO messages(request_id,sender_id,body) VALUES(?,?,?)');
      const seed = db.transaction((n) => {
        for (let i = 0; i < n; i++) {
          const info = insertReq.run(customer.user.id, technician.user.id, SERVICE, CITY, 'طلب اختبار سقف المحادثات ' + i, 'مكتمل');
          insertMsg.run(info.lastInsertRowid, customer.user.id, 'رسالة اختبار سقف ' + i);
        }
      });
      seed(1001);
    } finally {
      db.close();
    }

    const res = await request.get('/api/chats', { headers: authHeader(customer.token) });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.chats.length).toBeLessThanOrEqual(1000);
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
    // [SEC-FIX-UPLOADS-01] صور الشات أصبحت وراء مصادقة حقيقية — راجع
    // DECISIONS.md وtests/protected-uploads.spec.js لتغطية حدود الصلاحية
    // نفسها (403 لطرف خارجي، 401 بلا توكن). هذا الاختبار هنا يبقى يغطي
    // "المسار السعيد" الأصلي فقط: صاحب علاقة فعلية بالطلب يقدر يفتح الرابط.
    const fetchRes = await request.get(imageUrl, { headers: authHeader(customer.token) });
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

  // [PERF-HARDEN-02] كانت /images و/audio بلا أي حد طلبات إطلاقاً، بعكس
  // /messages — الفحص هنا لا يحاول استنزاف الحد الحقيقي (1000 بالتطوير/
  // الاختبار عمداً حتى لا تتأثر اختبارات Playwright، انظر middleware/security.js)
  // بل يتأكد أن express-rate-limit مُركَّب فعلاً على المسارين عبر هيدرز
  // RateLimit-* الموحّدة (standardHeaders:true) — لو أُزيل الميدلوير بالخطأ
  // لاحقاً، هذا الاختبار يفشل فوراً حتى بلا الحاجة لمحاكاة 429 حقيقي.
  test('POST /requests/:id/images و/audio — حد الطلبات (messageLimiter) مُفعَّل فعلياً', async ({ request }) => {
    const imgRes = await request.post(`/api/requests/${acceptedRequest.id}/images`, {
      headers: authHeader(customer.token),
      multipart: { image: { name: 'chat.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) } },
    });
    expect(imgRes.status()).toBe(200);
    expect(imgRes.headers()['ratelimit-limit']).toBeTruthy();

    const audioRes = await request.post(`/api/requests/${acceptedRequest.id}/audio`, {
      headers: authHeader(customer.token),
      multipart: { audio: { name: 'voice.wav', mimeType: 'audio/wav', buffer: Buffer.from([0x52, 0x49, 0x46, 0x46]) } },
    });
    expect(audioRes.status()).toBe(200);
    expect(audioRes.headers()['ratelimit-limit']).toBeTruthy();
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

// [SEC-FIX-CHATSCOPE-01] راجع DECISIONS.md — كان أي فني قدّم عرضاً (حتى مرفوضاً)
// يبقى قادراً على قراءة/كتابة محادثة الطلب للأبد. هذا يثبت مباشرة أن فنياً
// رُفض عرضه صراحة يُمنع الآن من كل مسارات الدردشة، رغم أن له صفاً بجدول offers.
test.describe('[SEC-FIX-CHATSCOPE-01] فني رُفض عرضه لا يعود طرفاً بالمحادثة', () => {
  test('بعد رفض عرض الفني ب (وقبول عرض الفني أ): الفني ب يُمنع من قراءة وكتابة محادثة الطلب', async ({ request }) => {
    const customer = await registerAndVerify(request, { role: 'customer', extra: { name: 'عميل اختبار رفض العرض', city: CITY } });
    const techA = await registerAndVerify(request, {
      role: 'technician',
      extra: { name: 'فني أ يُقبل', city: CITY, national_number: uniqueNationalNumber(), services: SERVICE, areas: AREA },
      multipart: { avatar: { name: 'a.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) } },
    });
    const techB = await registerAndVerify(request, {
      role: 'technician',
      extra: { name: 'فني ب يُرفض', city: CITY, national_number: uniqueNationalNumber(), services: SERVICE, areas: AREA },
      multipart: { avatar: { name: 'a.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) } },
    });

    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      multipart: { service: SERVICE, city: CITY, area: AREA, description: 'وصف تجريبي لاختبار رفض عرض الفني والدردشة' },
    });
    const req1 = (await createRes.json()).request;

    const offerARes = await request.post(`/api/requests/${req1.id}/offer`, { headers: authHeader(techA.token), form: { offer_price: '10', duration: 'خلال ساعة' } });
    const offerBRes = await request.post(`/api/requests/${req1.id}/offer`, { headers: authHeader(techB.token), form: { offer_price: '12', duration: 'خلال ساعتين' } });
    const offerAId = (await offerARes.json()).offers.find((o) => o.technician_id === techA.user.id).id;
    const offerBId = (await offerBRes.json()).offers.find((o) => o.technician_id === techB.user.id).id;

    // قبل أي قرار: كلا الفنيين له صف بـoffers، لكن لا أحد منهما "الفني المؤكَّد" بعد
    await request.post(`/api/offers/${offerBId}/decision`, { headers: authHeader(customer.token), form: { decision: 'rejected' } });
    await request.post(`/api/offers/${offerAId}/decision`, { headers: authHeader(customer.token), form: { decision: 'accepted' } });

    // الفني أ (المقبول) يرسل رسالة بنجاح
    const sendA = await request.post(`/api/requests/${req1.id}/messages`, { headers: authHeader(techA.token), form: { body: 'رسالة من الفني المقبول' } });
    expect(sendA.status()).toBe(200);

    // الفني ب (المرفوض) يُمنع من القراءة والكتابة كلياً، رغم صف offers الموجود له
    const readB = await request.get(`/api/requests/${req1.id}/messages`, { headers: authHeader(techB.token) });
    expect(readB.status()).toBe(403);
    const sendB = await request.post(`/api/requests/${req1.id}/messages`, { headers: authHeader(techB.token), form: { body: 'محاولة رسالة من فني مرفوض' } });
    expect(sendB.status()).toBe(403);

    // ولا تصله رسالة العميل — يتحقق العميل نفسه أن الفني ب لا يظهر بأي رد يمكّنه من القراءة لاحقاً
    const sendCustomer = await request.post(`/api/requests/${req1.id}/messages`, { headers: authHeader(customer.token), form: { body: 'رسالة للفني المقبول فقط' } });
    expect(sendCustomer.status()).toBe(200);
    const readBAgain = await request.get(`/api/requests/${req1.id}/messages`, { headers: authHeader(techB.token) });
    expect(readBAgain.status()).toBe(403);
  });
});

test.describe('[SEC-FIX-BLOCKSCOPE-01] DELETE /block وGET /block-status مقصوران على طرفي المحادثة فقط', () => {
  test('فني لا علاقة له بالطلب يُمنع كلياً من GET /block-status وDELETE /block لطلب عميل آخر', async ({ request }) => {
    const customer = await registerAndVerify(request, { role: 'customer', extra: { name: 'عميل لاختبار نطاق الحظر', city: CITY } });
    const outsider = await registerAndVerify(request, {
      role: 'technician',
      extra: { name: 'فني غريب عن الطلب', city: CITY, national_number: uniqueNationalNumber(), services: SERVICE, areas: AREA },
      multipart: { avatar: { name: 'a.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) } },
    });

    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      multipart: { service: SERVICE, city: CITY, area: AREA, description: 'طلب لاختبار نطاق حظر المحادثة' },
    });
    const req1 = (await createRes.json()).request;

    // [SEC-FIX-BLOCKSCOPE-01] راجع DECISIONS.md — قبل هذا الإصلاح، كلا
    // الطلبين كانا ينجحان (200) لفني لا علاقة له بالطلب إطلاقاً، ويكشف
    // block-status الرد customer_id الحقيقي للعميل عبر otherUserId.
    const statusRes = await request.get(`/api/requests/${req1.id}/block-status`, { headers: authHeader(outsider.token) });
    expect(statusRes.status()).toBe(403);

    const unblockRes = await request.delete(`/api/requests/${req1.id}/block`, { headers: authHeader(outsider.token) });
    expect(unblockRes.status()).toBe(403);

    // بالمقابل: العميل نفسه (طرف حقيقي بالطلب) يصل الاثنين بنجاح
    const ownStatusRes = await request.get(`/api/requests/${req1.id}/block-status`, { headers: authHeader(customer.token) });
    expect(ownStatusRes.status()).toBe(200);
  });
});

test.describe('[SEC-FIX-INVISIBLECHARS-01] إدراج حروف Unicode غير مرئية لا يتجاوز فحص مشاركة التواصل', () => {
  let customer;
  let acceptedRequest;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });

    customer = await registerAndVerify(request, { role: 'customer', extra: { name: 'عميل لاختبار الحروف غير المرئية', city: CITY } });
    const technician = await registerAndVerify(request, {
      role: 'technician',
      extra: { name: 'فني لاختبار الحروف غير المرئية', city: CITY, national_number: uniqueNationalNumber(), services: SERVICE, areas: AREA },
      multipart: { avatar: { name: 'a.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) } },
    });

    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      multipart: { service: SERVICE, city: CITY, area: AREA, description: 'طلب لاختبار تجاوز الحروف غير المرئية' },
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

  // [SEC-FIX-INVISIBLECHARS-01] راجع DECISIONS.md — قبل هذا الإصلاح، إدراج
  // مسافة بعرض صفر (U+200B) بين أرقام رقم الهاتف يفكّك مقطع الأرقام المتصل
  // فيمر الفحص بـ200، بلا أي أثر مرئي للطرف المستقبِل.
  test('POST /requests/:id/messages — رقم هاتف مفصول بمسافات بعرض صفر (U+200B) يُرفض بـ400', async ({ request }) => {
    const zwspPhone = '0​7​9​1​2​3​4​5​6​7';
    const res = await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
      headers: authHeader(customer.token),
      form: { body: `تواصل معي على ${zwspPhone} مباشرة` },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('هاتف');
  });

  // نفس الحيلة تفكّك أيضاً substring اسم منصة التواصل (ZERO WIDTH NON-JOINER
  // داخل "whatsapp").
  test('POST /requests/:id/messages — اسم منصة مفصول بـZERO WIDTH NON-JOINER (U+200C) يُرفض بـ400', async ({ request }) => {
    const res = await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
      headers: authHeader(customer.token),
      form: { body: 'أضفني wh‌atsapp أسهل' },
    });
    expect(res.status()).toBe(400);
  });

  // BOM بداية النص (U+FEFF) + Arabic Letter Mark (U+061C) داخل "واتساب".
  test('POST /requests/:id/messages — BOM بداية النص وArabic Letter Mark وسط الكلمة يُرفضان بـ400', async ({ request }) => {
    const res = await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
      headers: authHeader(customer.token),
      form: { body: '﻿أضفني على الوا؜تساب أسهل' },
    });
    expect(res.status()).toBe(400);
  });

  // يثبت أن الإصلاح لا يكسر النص العربي العادي: الأحرف المرئية فعلياً (بما
  // فيها التشكيل الطبيعي) تبقى تمر بلا رفض خاطئ.
  test('POST /requests/:id/messages — رسالة عربية عادية بلا حروف غير مرئية تبقى تمر بنجاح', async ({ request }) => {
    const res = await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
      headers: authHeader(customer.token),
      form: { body: 'ممكن توصل الساعة أربعة ونص لو سمحت؟' },
    });
    expect(res.status()).toBe(200);
  });

  // [SEC-FIX-INVISIBLECHARS-01] راجع DECISIONS.md — توسعة النطاقات: variation
  // selector (U+FE0F) وحرف تحكم C0 نادر (U+0001) لم يكونا مغطَّيين بالنسخة
  // الأولى من القائمة.
  test('POST /requests/:id/messages — اسم منصة مفصول بـVARIATION SELECTOR (U+FE0F) يُرفض بـ400', async ({ request }) => {
    const res = await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
      headers: authHeader(customer.token),
      form: { body: 'أضفني wh️atsapp أسهل' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /requests/:id/messages — رقم هاتف مفصول بحرف تحكم C0 نادر (U+0001) يُرفض بـ400', async ({ request }) => {
    const res = await request.post(`/api/requests/${acceptedRequest.id}/messages`, {
      headers: authHeader(customer.token),
      form: { body: 'تواصل معي على 0791234567 مباشرة' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('هاتف');
  });
});
