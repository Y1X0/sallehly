// services/offsite-backup.js
// [DR-FIX-01] راجع DECISIONS.md. رفع نسخة النسخة الاحتياطية المحلية (التي
// ينتجها config/db.js:createDbBackup) إلى مكان فعلياً خارج قرص Render —
// GitHub Releases على مستودع مخصَّص لهذا الغرض فقط. لا تبعث أي طلب شبكة إن لم
// تكن BACKUP_GITHUB_TOKEN/OWNER/REPO مضبوطة (نفس فلسفة RESEND_API_KEY
// بـservices/email.js: غياب الإعداد يُسجَّل تحذيراً واحداً ولا يُفشل أي شيء آخر).
//
// لماذا GitHub Releases تحديداً (وليس S3/R2/B2): لا يضيف أي تبعية جديدة
// (fetch مدمجة بـNode 20)، ولا حساب/فوترة جديدة يديرها فريق صغير — يعيد
// استخدام حساب GitHub الموجود أصلاً. كل نسخة = إصدار (release) واحد بوسم
// زمني، والملف .sqlite مرفق كـasset. الاحتفاظ (retention) يطابق النسخ المحلي
// بالضبط: 7 أيام.

const fs = require('fs');
const path = require('path');
const { BACKUP_GITHUB_TOKEN, BACKUP_GITHUB_OWNER, BACKUP_GITHUB_REPO } = require('../config/env');

const API_BASE = 'https://api.github.com';
const OFFSITE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function isConfigured() {
  return !!(BACKUP_GITHUB_TOKEN && BACKUP_GITHUB_OWNER && BACKUP_GITHUB_REPO);
}

function apiHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${BACKUP_GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra
  };
}

async function githubRequest(url, options = {}) {
  const res = await fetch(url, { ...options, headers: apiHeaders(options.headers) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status} على ${url}: ${body.slice(0, 300)}`);
  }
  return res;
}

// كل النسخ الاحتياطية الحالية على المستودع الخارجي — تُستخدَم لكل من
// pruneOldOffsiteBackups() هنا وscripts/restore-db.js (قائمة/اختيار نسخة).
async function listOffsiteBackups() {
  if (!isConfigured()) return [];
  const res = await githubRequest(
    `${API_BASE}/repos/${BACKUP_GITHUB_OWNER}/${BACKUP_GITHUB_REPO}/releases?per_page=100`
  );
  const releases = await res.json();
  return releases
    .filter(r => r.tag_name?.startsWith('backup-'))
    .map(r => ({
      id: r.id,
      tag: r.tag_name,
      createdAt: r.created_at,
      assetUrl: r.assets?.[0]?.url || null,
      assetName: r.assets?.[0]?.name || null
    }));
}

// [DR-FIX-01] رفع ملف نسخة احتياطية محلية واحد كإصدار GitHub جديد. لا يرمي
// استثناءً أبداً للمستدعي — فشل الرفع الخارجي لا يجوز أن يُسقط أو حتى يُظهر
// فشلاً بعملية النسخ الاحتياطي المحلي نفسها (createDbBackup) التي نجحت فعلاً.
async function uploadBackupOffsite(localFilePath) {
  if (!isConfigured()) {
    console.warn('[DR-FIX-01] BACKUP_GITHUB_TOKEN/OWNER/REPO غير مضبوطة — تخطّي الرفع الخارجي (النسخة المحلية سليمة وموجودة).');
    return false;
  }
  try {
    const filename = path.basename(localFilePath);
    const tag = filename.replace(/\.sqlite$/, '').replace(/^sallehly-/, 'backup-');
    const fileBuffer = await fs.promises.readFile(localFilePath);

    const createRes = await githubRequest(
      `${API_BASE}/repos/${BACKUP_GITHUB_OWNER}/${BACKUP_GITHUB_REPO}/releases`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tag_name: tag,
          name: tag,
          body: `نسخة احتياطية آلية — ${new Date().toISOString()}`,
          draft: false,
          prerelease: false
        })
      }
    );
    const release = await createRes.json();
    // upload_url شكلها URI template: ".../assets{?name,label}" — نستبدل الجزء
    // الأخير بـ?name=<filename> صراحة بدل استخدام مكتبة URI-template إضافية.
    const uploadUrl = release.upload_url.replace(/\{.*\}$/, `?name=${encodeURIComponent(filename)}`);
    await githubRequest(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: fileBuffer
    });

    console.log(`[DR-FIX-01] نسخة احتياطية رُفعت خارجياً بنجاح: ${tag}`);
    return true;
  } catch (e) {
    console.error('[DR-FIX-01] فشل الرفع الخارجي للنسخة الاحتياطية:', e.message);
    return false;
  }
}

// [DR-FIX-01] نفس نافذة الاحتفاظ المحلية بالضبط (7 أيام) — حذف الإصدار
// (release) يحذف asset الملف المرفق تلقائياً، لكن لا يحذف الوسم (tag) الأساسي
// نفسه؛ نحذفه صراحة بنداء منفصل حتى لا تتراكم وسوم يتيمة بلا نهاية.
async function pruneOldOffsiteBackups() {
  if (!isConfigured()) return;
  try {
    const backups = await listOffsiteBackups();
    const now = Date.now();
    for (const b of backups) {
      if (now - new Date(b.createdAt).getTime() <= OFFSITE_RETENTION_MS) continue;
      try {
        await githubRequest(
          `${API_BASE}/repos/${BACKUP_GITHUB_OWNER}/${BACKUP_GITHUB_REPO}/releases/${b.id}`,
          { method: 'DELETE' }
        );
        await githubRequest(
          `${API_BASE}/repos/${BACKUP_GITHUB_OWNER}/${BACKUP_GITHUB_REPO}/git/refs/tags/${b.tag}`,
          { method: 'DELETE' }
        );
      } catch (e) { console.error(`[DR-FIX-01] فشل حذف نسخة خارجية قديمة (${b.tag}):`, e.message); }
    }
  } catch (e) { console.error('[DR-FIX-01] فشل تنظيف النسخ الخارجية القديمة:', e.message); }
}

module.exports = { uploadBackupOffsite, pruneOldOffsiteBackups, listOffsiteBackups, isConfigured };
