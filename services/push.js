// services/push.js
// إشعارات Push عبر Firebase Admin SDK. أي تعديل على منطق الإشعارات الخارجية مكانه هون.

const { db } = require('../config/db');

let firebaseAdmin = null;
try {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    // يدعم FIREBASE_SERVICE_ACCOUNT (JSON كامل) أو المتغيرات المنفصلة
    let credential;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      credential = admin.credential.cert(serviceAccount);
    } else {
      credential = admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
      });
    }
    admin.initializeApp({ credential });
  }
  firebaseAdmin = admin;
  console.log('[Firebase] Admin SDK initialized ✓');
} catch (e) {
  console.warn('[Firebase] SDK not available — push notifications disabled:', e.message);
}

// دالة مساعدة لإرسال Push Notification
async function sendPush(token, title, body, data = {}) {
  if (!firebaseAdmin || !token) return;
  try {
    await firebaseAdmin.messaging().send({
      token,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high', notification: { sound: 'default', channelId: 'sallehly_main' } },
      apns: { payload: { aps: { sound: 'default', badge: 1 } } },
      webpush: { notification: { icon: '/icons/icon-192.png', badge: '/icons/badge-72.png' }, fcmOptions: { link: 'https://sallehly.com' } }
    });
  } catch (e) {
    if (e.code === 'messaging/registration-token-not-registered') {
      // Token منتهي — امسحه من DB
      try { db.prepare('UPDATE users SET fcm_token=NULL WHERE fcm_token=?').run(token); } catch (dbErr) {}
    }
    console.warn('[Firebase] sendPush error:', e.message);
  }
}

module.exports = { sendPush };
