/**
 * server.js — GetOTP Render Server v4.15.0
 *
 * VERSIONING: this server and the Android app version INDEPENDENTLY. There is
 * no single "GetOTP system version" — the app is far ahead (4.16.x) because it
 * changes far more often. The one number that must agree is the one in
 * package.json, this header, and the startup log line below; they had drifted
 * to 4.5.0 / v4.5 / "v4.6" in three places, which made "which server is
 * actually deployed?" unanswerable from the logs.
 *
 * ZERO external dependencies. No Firebase, no Google Sheets, no Cloudflare.
 * Everything runs in-memory on this single Render service.
 *
 * Endpoints:
 *   POST /sms             → Receive SMS from Android app (API key auth)
 *   GET  /get?number=X    → OTP fetch API
 *   GET  /api/settings    → Settings for Android app polling (API key auth)
 *   POST /api/login       → Dashboard login (password → token)
 *   GET  /api/messages    → All current SMS (dashboard token auth)
 *   GET  /api/stream      → SSE real-time stream (dashboard token auth)
 *   POST /api/toggle      → Toggle forwarding (dashboard token auth)
 *   POST /api/clear-log   → Clear forward log on devices (dashboard token auth)
 *   POST /api/test        → Send test message to devices (dashboard token auth)
 *   POST /api/clear-all   → Delete all SMS (dashboard token auth)
 *   POST /api/filters     → Update filter rules (dashboard token auth)
 *   POST /api/auto-delete → Update auto-delete minutes (dashboard token auth)
 *   GET  /api/full-settings→ Full settings for dashboard (dashboard token auth)
 *   GET  /health          → Keepalive
 *   GET  /                → Dashboard
 */

const crypto  = require('crypto');
const express = require('express');
const path    = require('path');
const store   = require('./lib/store');
const otp     = require('./lib/otp');
const fcm     = require('./lib/fcm');

// Initialize FCM (silent no-op if FIREBASE_SERVICE_ACCOUNT not set)
fcm.init();

const app = express();
app.use(express.json({ limit: '100kb' }));

/**
 * Wrap an async route so a rejected promise becomes a normal Express error.
 *
 * =================================================================
 * WITHOUT THIS, ONE FAILURE TAKES THE WHOLE SERVICE DOWN.
 *
 * Express 4 does not catch rejections from an async handler, and
 * Node terminates the process on an unhandled rejection. /get and
 * every gateway alias are async, so a single unexpected throw
 * anywhere under them ends the process — losing every OTP held in
 * memory, dropping the dashboard, and forcing a cold start, which
 * on the free tier is measured in seconds. Verified by experiment,
 * not assumed.
 * =================================================================
 */
const asyncRoute = fn => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// ─── CORS ───────────────────────────────────────────────────────
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// ─── Auth middleware ────────────────────────────────────────────

function requireApiKey(req, res, next) {
    const key = req.headers['x-api-key'] || '';
    const expected = process.env.API_KEY || '';
    if (!expected) return next();   // dev mode: no key configured
    if (key !== expected) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

/**
 * Auth for the OTP fetch endpoint.
 *
 * SEPARATE from API_KEY on purpose. API_KEY authorises a device to POST SMS and
 * is also the HMAC secret behind the dashboard token, so handing it to every
 * fetching script would mean one leaked script grants both. GET_KEY does one
 * thing and can be rotated on its own.
 *
 * OPT-IN: if GET_KEY is unset the endpoint behaves exactly as it does today.
 * Deploy, confirm nothing broke, add the env var, then update the scripts.
 *
 * Cost: one string comparison. No round trip, no lookup, nothing measurable.
 */
function requireGetKey(req, res, next) {
    const expected = process.env.GET_KEY || '';
    if (!expected) return next();
    const given = req.query.key || req.headers['x-get-key'] || '';
    if (given.length !== expected.length) return res.status(401).json({ success: false, otp: '', error: 'Unauthorized' });
    try {
        if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
            return res.status(401).json({ success: false, otp: '', error: 'Unauthorized' });
        }
    } catch (e) {
        return res.status(401).json({ success: false, otp: '', error: 'Unauthorized' });
    }
    next();
}

function requireToken(req, res, next) {
    const auth  = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || '');
    if (!store.validateToken(token)) return res.status(401).json({ error: 'Unauthorized' });
    next();
}


// ═════════════════════════════════════════════════════════════════
// ANDROID APP ENDPOINTS
// ═════════════════════════════════════════════════════════════════

