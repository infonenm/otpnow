/**
 * lib/listeners.js — Server-side Firebase listeners
 *
 * Replaces ALL three Cloud Functions:
 *   1. extractOTPOnNewSMS   → child_added on /sms/
 *   2. autoDeleteExpiredSMS → setInterval every 60s
 *   3. notifyForwardingChange → value listener on /settings/global_forwarding
 *
 * These run in-process with ZERO cold-start. The persistent WebSocket
 * to Firebase RTDB means they fire within milliseconds of a write.
 */

const { extractCode } = require('./otp');

// Track the server boot time so we don't re-process old messages
// that fire on the initial child_added sync.
let serverBootTime = 0;

// In-memory filter cache — refreshed from Firebase on change
let cachedFilters = [];

function startListeners(db, admin) {
    serverBootTime = Date.now();
    console.log('[listeners] Starting server-side listeners...');

    // ─────────────────────────────────────────────────────────────
    // 0. CACHE FILTERS — listen for changes so extraction always
    //    uses the latest patterns without needing a restart.
    // ─────────────────────────────────────────────────────────────
    db.ref('filters').on('value', snap => {
        cachedFilters = snap.exists() ? snap.val() : [];
        const count = Array.isArray(cachedFilters) ? cachedFilters.length : 0;
        console.log(`[filters] Cached ${count} filter rules`);
    });

    // ─────────────────────────────────────────────────────────────
    // 1. EXTRACT OTP ON NEW SMS
    //    Fires the instant Android writes to /sms/. Extracts OTP
    //    server-side, writes to /number/{safeRecipient}.
    //    No dashboard needed, no delays.
    // ─────────────────────────────────────────────────────────────
    db.ref('sms').on('child_added', async (snapshot) => {
        try {
            const msg   = snapshot.val();
            const msgId = snapshot.key;

            if (!msg || !msg.recipient) return;

            // Skip messages that arrived before this server started.
            // On initial connect, child_added fires for EVERY existing
            // child. We only want to process genuinely new ones.
            // Messages that already have extractedCode were processed
            // by a previous server instance or the dashboard.
            const arrivedAt = msg.arrivedAt || 0;
            if (arrivedAt < serverBootTime && msg.extractedCode) return;

            const safeNum = msg.recipient.replace(/[.#$[\]/]/g, '_');
            const message = msg.message || msg.code || '';

            const filters = Array.isArray(cachedFilters) ? cachedFilters : [];
            const extractedCode = extractCode(message, msg.sender, msg.recipient, filters);

            // Write extractedCode to the SMS node (even if null — clears stale)
            await snapshot.ref.update({ extractedCode: extractedCode || null });

            if (!extractedCode) return;

            // Only write to /number/ if no NEWER message already claimed it
            const existingSnap = await db.ref(`number/${safeNum}`).once('value');
            const existing     = existingSnap.val();

            if (existing && existing.ts && existing.ts > (msg.arrivedAt || 0)) {
                return; // newer OTP already in /number/
            }

            await db.ref(`number/${safeNum}`).set({
                success : true,
                otp     : extractedCode,
                smsKey  : msgId,
                ts      : msg.arrivedAt || Date.now()
            });

            console.log(`[extractOTP] ${msgId} → /number/${safeNum} = ${extractedCode}`);
        } catch (e) {
            console.error('[extractOTP] Error:', e.message);
        }
    });

    // ─────────────────────────────────────────────────────────────
    // 2. AUTO-DELETE EXPIRED SMS — every 60 seconds
    //    Replaces the Cloud Function pubsub schedule.
    // ─────────────────────────────────────────────────────────────
    setInterval(async () => {
        try {
            const now = Date.now();

            const settingsSnap = await db.ref('settings/auto_delete_minutes').once('value');
            const deleteWindowMs = (settingsSnap.exists() ? parseFloat(settingsSnap.val()) : 10) * 60 * 1000;

            const smsSnap = await db.ref('sms').once('value');
            if (!smsSnap.exists()) return;

            const deletions = [];
            smsSnap.forEach(child => {
                const msg = child.val();
                const expired = msg.deleteAt
                    ? now >= msg.deleteAt
                    : msg.arrivedAt && now >= (msg.arrivedAt + deleteWindowMs);
                if (expired) deletions.push(child.key);
            });

            if (!deletions.length) return;

            // Also clean up /number/ entries for deleted messages
            const numberCleanups = [];
            for (const id of deletions) {
                const msgSnap = await db.ref(`sms/${id}/recipient`).once('value');
                if (msgSnap.exists()) {
                    const safeNum = String(msgSnap.val()).replace(/[.#$[\]/]/g, '_');
                    const numSnap = await db.ref(`number/${safeNum}`).once('value');
                    if (numSnap.exists() && numSnap.val() && numSnap.val().smsKey === id) {
                        numberCleanups.push(safeNum);
                    }
                }
            }

            await Promise.all([
                ...deletions.map(id => db.ref(`sms/${id}`).remove()),
                ...numberCleanups.map(n => db.ref(`number/${n}`).remove())
            ]);

            console.log(`[autoDelete] Deleted ${deletions.length} expired message(s)`);
        } catch (e) {
            console.error('[autoDelete] Error:', e.message);
        }
    }, 60_000);

    // ─────────────────────────────────────────────────────────────
    // 3. FCM ON FORWARDING CHANGE
    //    Fires when dashboard writes settings/global_forwarding.
    //    Sends FCM data message to the "forwarding_control" topic
    //    so ALL Android devices wake up — even killed processes.
    // ─────────────────────────────────────────────────────────────
    let lastForwardingValue = null; // track to avoid firing on initial load

    db.ref('settings/global_forwarding').on('value', async (snap) => {
        const newValue = snap.exists() ? snap.val() : null;
        if (newValue === null) return;

        // Skip the initial read on server startup
        if (lastForwardingValue === null) {
            lastForwardingValue = newValue;
            return;
        }

        // Only fire if the value actually changed
        if (newValue === lastForwardingValue) return;
        lastForwardingValue = newValue;

        const action    = newValue === true ? 'enable' : 'disable';
        const timestamp = String(Date.now());

        try {
            const result = await admin.messaging().send({
                topic : 'forwarding_control',
                data  : { action, timestamp },
                android: {
                    priority: 'high',
                    ttl     : 60000 // 60s — discard if device unreachable
                }
            });
            console.log(`[FCM] Sent "${action}" to topic, msgId=${result}`);
        } catch (err) {
            console.error('[FCM] Send failed:', err.message);
        }
    });

    console.log('[listeners] All listeners active');
}

/**
 * Get cached filters for use by the /get fallback path.
 */
function getCachedFilters() {
    return Array.isArray(cachedFilters) ? cachedFilters : [];
}

module.exports = { startListeners, getCachedFilters };
