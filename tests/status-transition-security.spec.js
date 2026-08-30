// tests/status-transition-security.spec.js
// [SEC-FIX-STATUSFLOW-01] راجع DECISIONS.md وroutes/requests.routes.js —
// قبل هذا الإصلاح، POST /requests/:id/status لم يتحقق من أن الحالة الحالية
// تسمح فعلياً بالانتقال المطلوب (فقط "ليست مغلقة أصلاً"). هذا كان يسمح لأي
// عميل بإكمال طلبه الخاص بلا أي عرض فني حقيقي مقبول إطلاقاً — بما في ذلك
// حالة أخطر: تعيين technician_id مباشرة عند الإنشاء (حقل حقيقي بالـAPI، غير
// مستخدَم من تطبيق العميل إطلاقاً) ثم إكمال الطلب فوراً، فيُخصَم من رصيد فني
// لم يوافق على أي شيء إطلاقاً، ويصير قابلاً لتقييم سلبي دائم ضده.
// هذا الملف يثبت أن كلا المسارين مسدودان الآن.

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

test.describe('[SEC-FIX-STATUSFLOW-01] لا إكمال (أو تقدّم حالة) بلا عرض فني مقبول فعلياً', () => {

  test('طلب عادي بلا أي عرض إطلاقاً: محاولة إكماله تُرفض بـ409، ولا عمولة تُخصَم، ولا يصير قابلاً للتقييم', async ({ request }) => {
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل تجربة الاستغلال', city: CITY });

    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      form: { service: SERVICE, city: CITY, area: 'القويسمة', description: 'طلب بلا أي عرض على الإطلاق' },
    });
    expect(createRes.ok()).toBeTruthy();
    const requestId = (await createRes.json()).request.id;

    const forceCompleteRes = await request.post(`/api/requests/${requestId}/status`, {
      headers: authHeader(customer.token),
      form: { status: 'مكتمل' },
    });
    expect(forceCompleteRes.status()).toBe(409);
    expect((await forceCompleteRes.json()).code).toBe('STATUS_TRANSITION_INVALID');

    const checkDb = openTestDb();
    try {
      const dbRow = checkDb.prepare('SELECT status, commission_charged, technician_id FROM requests WHERE id=?').get(requestId);
      expect(dbRow.status).toBe('بانتظار العروض');
      expect(dbRow.commission_charged).toBeNull();
      expect(dbRow.technician_id).toBeNull();
    } finally {
      checkDb.close();
    }

    // محاولة تقييم طلب لم يكتمل فعلياً — يجب أن تُرفض أيضاً (نفس نمط الفحص
    // الموجود أصلاً بمسار /rate: status='مكتمل' مطلوبة).
    const rateRes = await request.post(`/api/requests/${requestId}/rate`, {
      headers: authHeader(customer.token),
      form: { stars: '1', comment: 'محاولة تقييم غير شرعية' },
    });
    expect(rateRes.status()).toBe(400);
  });

  test('طلب موجَّه مباشرة لفني (technician_id عبر إنشاء الطلب) لم يقدّم عرضاً إطلاقاً: لا يمكن إكماله، ولا يُخصَم من رصيده أو حصته المجانية', async ({ request }) => {
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل تجربة الاستغلال الثاني', city: CITY });
    const technician = await registerAndVerify(request, 'technician', {
      name: 'فني لم يوافق على شيء', city: CITY, national_number: uniqueNationalNumber(), services: SERVICE, areas: 'القويسمة',
    });

    const setupDb = openTestDb();
    let beforeBalance;
    try {
      beforeBalance = setupDb.prepare('SELECT balance, free_orders_used, completed_jobs FROM users WHERE id=?').get(technician.user.id);
    } finally {
      setupDb.close();
    }

    // [استغلال محتمَل] العميل يستهدف الفني مباشرة عبر technician_id عند
    // الإنشاء — حقل حقيقي بالـAPI (راجع routes/requests.routes.js) لكن غير
    // مستخدَم من تطبيق العميل الحقيقي إطلاقاً. الفني لم يُقدِّم أي عرض بعد.
    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      form: { service: SERVICE, city: CITY, area: 'القويسمة', description: 'طلب موجَّه مباشرة بلا موافقة الفني', technician_id: String(technician.user.id) },
    });
    expect(createRes.ok()).toBeTruthy();
    const body = await createRes.json();
    expect(body.request.technician_id).toBe(technician.user.id);
    expect(body.request.status).toBe('بانتظار العروض'); // لا يُقفز مباشرة لأي حالة موافقة

    const requestId = body.request.id;

    // محاولة الاستغلال الكاملة: إكمال فوري بلا أي عرض قُدِّم أو قُبِل.
    const forceCompleteRes = await request.post(`/api/requests/${requestId}/status`, {
      headers: authHeader(customer.token),
      form: { status: 'مكتمل' },
    });
    expect(forceCompleteRes.status()).toBe(409);
    expect((await forceCompleteRes.json()).code).toBe('STATUS_TRANSITION_INVALID');

    const checkDb = openTestDb();
    try {
      const afterBalance = checkDb.prepare('SELECT balance, free_orders_used, completed_jobs FROM users WHERE id=?').get(technician.user.id);
      expect(afterBalance).toEqual(beforeBalance); // لا أثر مالي على الفني إطلاقاً

      const dbRow = checkDb.prepare('SELECT status, commission_charged FROM requests WHERE id=?').get(requestId);
      expect(dbRow.status).toBe('بانتظار العروض');
      expect(dbRow.commission_charged).toBeNull();
    } finally {
      checkDb.close();
    }
  });

  test('نفس الطلب: القفز مباشرة لـ"قيد التنفيذ" أو "بانتظار تأكيد الدفع" بلا عرض مقبول يُرفض أيضاً', async ({ request }) => {
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل تجربة الاستغلال الثالث', city: CITY });
    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      form: { service: SERVICE, city: CITY, area: 'القويسمة', description: 'طلب بلا عرض لاختبار القفز المباشر' },
    });
    const requestId = (await createRes.json()).request.id;

    for (const status of ['قيد التنفيذ', 'بانتظار تأكيد الدفع']) {
      const res = await request.post(`/api/requests/${requestId}/status`, {
        headers: authHeader(customer.token),
        form: { status },
      });
      expect(res.status()).toBe(409);
      expect((await res.json()).code).toBe('STATUS_TRANSITION_INVALID');
    }
  });
});