// 1. RECEIVE SMS — from RenderForwarder on Android
//
// THE SERVER IS THE FINAL WORD ON THE OFF SWITCH.
//
// When forwarding is off on the dashboard, a message that arrives here is NOT
// stored — not in smsMap, not in numberMap, not broadcast to the dashboard. The
// device is supposed to have stopped sending already, but "supposed to" is not
// a guarantee: a phone that is asleep, offline, force-stopped or simply hasn't
// received the command yet will keep pushing. Enforcing it here means OFF means
// off from the moment you press it, whatever any device believes.
//
// The reply is 200, not an error, ON PURPOSE. A 4xx would make the app's queue
// treat this as a failure and retry the same message for the next ten passes;
// a 5xx would do the same and blame the server. This is not a failure — it is a
// message we deliberately declined, so the device should consider it done and
// move on.
//
// Every reply also carries globalForwarding. That makes each push a free sync
// point: a device that missed the OFF command learns it from the very next SMS
// it forwards, with no extra request and no extra latency. (It cannot deliver an
// ON that way — a device that is off sends nothing — which is why the alarm
// chain and the worker still exist.)
app.post('/sms', requireApiKey, (req, res) => {
    const { sender, recipient, message, arrivedAt } = req.body || {};
    if (!sender || !message) {
        return res.status(400).json({ error: 'Missing sender or message' });
    }

    const forwarding = store.isForwardingEnabled();
    if (!forwarding) {
        console.log(`[server] Declined SMS from ${sender} — forwarding is OFF`);
        return res.json({ success: true, ignored: true, globalForwarding: false });
    }

    const result = store.addSms(sender, recipient || 'Unknown', message, arrivedAt || Date.now());
    res.json({ success: true, id: result.id, code: result.code || null, globalForwarding: true });
});

// 2. OTP FETCH API — replaces Cloudflare Worker + Apps Script 2
//
// TWO MODES:
//
//   GET /get?number=X            immediate. Returns whatever is there right now.
//                                Unchanged from every previous version.
//
//   GET /get?number=X&wait=20    long-poll. Holds the connection open for up to
//                                20 seconds and answers THE INSTANT the SMS
//                                arrives — no polling interval in the middle.
//
// The second mode is the single biggest latency win available here. A script
// polling once a second adds 500 ms on average waiting for its own next tick;
// that is more than the phone, the network and this server put together. With
// wait=, the request is already parked when the SMS lands and the OTP goes out
// on a connection that is already open.
//
// Long-poll consumes through exactly the same getOtp() path, so consume-on-read,
// supersede and the dashboard update are identical. wait=0 (or omitted) is the
// old behaviour byte for byte.
const MAX_WAIT_SECONDS = 25;   // stays under proxy idle limits; clients re-ask

app.get('/get', requireGetKey, asyncRoute((req, res) => serveOtp(req, res, undefined)));


// 3. SETTINGS FOR APP POLLING — replaces Firebase RTDB listeners
//
// This is the SECOND CARRIER for every dashboard command, not a legacy leftover:
//   globalForwarding  the device converges on this level-triggered, every poll
//   clearLogTs        one-shot, de-duplicated against FCM by timestamp
//   testMessageTs     ditto
//
// The two timestamps are the same values passed to fcm.send() below, which is
// exactly what lets the app run each command once no matter which carrier gets
// there first. Do not remove them because "FCM handles that" — FCM is absent
// after a force-stop and on devices without Play Services, and Test Message is
// the button you press precisely when FCM is the thing that is broken.
app.get('/api/settings', requireApiKey, (req, res) => {
    const s = store.getSettings();
    res.json({
        globalForwarding: s.globalForwarding,
        clearLogTs:       s.clearLogTs,
        testMessageTs:    s.testMessageTs
    });
});


// 2b. GATEWAY ALIASES — /bkash, /rocket, /dgepayebl …
//
// =================================================================
// WHY THESE EXIST
//
// The Payment Auto Fill userscript calls /bkash?number=X,
// /rocket?number=X and /dgepayebl?number=X. Those names come from a
// different server; on this one they were plain 404s, so the script
// received an HTML error page, JSON.parse threw, and it silently
// retried twenty times over a minute before giving up. It looked
// like "the OTP never arrived".
//
// Rather than edit a script that holds card details, the endpoints
// exist here. Each is /get with an optional SENDER SCOPE.
//
// SCOPES ARE EMPTY BY DEFAULT, ON PURPOSE. An empty scope behaves
// exactly like /get — the latest OTP for that number, whoever sent
// it — so this works immediately without me guessing sender IDs I
// cannot see. Once you know the real ones (they are on the
// dashboard next to each message), set GATEWAYS and each alias will
// only answer with an OTP from its own gateway.
//
//   GATEWAYS={"bkash":["bkash"],"rocket":["rocket","16216"],
//             "dgepayebl":["EBL"]}
//
// A scoped alias never consumes an OTP that is not its own, so two
// gateways polling the same SIM cannot steal from each other.
// =================================================================
const DEFAULT_GATEWAYS = { bkash: [], rocket: [], dgepayebl: [] };

