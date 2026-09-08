// tests/topup-duplicate-receipt.spec.js — [FEAT-TOPUPDUPHASH-01]
// يغطي: نفس صورة الإيصال (بايت لبايت) مُستخدَمة بأكثر من طلب شحن تُعلَّم
// duplicate_receipt=true بقائمة الأدمن — إشارة فقط، بلا أي تأثير على القرار
// (الموافقة/الرفض يبقى ممكناً بشكل طبيعي، ليس هدف هذا الاختبار).

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
      name: `فني اختبار تكرار ${tag}`,
      city: 'عمان',
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
  if (!registerRes.ok()) throw new Error(`فشل تسجيل الفني ${tag}: ${registerRes.status()} ${await registerRes.text()}`);
  const otp = getPendingOtp(email);
  const verifyRes = await request.post('/api/auth/verify-otp', { form: { email, otp } });
  const body = await verifyRes.json();
  return { email, token: body.token };
}

async function loginAdmin(request) {
  const res = await request.post('/api/auth/login', { form: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  const body = await res.json();
  return { token: body.token };
}

test('نفس صورة الإيصال بالضبط بطلبَي شحن لفنيَّين مختلفَين تُعلَّم duplicate_receipt=true للاثنين، والفريدة تبقى false', async ({ request }) => {
  const techA = await registerAndVerifyTechnician(request, 'dupA');
  const techB = await registerAndVerifyTechnician(request, 'dupB');
  const techC = await registerAndVerifyTechnician(request, 'unique');
  const admin = await loginAdmin(request);

  const metaRes = await request.get('/api/meta', { headers: authHeader(techA.token) });
  const pkg = (await metaRes.json()).packages[0];

  const sharedReceiptBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
  const uniqueReceiptBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x99, 0x98, 0x97]);

  const submitA = await request.post('/api/topups', {
    headers: authHeader(techA.token),
    multipart: { package_id: String(pkg.id), receipt: { name: 'r.png', mimeType: 'image/png', buffer: sharedReceiptBytes } },
  });
  expect(submitA.ok()).toBe(true);
  const topupA = (await submitA.json()).topup;

  const submitB = await request.post('/api/topups', {
    headers: authHeader(techB.token),
    multipart: { package_id: String(pkg.id), receipt: { name: 'r.png', mimeType: 'image/png', buffer: sharedReceiptBytes } },
  });
  expect(submitB.ok()).toBe(true);
  const topupB = (await submitB.json()).topup;

  const submitC = await request.post('/api/topups', {
    headers: authHeader(techC.token),
    multipart: { package_id: String(pkg.id), receipt: { name: 'r.png', mimeType: 'image/png', buffer: uniqueReceiptBytes } },
  });
  expect(submitC.ok()).toBe(true);
  const topupC = (await submitC.json()).topup;

  const listRes = await request.get('/api/topups', { headers: authHeader(admin.token) });
  const topups = (await listRes.json()).topups;

  const foundA = topups.find((t) => t.id === topupA.id);
  const foundB = topups.find((t) => t.id === topupB.id);
  const foundC = topups.find((t) => t.id === topupC.id);

  expect(foundA.duplicate_receipt).toBe(true);
  expect(foundB.duplicate_receipt).toBe(true);
  expect(foundC.duplicate_receipt).toBe(false);
});
