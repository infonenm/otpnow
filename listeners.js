/**
 * server.js — GetOTP Render Server v4.0
 *
 * Replaces: Firebase Hosting + Cloud Functions + Cloudflare Worker
 * Keeps:    Firebase RTDB (Spark free tier) + Firebase Auth + FCM
 *
 * Endpoints:
 *   GET  /                → Dashboard
 *   GET  /get?number=X    → OTP fetch API (replaces Worker + get.html)
 *   POST /notify          → FCM trigger (backup path, Auth-protected)
 *   GET  /api/config      → Firebase client config for dashboard
 *   GET  /health          → Keepalive ping
 */

const express  = require('express');
const path     = require('path');
const { initFirebase, getDb, getAdmin } = require('./lib/firebase');
const { startListeners, getCachedFilters } = require('./lib/listeners');
const { extractCode } = require('./lib/otp');

// ─── Init Firebase Admin SDK ────────────────────────────────────
initFirebase();
const db    = getDb();
const admin = getAdmin();

// ─── Express App ────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// CORS for cross-origin API calls (Tampermonkey, etc.)
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Worker-Secret');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// ═════════════════════════════════════════════════════════════════
// 1. OTP FETCH API — GET /get?number=01XXXXXXXXX
//
//    Fast path: read /number/{safeNum} (~50ms)
//    Fallback:  scan /sms/ for pending messages (~150ms)
//    Same behavior as current get.html + Cloudflare Worker
// ═════════════════════════════════════════════════════════════════
const MAX_OTP_AGE_MS = 2 * 60 * 1000; // 2 minutes

app.get('/get', async (req, res) => {
    const number = req.query.number;
    if (!number) {
        return res.json({ success: false, otp: '', error: 'Missing number' });
    }

    const safeNumber = number.replace(/[.#$[\]/]/g, '_');

    try {
        // ── Fast path: check /number/ ────────────────────────
        const snap = await db.ref(`number/${safeNumber}`).once('value');

        if (snap.exists() && snap.val() && snap.val().success) {
            const data     = snap.val();
            const otpAgeMs = Date.now() - (data.ts || 0);

            if (otpAgeMs > MAX_OTP_AGE_MS) {
                // Stale — delete and return false
                db.ref(`number/${safeNumber}`).remove().catch(() => {});
                return res.json({ success: false, otp: '' });
            }

            // Mark SMS as used in background (fire-and-forget)
            if (data.smsKey) {
                const now = Date.now();
                db.ref(`sms/${data.smsKey}`).update({
                    status: 'used',
                    viewedAt: now,
                    formattedViewed: new Date().toLocaleString('en-GB')
                }).catch(() => {});
            }

            return res.json({ success: true, otp: String(data.otp || '') });
        }

        // ── Fallback: scan /sms/ for matching pending messages ──
        // Handles the case where the server just woke up and the
        // child_added listener hasn't processed the message yet.
        const smsSnap = await db.ref('sms')
            .orderByChild('recipient')
            .equalTo(number)
            .limitToLast(5)
            .once('value');

        if (!smsSnap.exists()) {
            return res.json({ success: false, otp: '' });
        }

        const messages = [];
        smsSnap.forEach(child => {
            const msg = child.val();
            msg._key = child.key;
            messages.push(msg);
        });

        // Sort newest first
        messages.sort((a, b) => (b.arrivedAt || 0) - (a.arrivedAt || 0));

        const filters = getCachedFilters();

        for (const msg of messages) {
            if (msg.status === 'used' || msg.superseded) continue;

            // Check age
            const ageMs = Date.now() - (msg.arrivedAt || 0);
            if (ageMs > MAX_OTP_AGE_MS) continue;

            const code = msg.extractedCode ||
                         extractCode(msg.message || msg.code || '', msg.sender, msg.recipient, filters);
            if (!code) continue;

            // Write to /number/ so subsequent requests hit fast path
            db.ref(`number/${safeNumber}`).set({
                success: true,
                otp: code,
                smsKey: msg._key,
                ts: msg.arrivedAt || Date.now()
            }).catch(() => {});

            // Mark as used
            db.ref(`sms/${msg._key}`).update({
                status: 'used',
                viewedAt: Date.now(),
                formattedViewed: new Date().toLocaleString('en-GB')
            }).catch(() => {});

            return res.json({ success: true, otp: String(code) });
        }

        return res.json({ success: false, otp: '' });

    } catch (err) {
        console.error('[/get] Error:', err.message);
        return res.json({ success: false, otp: '' });
    }
});

// ═════════════════════════════════════════════════════════════════
// 2. FCM NOTIFY — POST /notify
//    Backup path: dashboard can trigger FCM directly.
//    Primary path is the server listener in listeners.js.
//    Auth: Firebase ID token OR shared secret.
// ═════════════════════════════════════════════════════════════════
app.post('/notify', async (req, res) => {
    // Auth check: Firebase ID token or env secret
    const authHeader = req.headers.authorization || '';
    const workerSecret = req.headers['x-worker-secret'] || '';
    const envSecret = process.env.DASHBOARD_SECRET || '';

    let authorized = false;

    if (envSecret && workerSecret === envSecret) {
        authorized = true;
    } else if (authHeader.startsWith('Bearer ')) {
        try {
            await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
            authorized = true;
        } catch (e) { /* invalid token */ }
    }

    if (!authorized) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { action } = req.body || {};
    if (!action || !['enable', 'disable'].includes(action)) {
        return res.status(400).json({ error: 'Invalid action' });
    }

    try {
        const result = await admin.messaging().send({
            topic : 'forwarding_control',
            data  : { action, timestamp: String(Date.now()) },
            android: { priority: 'high', ttl: 60000 }
        });
        res.json({ success: true, messageId: result });
    } catch (err) {
        console.error('[/notify] FCM error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═════════════════════════════════════════════════════════════════
// 3. CONFIG — GET /api/config
//    Returns Firebase client config for dashboard initialization.
//    Firebase API keys are designed to be public.
// ═════════════════════════════════════════════════════════════════
app.get('/api/config', (req, res) => {
    const raw = process.env.FIREBASE_CONFIG || '{}';
    try {
        res.json(JSON.parse(raw));
    } catch (e) {
        res.status(500).json({ error: 'FIREBASE_CONFIG env var is not valid JSON' });
    }
});

// ═════════════════════════════════════════════════════════════════
// 4. HEALTH — GET /health
//    For UptimeRobot / cron-job.org keepalive pings.
// ═════════════════════════════════════════════════════════════════
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() | 0 });
});

// ─── Start listeners + server ───────────────────────────────────
startListeners(db, admin);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[server] GetOTP Render Server v4.0 running on port ${PORT}`);
    console.log(`[server] OTP API:    /get?number=01XXXXXXXXX`);
    console.log(`[server] Dashboard:  /`);
    console.log(`[server] Health:     /health`);
});