function parseGateways() {
    const raw = process.env.GATEWAYS;
    if (!raw) return DEFAULT_GATEWAYS;
    try {
        const parsed = JSON.parse(raw);
        const out = {};
        for (const [name, tokens] of Object.entries(parsed)) {
            if (!/^[a-z0-9_-]{1,32}$/i.test(name)) {
                console.warn(`[server] Ignoring invalid gateway name: ${name}`);
                continue;
            }
            out[name] = Array.isArray(tokens) ? tokens.map(String) : [];
        }
        return Object.keys(out).length ? out : DEFAULT_GATEWAYS;
    } catch (e) {
        console.warn(`[server] GATEWAYS is not valid JSON, using defaults: ${e.message}`);
        return DEFAULT_GATEWAYS;
    }
}

const GATEWAYS = parseGateways();

/** Shared by /get and every gateway alias — one implementation of the fetch. */
async function serveOtp(req, res, senderTokens) {
    const number = req.query.number;
    if (!number) return res.json({ success: false, otp: '', error: 'Missing number' });

    let otp = store.getOtp(number, senderTokens);
    if (otp) return res.json({ success: true, otp });

    const wait = Math.min(Math.max(parseInt(req.query.wait, 10) || 0, 0), MAX_WAIT_SECONDS);
    if (wait === 0) return res.json({ success: false, otp: '' });

    let clientGone = false;
    res.on('close', () => { clientGone = true; });

    otp = await store.waitForOtp(number, wait * 1000, (cancel) => {
        res.on('close', cancel);
    }, senderTokens);

    if (clientGone) {
        if (otp) store.unconsume(number, otp);
        return;
    }
    if (otp) return res.json({ success: true, otp });
    return res.json({ success: false, otp: '', timedOut: true });
}

for (const [name, tokens] of Object.entries(GATEWAYS)) {
    app.get('/' + name, requireGetKey, asyncRoute((req, res) => serveOtp(req, res, tokens)));
    console.log(`[server] Gateway alias /${name}`
        + (tokens.length ? ` scoped to sender ${JSON.stringify(tokens)}` : ' (any sender)'));
}


// ═════════════════════════════════════════════════════════════════
// DASHBOARD ENDPOINTS
// ═════════════════════════════════════════════════════════════════

// Login — password from env var, returns session token
//
// BACK-OFF ON FAILURE. The dashboard token never expires and cannot be revoked
// short of changing the password, so an unlimited-rate guessing endpoint in
// front of it is the weak point. Each consecutive failure delays the NEXT
// failed answer, doubling to a five-second ceiling, which turns a feasible
// online brute force into an infeasible one.
//
// Deliberately global rather than per-IP: an attacker rotating addresses would
// walk straight past a per-IP counter, and Render sits behind a proxy so the
// address is not trustworthy anyway. The delay applies ONLY to wrong passwords,
// so it can never lock you out — the correct password answers immediately no
// matter how many failures preceded it.
let loginFailures = 0;
const LOGIN_MAX_DELAY_MS = 5000;

