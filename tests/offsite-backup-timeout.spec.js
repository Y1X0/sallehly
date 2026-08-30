// tests/offsite-backup-timeout.spec.js
// [SEC-FIX-BACKUPTIMEOUT-01] راجع DECISIONS.md وservices/offsite-backup.js —
// githubRequest() كانت تستدعي fetch() بلا أي AbortSignal/مهلة إطلاقاً، بنفس
// فئة SEC-FIX-EMAILTIMEOUT-01 (services/email.js). انقطاع/تعليق طرف GitHub API
// كان يعلّق الاستدعاء للأبد. هذا الملف اختبار وحدة مباشر (لا يمر بالسيرفر
// الحقيقي — يستورد الوحدة مباشرة بعملية Playwright worker الخاصة به، معزولة
// تماماً عن عملية السيرفر المُشغَّلة)، لأن BACKUP_GITHUB_TOKEN/OWNER/REPO
// (تُقرأ مرة واحدة عند أول require لـconfig/env.js) غير مضبوطة أصلاً بعملية
// السيرفر المشتركة (playwright.config.js)، فيجب ضبطها هنا قبل أي require.
//
// AbortSignal.timeout الحقيقي (60 ثانية بالكود) يُموَّه مؤقتاً هنا بدل
// الانتظار الفعلي — نتحكم نحن بلحظة "انتهاء المهلة" يدوياً لإثبات أن آلية
// الإلغاء (لا مجرد وجود مُعامل signal شكلياً) تعمل فعلياً: fetch مموَّهة تحترم
// نفس دلالات AbortSignal الحقيقية (حدث 'abort' يرفض الطلب المعلَّق).
process.env.BACKUP_GITHUB_TOKEN = 'test-token';
process.env.BACKUP_GITHUB_OWNER = 'test-owner';
process.env.BACKUP_GITHUB_REPO = 'test-repo';

const { test, expect } = require('@playwright/test');
const { listOffsiteBackups } = require('../services/offsite-backup');

test.describe('[SEC-FIX-BACKUPTIMEOUT-01] طلبات GitHub API (النسخ الاحتياطي الخارجي) لا تعلّق للأبد', () => {
  let originalFetch;
  let originalAbortSignalTimeout;

  test.beforeEach(() => {
    originalFetch = global.fetch;
    originalAbortSignalTimeout = AbortSignal.timeout;
  });

  test.afterEach(() => {
    global.fetch = originalFetch;
    AbortSignal.timeout = originalAbortSignalTimeout;
  });

  test('طرف GitHub API لا يرد إطلاقاً: الاستدعاء يفشل عبر AbortSignal بدل التعليق الأبدي', async () => {
    const controller = new AbortController();
    // نستبدل AbortSignal.timeout بإصدار نتحكم بلحظة إطلاقه يدوياً، بدل
    // انتظار الـ60 ثانية الحقيقية بكل تشغيل اختبار.
    AbortSignal.timeout = () => controller.signal;

    let capturedSignal;
    global.fetch = (url, options) => {
      capturedSignal = options?.signal;
      // fetch حقيقية معلَّقة (لا رد، لا إغلاق اتصال) — الوعد لا يُحسَم إطلاقاً
      // من تلقاء نفسه، فقط عبر حدث 'abort' على signal (نفس دلالات fetch
      // الحقيقية عند إلغاء AbortSignal).
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    };

    const promise = listOffsiteBackups();
    // يمثّل لحظة انتهاء الـ60 ثانية الحقيقية بالكود الفعلي.
    controller.abort();

    await expect(promise).rejects.toThrow(/abort/i);
    expect(capturedSignal, 'لم يُمرَّر أي AbortSignal لـfetch — نفس العلّة قبل الإصلاح').toBeTruthy();
  });

  test('طلب ناجح عادي: signal يُمرَّر لكن لا يُلغي شيئاً (لا تراجع بالمسار السليم)', async () => {
    let capturedSignal;
    global.fetch = async (url, options) => {
      capturedSignal = options?.signal;
      return {
        ok: true,
        json: async () => ([]),
      };
    };

    const result = await listOffsiteBackups();
    expect(result).toEqual([]);
    expect(capturedSignal).toBeTruthy();
    expect(capturedSignal.aborted).toBe(false);
  });
});
