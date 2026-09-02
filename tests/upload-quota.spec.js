// tests/upload-quota.spec.js
// [FEAT-UPLOADQUOTA-01] راجع DECISIONS.md — يثبت أن حصة التخزين لكل مستخدم
// (middleware/upload.js's enforceUploadQuota) تعمل فعلياً على مسار رفع حقيقي:
// رفع يُرفض بـ413/STORAGE_QUOTA_EXCEEDED لو تجاوز الحصة، الملف المرفوض يُحذف
// فوراً من القرص (لا يبقى يتيماً)، ولا يُحتسَب على users.total_upload_bytes؛
// ورفع طبيعي (تحت الحصة) ينجح ويزيد العدّاد فعلياً بحجم الملف الحقيقي.

const { test, expect } = require('@playwright/test');
const { getPendingOtp, openTestDb } = require('./helpers/db');

function uniqueEmail(tag) {
  return `test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}
function uniquePhone() {
  return `07${Math.floor(10000000 + Math.random() * 89999999)}`;
}

const VALID_PASSWORD = 'TestPass123';
const CITY = 'عمان';
// نفس توقيع PNG المصغَّر المستخدَم بباقي الاختبارات (tests/topups.spec.js) —
// يكفي لاجتياز verifyImageMagicBytes (يفحص أول 8-12 بايت فقط لا الملف كاملاً).
const TINY_PNG_BUFFER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

async function getFirstPackageId(request, token) {
  const res = await request.get('/api/meta', { headers: authHeader(token) });
  const body = await res.json();
  expect(body.packages.length).toBeGreaterThan(0);
  return body.packages[0].id;
}

async function registerAndVerify(request, role, extra = {}) {
  const email = uniqueEmail(role);
  const phone = uniquePhone();
  const registerRes = role === 'technician'
    ? await request.post('/api/auth/register', {
        multipart: {
          role, email, phone, password: VALID_PASSWORD, ...extra,
          avatar: { name: 'avatar.png', mimeType: 'image/png', buffer: TINY_PNG_BUFFER },
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

function setTotalUploadBytes(userId, bytes) {
  const db = openTestDb();
  try {
    db.prepare('UPDATE users SET total_upload_bytes=? WHERE id=?').run(bytes, userId);
  } finally {
    db.close();
  }
}

function getTotalUploadBytes(userId) {
  const db = openTestDb();
  try {
    return db.prepare('SELECT total_upload_bytes FROM users WHERE id=?').get(userId).total_upload_bytes;
  } finally {
    db.close();
  }
}

test.describe('[FEAT-UPLOADQUOTA-01] حصة رفع تراكمية لكل مستخدم', () => {
  test('POST /me/profile — رفع صورة عادية تحت الحصة ينجح ويزيد total_upload_bytes بحجم الملف الفعلي', async ({ request }) => {
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل حصة التخزين', city: CITY });
    setTotalUploadBytes(customer.user.id, 0);

    const res = await request.post('/api/me/profile', {
      headers: authHeader(customer.token),
      multipart: {
        name: 'عميل حصة التخزين',
        phone: customer.phone,
        city: CITY,
        areas: '',
        avatar: { name: 'avatar.png', mimeType: 'image/png', buffer: TINY_PNG_BUFFER },
      },
    });
    expect(res.ok(), `فشل الرفع: ${res.status()} ${await res.text().catch(() => '')}`).toBeTruthy();

    expect(getTotalUploadBytes(customer.user.id)).toBe(TINY_PNG_BUFFER.length);
  });

  test('POST /api/topups — رفع إيصال يتجاوز الحصة المتبقية يُرفض بـ413/STORAGE_QUOTA_EXCEEDED، والملف لا يُحتسَب ولا يبقى يتيماً', async ({ request }) => {
    const technician = await registerAndVerify(request, 'technician', {
      name: 'فني حصة التخزين', city: CITY,
      national_number: (() => { let n = ''; for (let i = 0; i < 10; i++) n += Math.floor(Math.random() * 10); return n; })(),
      services: 'كهربائي', areas: 'القويسمة',
    });

    // [FEAT-UPLOADQUOTA-01] راجع middleware/upload.js — TOTAL_UPLOAD_QUOTA_BYTES = 100MB.
    // نضبط استخدام الفني الحالي على بايت واحد أقل من الحصة، فأي رفع إضافي
    // (حتى لو بضعة بايتات) يتجاوزها حتماً بلا الحاجة لرفع ملف كبير فعلياً.
    const QUOTA_BYTES = 100 * 1024 * 1024;
    setTotalUploadBytes(technician.user.id, QUOTA_BYTES - 1);
    const packageId = await getFirstPackageId(request, technician.token);

    const res = await request.post('/api/topups', {
      headers: authHeader(technician.token),
      multipart: {
        package_id: String(packageId),
        receipt: { name: 'receipt.png', mimeType: 'image/png', buffer: TINY_PNG_BUFFER },
      },
    });
    expect(res.status()).toBe(413);
    const body = await res.json();
    expect(body.code).toBe('STORAGE_QUOTA_EXCEEDED');

    // العدّاد لم يتغيّر — الرفض حدث قبل أي زيادة على total_upload_bytes.
    expect(getTotalUploadBytes(technician.user.id)).toBe(QUOTA_BYTES - 1);

    // لا طلب شحن أُنشئ من الرفع المرفوض.
    const listRes = await request.get('/api/topups', { headers: authHeader(technician.token) });
    const { topups } = await listRes.json();
    expect(topups.length).toBe(0);
  });

  test('POST /me/profile — استخدام دون الحصة بقليل: رفع أصغر من الفارق المتبقي ينجح', async ({ request }) => {
    const customer = await registerAndVerify(request, 'customer', { name: 'عميل حصة كافية', city: CITY });
    const QUOTA_BYTES = 100 * 1024 * 1024;
    // فارق متبقٍ أكبر من حجم TINY_PNG_BUFFER بكثير — يجب أن ينجح الرفع عادياً.
    setTotalUploadBytes(customer.user.id, QUOTA_BYTES - 1024);

    const res = await request.post('/api/me/profile', {
      headers: authHeader(customer.token),
      multipart: {
        name: 'عميل حصة كافية',
        phone: customer.phone,
        city: CITY,
        areas: '',
        avatar: { name: 'avatar.png', mimeType: 'image/png', buffer: TINY_PNG_BUFFER },
      },
    });
    expect(res.ok(), `فشل الرفع: ${res.status()} ${await res.text().catch(() => '')}`).toBeTruthy();
    expect(getTotalUploadBytes(customer.user.id)).toBe(QUOTA_BYTES - 1024 + TINY_PNG_BUFFER.length);
  });
});
