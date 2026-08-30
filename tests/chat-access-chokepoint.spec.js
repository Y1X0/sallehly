// tests/chat-access-chokepoint.spec.js
// [SEC-FIX-CHATACCESS-CHOKEPOINT-01] راجع DECISIONS.md — يثبت الضمان البنيوي
// الجديد (لا الموضعي): getMessages/filterChatRowsForUser (utils/db-helpers.js)
// يفرضان الصلاحية داخلياً بمعزل تام عن انضباط أي مُستدعٍ حالي أو مستقبلي، و
// ForbiddenError تترجَم دائماً لاستجابة 403 نظيفة عبر apiErrorHandler — لا
// 500 ولا استثناء يسقط بصمت. هذه اختبارات وحدة مباشرة (تستدعي الدوال
// الحقيقية مباشرة، لا عبر HTTP) عن قصد: الهدف إثبات أن الحارس نفسه يعمل حتى
// لو حُذف كل فحص canAccessRequestChat من كل مسار HTTP اليوم — شيء لا يمكن
// إثباته باختبار HTTP وحده طالما الفحوصات الموضعية الحالية لا تزال قائمة
// (وتبقى قائمة عمداً — راجع DECISIONS.md).

const { test, expect } = require('@playwright/test');
const express = require('express');
const { getPendingOtp, openTestDb } = require('./helpers/db');
const { createDbHelpers } = require('../utils/db-helpers');
const { ForbiddenError } = require('../utils/errors');
const { apiErrorHandler } = require('../middleware/security');

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

async function registerAndVerify(request, { role, extra = {} }) {
  const email = uniqueEmail(role);
  const phone = uniquePhone();
  const registerRes = await request.post('/api/auth/register', { form: { role, email, phone, password: VALID_PASSWORD, ...extra } });
  if (!registerRes.ok()) throw new Error(`فشل تسجيل (${role}): ${registerRes.status()} ${await registerRes.text()}`);
  const otp = getPendingOtp(email);
  const verifyRes = await request.post('/api/auth/verify-otp', { form: { email, otp } });
  const body = await verifyRes.json();
  return { email, phone, token: body.token, user: body.user };
}

test.describe('[SEC-FIX-CHATACCESS-CHOKEPOINT-01] getMessages يفرض الصلاحية داخلياً، بمعزل عن انضباط المُستدعي', () => {
  test('طرف خارجي تماماً عن الطلب: getMessages ترمي ForbiddenError مباشرة، بلا أي حاجة لفحص canAccessRequestChat من المُستدعي', async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });
    const customer = await registerAndVerify(request, { role: 'customer', extra: { name: 'عميل تجزئة', city: CITY } });
    const outsider = await registerAndVerify(request, { role: 'customer', extra: { name: 'طرف خارجي تجزئة', city: CITY } });

    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      multipart: { service: SERVICE, city: CITY, area: AREA, description: 'وصف تجريبي كافٍ للطول لاختبار الحارس' },
    });
    const r = (await createRes.json()).request;
    await request.dispose();

    const db = openTestDb();
    try {
      const { getMessages } = createDbHelpers(db);
      // لا يوجد أي فحص canAccessRequestChat هنا قبل الاستدعاء — بالضبط
      // السيناريو الذي يحاكي "موقع استدعاء مستقبلي نسي الفحص".
      expect(() => getMessages(outsider.user, r.id)).toThrow(ForbiddenError);
      try {
        getMessages(outsider.user, r.id);
        expect(false, 'كان يجب أن ترمي').toBe(true);
      } catch (e) {
        expect(e.status).toBe(403);
        expect(e.code).toBe('AUTH_FORBIDDEN');
      }
    } finally {
      db.close();
    }
  });

  test('صاحب الطلب الحقيقي: getMessages تنجح وترجع الرسائل عند استدعائها مباشرة بلا فحص مسبق أيضاً', async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4001' });
    const customer = await registerAndVerify(request, { role: 'customer', extra: { name: 'عميل نجاح تجزئة', city: CITY } });

    const createRes = await request.post('/api/requests', {
      headers: authHeader(customer.token),
      multipart: { service: SERVICE, city: CITY, area: AREA, description: 'وصف تجريبي كافٍ للطول لاختبار الحارس ٢' },
    });
    const r = (await createRes.json()).request;
    await request.post(`/api/requests/${r.id}/messages`, { headers: authHeader(customer.token), form: { body: 'رسالة تجريبية للتحقق من النجاح' } });
    await request.dispose();

    const db = openTestDb();
    try {
      const { getMessages } = createDbHelpers(db);
      const messages = getMessages(customer.user, r.id);
      expect(messages.some((m) => m.body.includes('رسالة تجريبية للتحقق'))).toBe(true);
    } finally {
      db.close();
    }
  });
});

test.describe('[SEC-FIX-CHATACCESS-CHOKEPOINT-01] ForbiddenError تترجَم لاستجابة 403 نظيفة عبر apiErrorHandler — لا 500', () => {
  test('راوت حقيقي يرمي ForbiddenError: العميل يرى 403 + {error, code} صريحين، لا استجابة خطأ عامة', async () => {
    const app = express();
    app.get('/throws-forbidden', () => { throw new ForbiddenError(); });
    app.use(apiErrorHandler);

    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/throws-forbidden`);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body).toEqual({ error: 'لا تملك صلاحية', code: 'AUTH_FORBIDDEN' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test.describe('[SEC-FIX-CHATACCESS-CHOKEPOINT-01] filterChatRowsForUser — طبقة دفاع ثانية مستقلة عن جملة WHERE بـgetChatsList', () => {
  test('يستبعد صفاً لا يستحقه المستخدم حتى لو "تسرّب" من استعلام SQL (يحاكي انحراف WHERE مستقبلي كما حدث فعلياً بـSEC-FIX-CHATSCOPE-04)', () => {
    const db = openTestDb();
    try {
      const { filterChatRowsForUser } = createDbHelpers(db);
      const user = { id: 999, role: 'customer' };
      const rows = [
        { request_id: 1, customer_id: 999, technician_id: null }, // المستخدم هو صاحب الطلب فعلاً
        { request_id: 2, customer_id: 111, technician_id: 222 }, // لا علاقة له بهذا الصف إطلاقاً — لو وصل هنا فهو تسرّب
      ];
      const filtered = filterChatRowsForUser(rows, user);
      expect(filtered.map((r) => r.request_id)).toEqual([1]);
    } finally {
      db.close();
    }
  });
});
