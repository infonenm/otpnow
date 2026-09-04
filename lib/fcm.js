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
        status.configured = true;
        console.log('[fcm] Firebase Admin initialized — FCM enabled');
    } catch (e) {
        console.error('[fcm] Init failed — FCM disabled:', e.message);
    }
}

/**
 * How long FCM should keep trying to deliver, per action, in MILLISECONDS.
 *
 * =============================================================================
 * THIS WAS 60 SECONDS FOR EVERYTHING, AND THAT IS WHY TOGGLES "TOOK TIME"
 *
 * `ttl` in firebase-admin's AndroidConfig is milliseconds, so 60000 meant sixty
 * seconds. If the phone was not reachable within that minute — dozing, screen
 * off in deep sleep, briefly off data, in a lift — Google DISCARDED the message
 * outright. It never arrived, ever.
 *
 * The device then had to find out the slow way: the 30-second poller, which
 * only runs while the process is alive, or the 15-minute worker. That is
 * exactly the delay you see. FCM was not slow; the command was being thrown
 * away before the phone woke up.
 *
 * FCM's own default is four weeks. Sixty seconds was throwing away the entire
 * point of having a push channel.
 *
 * WHY NOT SIMPLY THE DEFAULT: a stale command is not free. An "enable" arriving
 * days later would clear a local opt-out the user set deliberately. So on/off
 * gets fifteen minutes — long enough to cover a sleeping or briefly offline
 * phone, which is the real case, and no longer than ControlSyncWorker's period,
 * beyond which the worker reconciles anyway and the push adds nothing.
 *
 * One-shot commands stay short. A "test message" or a log wipe landing twenty
 * minutes after you pressed the button is confusing, not helpful.
 * =============================================================================
 */
const TTL_MS = {
    enable:    15 * 60 * 1000,
    disable:   15 * 60 * 1000,
    test:       2 * 60 * 1000,
    clear_log:  2 * 60 * 1000,
    // One-shot, like test: a fetch arriving twenty minutes late would
    // re-forward a message whose OTP is long dead, and supersede a live one.
    fetch_latest: 2 * 60 * 1000
};
const DEFAULT_TTL_MS = 2 * 60 * 1000;

/**
 * Last-send bookkeeping.
 *
 * send() is deliberately not awaited by the routes — a toggle must answer the
 * dashboard immediately, not wait on Google. The cost of that is a failing FCM
 * being completely invisible: a bad service account, a revoked key or a quota
 * error just logs a line nobody reads. This is surfaced on
 * GET /api/full-settings so "is push actually working?" is answerable.
 */
const status = {
    configured: false,
    lastAction: null,
    lastAt:     0,
    lastOk:     null,
    lastError:  null
};

/**
 * Send a high-priority data message to the forwarding_control topic.
 * Wakes the app even if completely killed (via Google Play Services).
 *
 * @param {string} action - 'enable', 'disable', 'test', 'clear_log'
 * @param {number} [ts]   - server timestamp (shared with store for dedup)
 */
async function send(action, ts, topic) {
    if (!fcmReady || !admin) {
        status.lastAction = action;
        status.lastAt     = Date.now();
        status.lastOk     = false;
        status.lastError  = 'FCM not configured (FIREBASE_SERVICE_ACCOUNT unset)';
        return;
    }

    const timestamp = String(ts || Date.now());
    const ttl = TTL_MS[action] || DEFAULT_TTL_MS;

    status.lastAction = action;
    status.lastAt     = Date.now();

    try {
        // A per-user topic addresses one owner's phones; the default reaches
        // every device. Targeting exists so "Test" can be aimed at the phone
        // that is actually misbehaving instead of waking the whole fleet.
        const result = await admin.messaging().send({
            topic: topic || 'forwarding_control',
            data: {
                action:    action,
                timestamp: timestamp
            },
            android: {
                priority: 'high',
                ttl: ttl
            }
        });
        status.lastOk = true;
        status.lastError = null;
        console.log(`[fcm] Sent "${action}" to ${topic || 'forwarding_control'} `
            + `ts=${timestamp} ttl=${ttl / 1000}s → ${result}`);
    } catch (e) {
        status.lastOk = false;
        status.lastError = e.message;
        console.log(`[fcm] Send "${action}" failed (non-fatal): ${e.message}`);
    }
}

/** Snapshot for the dashboard / diagnostics. Never exposes credentials. */
function getStatus() {
    return {
        configured: fcmReady,
        lastAction: status.lastAction,
        lastAt:     status.lastAt,
        lastOk:     status.lastOk,
        lastError:  status.lastError,
        ttlSeconds: Object.fromEntries(
            Object.entries(TTL_MS).map(([k, v]) => [k, v / 1000]))
    };
}

module.exports = { init, send, getStatus };
