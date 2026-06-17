/**
 * lib/fcm.js — Firebase Cloud Messaging for instant device wake
 *
 * Uses Firebase Admin SDK ONLY for FCM sending. No RTDB, no Auth.
 * If FIREBASE_SERVICE_ACCOUNT is not set, FCM is silently disabled
 * and the system falls back to poller-only mode (30s delay).
 */

let admin = null;
let fcmReady = false;

function init() {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) {
        console.log('[fcm] FIREBASE_SERVICE_ACCOUNT not set — FCM disabled (poller-only mode)');
        return;
    }
    try {
        const serviceAccount = JSON.parse(raw);
        admin = require('firebase-admin');
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        fcmReady = true;
        console.log('[fcm] Firebase Admin initialized — FCM enabled');
    } catch (e) {
        console.error('[fcm] Init failed — FCM disabled:', e.message);
    }
}

/**
 * Send a high-priority data message to the forwarding_control topic.
 * Wakes the app even if completely killed (via Google Play Services).
 *
 * @param {string} action - 'enable', 'disable', 'test', 'clear_log'
 * @param {number} [ts]   - server timestamp (shared with store for dedup)
 */
async function send(action, ts) {
    if (!fcmReady || !admin) return;

    const timestamp = String(ts || Date.now());

    try {
        const result = await admin.messaging().send({
            topic: 'forwarding_control',
            data: {
                action:    action,
                timestamp: timestamp
            },
            android: {
                priority: 'high',
                ttl: 60000
            }
        });
        console.log(`[fcm] Sent "${action}" ts=${timestamp} → ${result}`);
    } catch (e) {
        console.log(`[fcm] Send "${action}" failed (non-fatal): ${e.message}`);
    }
}

module.exports = { init, send };