app.post('/api/login', asyncRoute(async (req, res) => {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'Missing password' });

    const token = store.login(password);
    if (!token) {
        const delay = Math.min(100 * Math.pow(2, loginFailures), LOGIN_MAX_DELAY_MS);
        loginFailures++;
        console.warn(`[server] Failed dashboard login #${loginFailures} — delaying ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        return res.status(401).json({ error: 'Wrong password' });
    }

    if (loginFailures > 0) {
        console.log(`[server] Dashboard login OK after ${loginFailures} failed attempt(s)`);
        loginFailures = 0;
    }
    res.json({ token });
}));

// All current messages
app.get('/api/messages', requireToken, (req, res) => {
    res.json({ messages: store.getAllSms() });
});

// SSE real-time stream
app.get('/api/stream', requireToken, (req, res) => {
    store.addSSEClient(res);
});

// Toggle forwarding
app.post('/api/toggle', requireToken, (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
    const ts = Date.now();
    store.setGlobalForwarding(enabled);
    fcm.send(enabled ? 'enable' : 'disable', ts);
    res.json({ success: true, globalForwarding: enabled });
});

// Clear forward log on devices
app.post('/api/clear-log', requireToken, (req, res) => {
    const ts = Date.now();          // single timestamp for both paths
    store.triggerClearLog(ts);
    fcm.send('clear_log', ts);
    res.json({ success: true });
});

// Send test message to devices
app.post('/api/test', requireToken, (req, res) => {
    const ts = Date.now();          // single timestamp for both paths
    store.triggerTestMessage(ts);
    fcm.send('test', ts);
    res.json({ success: true });
});

// Clear all SMS from server
app.post('/api/clear-all', requireToken, (req, res) => {
    store.clearAll();
    res.json({ success: true });
});

// Update filters
app.post('/api/filters', requireToken, (req, res) => {
    const { filters } = req.body || {};
    if (!Array.isArray(filters)) return res.status(400).json({ error: 'filters must be an array' });

    // Refuse a rule that can never match. A double-escaped or group-less
    // pattern looks perfectly fine sitting in the dashboard and silently loses
    // every OTP from that sender — and because a sender rule does not fall back
    // to DEFAULT, one bad paste kills that sender outright. Fail here instead.
    const problems = [];
    for (const rule of filters) {
        const label = (rule && rule.phoneNumber) || '(unnamed)';
        const pats = (rule && rule.patterns) || [];
        if (!Array.isArray(pats) || pats.length === 0) {
            problems.push(`${label}: no patterns`);
            continue;
        }
        for (const p of pats) {
            const why = otp.validatePattern(p);
            if (why) problems.push(`${label}: ${why}  —  got ${JSON.stringify(p)}`);
        }
    }
    if (problems.length) {
        return res.status(400).json({ error: 'Some patterns would never match', problems });
    }

    store.setFilters(filters);
    res.json({ success: true });
});

// Update auto-delete minutes
app.post('/api/auto-delete', requireToken, (req, res) => {
    const { minutes } = req.body || {};
    if (typeof minutes !== 'number') return res.status(400).json({ error: 'minutes must be a number' });
    store.setAutoDeleteMinutes(minutes);
    res.json({ success: true });
});

// Full settings (for dashboard settings panel)
app.get('/api/full-settings', requireToken, (req, res) => {
    // fcm included so "is push actually reaching my phones?" is answerable.
    // send() is fire-and-forget by design, so without this a broken service
    // account is completely silent — the dashboard toggle still returns 200 and
    // the device just never hears about it.
    res.json(Object.assign(store.getSettings(), { fcm: fcm.getStatus() }));
});


// ═════════════════════════════════════════════════════════════════
// STATIC (dashboard) — mounted LAST
// ═════════════════════════════════════════════════════════════════
//
// Below the API routes on purpose. express.static does a filesystem stat on
// every request that reaches it, so mounting it first made every /get and /sms
// pay for a lookup of a file that was never going to exist. Nothing above
// handles '/', so the dashboard still serves from here exactly as before.
app.use(express.static(path.join(__dirname, 'public')));


app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() | 0 });
});


// ═════════════════════════════════════════════════════════════════
// 404 AND ERRORS — always JSON, never an HTML page
// ═════════════════════════════════════════════════════════════════
//
// A mistyped endpoint used to return Express's HTML error page. The
// fetching userscript does JSON.parse on the reply, so it threw, and
// the catch treated it exactly like "OTP not ready" — retrying for a
// minute against an endpoint that does not exist, with nothing said.
// JSON here means a client always gets an answer it can read.
app.use((req, res) => {
    res.status(404).json({
        success: false, otp: '',
        error: `No such endpoint: ${req.method} ${req.path}`
    });
});

// Four arguments — this is Express's error handler. asyncRoute funnels
// every async failure here instead of into an unhandled rejection.
app.use((err, req, res, next) => {
    // Honour a status the error already carries. express.json() rejects a
    // malformed body with status 400 — reporting that as 500 would tell the
    // client the SERVER is broken when the request was, and send it retrying
    // against a fault it can actually fix.
    const status = (err && (err.status || err.statusCode)) || 500;

    if (status >= 500) {
        console.error(`[server] ${req.method} ${req.path} failed:`, err && err.stack || err);
    }
    if (res.headersSent) return;

    res.status(status).json({
        success: false, otp: '',
        // A client error names itself; a server error never leaks its internals.
        error: status < 500 ? (err.message || 'Bad request') : 'Internal error'
    });
});


// ═════════════════════════════════════════════════════════════════
// HEALTH
// ═════════════════════════════════════════════════════════════════


// ─── Last-resort guards ─────────────────────────────────────────
//
// Staying up is worth more than a clean exit here. A crash loses every OTP in
// memory and costs a cold start; a logged error costs a line in the log. The
// error handler above catches everything routed through Express — these two
// cover a timer, an SSE write or a background task that Express never sees.
process.on('unhandledRejection', (reason) => {
    console.error('[server] Unhandled rejection (kept running):', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[server] Uncaught exception (kept running):', err && err.stack || err);
});


// ─── Start server ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[server] GetOTP Render v${require('./package.json').version} on port ${PORT}`);
    console.log(`[server] POST /sms           — receive SMS`);
    console.log(`[server] GET  /get           — OTP fetch (add &wait=20 to long-poll)`);
    console.log(`[server] GET  /api/settings  — app polling`);
    console.log(`[server] GET  /api/stream    — SSE dashboard`);
    console.log(`[server] GET  /              — dashboard`);
    console.log(`[server] GET  /health        — keepalive`);
});
