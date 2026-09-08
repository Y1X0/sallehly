// tests/meta-cache.spec.js — [PERF-METACACHE-01]
// يغطي: GET /api/meta لا يعيد استعلام قاعدة البيانات لكل طلب — خدمة جديدة
// تُضاف مباشرة بقاعدة البيانات (متجاوزة الـAPI، تحاكي إجراء أدمن) لا تظهر
// فوراً بالرد طالما التخزين المؤقت لا يزال ساري المفعول.

const { test, expect } = require('@playwright/test');
const { openTestDb } = require('./helpers/db');

test.describe('[PERF-METACACHE-01] تخزين GET /api/meta مؤقتاً', () => {
  test('خدمة تُضاف مباشرة بقاعدة البيانات لا تظهر فوراً بـ/api/meta (لا تزال ضمن نافذة التخزين المؤقت)', async ({ request }) => {
    const firstRes = await request.get('/api/meta');
    expect(firstRes.status()).toBe(200);
    const firstBody = await firstRes.json();
    const beforeCount = firstBody.services.length;
    const uniqueName = `خدمة اختبار تخزين مؤقت ${Date.now()}`;

    const db = openTestDb();
    try {
      db.prepare('INSERT INTO service_categories(name, is_active) VALUES (?, 1)').run(uniqueName);
    } finally {
      db.close();
    }

    const secondRes = await request.get('/api/meta');
    expect(secondRes.status()).toBe(200);
    const secondBody = await secondRes.json();

    // لا يزال بنفس العدد (الخدمة الجديدة لم تُقرَأ من القاعدة بعد — الرد جاء
    // من الذاكرة المخزَّنة، لا استعلام جديد).
    expect(secondBody.services.length).toBe(beforeCount);
    expect(secondBody.services.some((s) => s.name === uniqueName)).toBe(false);
  });

  test('نفس نداءين متتاليين يرجعان نفس البيانات بالضبط (packages وcities أيضاً، لا خدمات فقط)', async ({ request }) => {
    const res1 = await request.get('/api/meta');
    const res2 = await request.get('/api/meta');
    const body1 = await res1.json();
    const body2 = await res2.json();

    expect(body2.packages).toEqual(body1.packages);
    expect(body2.cities).toEqual(body1.cities);
    expect(body2.services).toEqual(body1.services);
  });
});
