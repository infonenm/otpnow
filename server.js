/**
 * server.js — GetOTP Render Server v4.24.1
 *
 * VERSIONING: this server and the Android app version INDEPENDENTLY. There is
 * no single "GetOTP system version" — the app is far ahead because it changes
 * far more often. (This line named a specific app version and then went stale
 * by nine releases, which is the exact failure it was warning about. It does not
 * name one any more.) The one number that must agree is the one in
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
 *   POST /api/fetch-latest → Ask devices to forward their newest SMS (token auth)
 *   POST /api/logout      → Revoke the caller's session token (token auth)
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
const firestore = require('./lib/firestore');

// Initialize FCM (silent no-op if FIREBASE_SERVICE_ACCOUNT not set)
fcm.init();

// Durable config storage. init() is a no-op unless FIRESTORE_ENABLED is on.
// The LOAD below is deliberately not awaited: nothing may block the server
// from listening, so forwarding and fetching work from the first millisecond.
// See the deferred-extraction block in lib/store.js for the one window this
// leaves open and how it is closed without blocking.
firestore.init();
store.loadDurableConfig();
store.loadIdentity();

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

const DEFAULT_GATEWAYS = { bkash: [], rocket: [], dgepayebl: [] };

/**
 * Names a gateway alias may not take.
 *
 * Aliases are registered with app.get('/' + name) well ABOVE /health and the
 * static handler, so GATEWAYS={"health":[]} would quietly replace the keepalive
 * endpoint with an OTP fetcher — UptimeRobot would still get a 200 and you
 * would never know the check had stopped checking anything.
 */
const RESERVED_GATEWAY_NAMES = new Set(['get', 'sms', 'health', 'api']);

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
            if (RESERVED_GATEWAY_NAMES.has(name.toLowerCase())) {
                console.warn(`[server] Ignoring reserved gateway name "${name}" — `
                    + `it would shadow the real /${name.toLowerCase()} endpoint`);
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
const GATEWAY_PATHS = new Set(Object.keys(GATEWAYS).map(n => '/' + n));


// ─── Security headers ───────────────────────────────────────────
//
// A CSP is the second line under output escaping: even if a future template
// forgets esc(), an injected <script> has no source it is allowed to run from.
// 'unsafe-inline' is required because the dashboard is one self-contained file
// with inline styles and handlers — tightening that means splitting the file,
// which is a bigger change than it looks and is noted as an open item.
app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy',
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; " +
        "connect-src 'self'; " +
        "frame-ancestors 'none'; " +   // clickjacking: nothing may frame this
        "base-uri 'none'; " +          // an injected <base> cannot redirect loads
        "form-action 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');   // keeps ?token= out of Referer
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
});

// ─── CORS ───────────────────────────────────────────────────────
//
// The wildcard stays ONLY for the fetch paths the userscript uses from other
// origins (payment.bkash.com and friends). The dashboard API must not be
// wildcarded: with credentials in headers rather than cookies a wildcard is not
// directly exploitable, but it invites any page to probe these endpoints, and
// nothing legitimate calls them cross-origin.
app.use((req, res, next) => {
    const isFetchPath = req.path === '/get' || GATEWAY_PATHS.has(req.path);
    if (isFetchPath || req.path === '/health') {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Vary', 'Origin');
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

/**
 * Any signed-in caller. The session is attached to the request so every route
 * below can scope what it returns without re-deriving who is asking.
 *
 * getSession() re-checks that the account is still active on EVERY request, so
 * deactivating someone takes their controls away mid-session rather than at
 * token expiry. That check is a Map lookup — users are held in memory and
 * Firestore is never consulted on a request path.
 */
function requireToken(req, res, next) {
    const auth  = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || '');
    const session = store.getSession(token);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    req.session = session;
    next();
}

/** Admin only. User management, device assignment, and anything fleet-wide. */
function requireAdmin(req, res, next) {
    requireToken(req, res, () => {
        if (req.session.role !== 'admin') {
            return res.status(403).json({ error: 'Admin only' });
        }
        next();
    });
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
    const { sender, recipient, message, arrivedAt, deviceId } = req.body || {};
    if (!sender || !message) {
        return res.status(400).json({ error: 'Missing sender or message' });
    }

    const forwarding = store.isForwardingEnabled();
    if (!forwarding) {
        console.log(`[server] Declined SMS from ${sender} — forwarding is OFF`);
        return res.json({ success: true, ignored: true, globalForwarding: false });
    }

    if (deviceId) store.users.touchDevice(deviceId);
    const result = store.addSms(sender, recipient || 'Unknown', message,
                                arrivedAt || Date.now(), deviceId);
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
    // Presence, from the poll the app already makes. No new mechanism, no new
    // request — this is what answers "which phones are alive?" on the dashboard.
    if (req.query.deviceId) store.users.touchDevice(req.query.deviceId);
    res.json({
        globalForwarding: s.globalForwarding,
        clearLogTs:       s.clearLogTs,
        testMessageTs:    s.testMessageTs,
        // Third one-shot. The poller is the carrier that survives a phone with
        // no Play Services, so a command that only rode FCM would silently not
        // work on exactly the devices most likely to have missed the SMS.
        fetchLatestTs:    s.fetchLatestTs,
        // Dynamic allowlist. The app enforces it against this PLUS its own
        // compiled-in host, which no remote list can remove.
        allowedHosts:     store.usersEnabled() ? store.users.getAllowedHosts() : []
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


/** Shared by /get and every gateway alias — one implementation of the fetch. */
async function serveOtp(req, res, senderTokens) {
    const number = req.query.number;
    if (!number) return res.json({ success: false, otp: '', error: 'Missing number' });

    let otp = store.getOtp(number, senderTokens);
    if (otp) return res.json({ success: true, otp });

    const wait = Math.min(Math.max(parseInt(req.query.wait, 10) || 0, 0), MAX_WAIT_SECONDS);
    if (wait === 0) return res.json({ success: false, otp: '' });

    // Every long-poll slot is taken. Say so instead of parking, because
    // waitForOtp would refuse to park and resolve INSTANTLY — and the reply
    // below would then claim `timedOut` after zero milliseconds, which a client
    // reads as "I waited 25 s and nothing came" and answers by asking again
    // immediately. That turns saturation into a tight loop against a server
    // that is already saturated. `busy` is a different fact and deserves a
    // different word: back off, do not treat it as "no OTP yet".
    if (store.waitersFull()) {
        console.warn('[server] Long-poll slots full — answering busy rather than parking');
        return res.json({ success: false, otp: '', busy: true });
    }

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
// BACK-OFF ON FAILURE. (This comment used to justify itself with "the token
// never expires and cannot be revoked" — true of the old derived token, false
// since sessions became random and expiring. The back-off is still the right
// control for a different reason: the password itself does not rotate, and this
// endpoint is the only thing standing in front of it.) Each failure delays the NEXT
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

// Logout: kill the token server-side. Previously the client simply forgot it,
// so a copied token stayed valid forever.
app.post('/api/logout', requireToken, (req, res) => {
    const h = req.headers.authorization || '';
    store.revokeToken(h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || ''));
    res.json({ success: true });
});

app.post('/api/login', asyncRoute(async (req, res) => {
    const { password, username } = req.body || {};
    if (!password) return res.status(400).json({ error: 'Missing password' });

    // username absent = admin, which is exactly today's behaviour.
    const token = store.login(password, username);
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
    const session = store.getSession(token);
    res.json({ token, role: session.role, userId: session.userId });
}));

// First login: set a password with the one-time enrollment code.
//
// Without a code an account that has no password yet belongs to whoever reaches
// it first — a username is not a secret. Deliberately unauthenticated, because
// the code IS the authentication, and deliberately not saying whether the user
// exists, so it cannot be used to enumerate accounts.
app.post('/api/set-password', (req, res) => {
    if (!store.usersEnabled()) return res.status(404).json({ error: 'Users are not enabled' });
    const { username, code, password } = req.body || {};
    const r = store.users.setPassword(username, code, password);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ success: true });
});

// All current messages
app.get('/api/messages', requireToken, (req, res) => {
    // Scoped SERVER-SIDE. A user must not receive another user's messages and
    // have the browser hide them.
    res.json({ messages: store.getSmsFor(req.session.userId) });
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

// Force the device to fetch and forward its newest SMS.
//
// Distinct from /api/test, which asks the device to invent a message. This asks
// it to go and find a real one it may never have seen — the case where the app
// was force-stopped when the SMS arrived, and nothing on this server can know
// the message ever existed.
app.post('/api/fetch-latest', requireToken, (req, res) => {
    const ts = store.triggerFetchLatest();
    fcm.send('fetch_latest', ts);
    res.json({ success: true, fetchLatestTs: ts });
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

// ═════════════════════════════════════════════════════════════════
// IDENTITY — users, devices, allowed hosts (admin only)
// ═════════════════════════════════════════════════════════════════
//
// Every route here is behind USERS_ENABLED and requireAdmin. With the flag off
// they answer 404, so the surface does not exist until you turn it on.

function usersGate(req, res, next) {
    if (!store.usersEnabled()) return res.status(404).json({ error: 'Users are not enabled' });
    next();
}

app.get('/api/users', usersGate, requireAdmin, (req, res) => {
    res.json({ users: store.users.listUsers(), stats: store.users.stats() });
});

// Create a user. The enrollment code is returned ONCE, here. Hand it over out
// of band; it is what stops a passwordless account being claimed by whoever
// learns the username.
app.post('/api/users', usersGate, requireAdmin, (req, res) => {
    const { name } = req.body || {};
    const r = store.users.createUser(name);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ success: true, user: r.user, enrollCode: r.enrollCode });
});

// Reissue a code. The existing password stops working immediately — this is
// both the reset path and the "they forgot it" path.
app.post('/api/users/:id/reissue', usersGate, requireAdmin, (req, res) => {
    const r = store.users.reissueCode(req.params.id);
    if (!r.ok) return res.status(404).json({ error: r.error });
    store.revokeSessionsFor(store.users.slug(req.params.id));
    res.json({ success: true, enrollCode: r.enrollCode });
});

// Deactivate / reactivate.
//
// Deactivating revokes every live session on the spot, so their controls stop
// responding mid-click rather than at token expiry. Their DEVICES keep
// forwarding and their messages file to admin — nothing stops arriving while
// you work out who should own that phone.
app.post('/api/users/:id/active', usersGate, requireAdmin, (req, res) => {
    const { active } = req.body || {};
    if (typeof active !== 'boolean') return res.status(400).json({ error: 'active must be boolean' });
    const r = store.users.setActive(req.params.id, active);
    if (!r.ok) return res.status(404).json({ error: r.error });
    const killed = active ? 0 : store.revokeSessionsFor(store.users.slug(req.params.id));
    res.json({ success: true, user: r.user, sessionsRevoked: killed });
});

// Purge. Deliberately separate from deactivate and deliberately second: a hard
// delete on a live system takes phones off their owner instantly and has no
// undo. History is NOT rewritten — a message records what happened when it
// happened, and keeps the userId it was stamped with.
app.post('/api/users/:id/purge', usersGate, requireAdmin, (req, res) => {
    const id = store.users.slug(req.params.id);
    const r = store.users.purgeUser(id);
    if (!r.ok) return res.status(404).json({ error: r.error });
    store.revokeSessionsFor(id);
    res.json({ success: true, unassignedDevices: r.unassignedDevices });
});

// ─── Devices ────────────────────────────────────────────────────

app.get('/api/devices', usersGate, requireAdmin, (req, res) => {
    res.json({ devices: store.users.listDevices() });
});

app.post('/api/devices/:id/assign', usersGate, requireAdmin, (req, res) => {
    const { userId } = req.body || {};
    const r = store.users.assignDevice(req.params.id, userId === null ? null : userId);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ success: true, device: r.device });
});

app.post('/api/devices/:id/rename', usersGate, requireAdmin, (req, res) => {
    const r = store.users.renameDevice(req.params.id, (req.body || {}).name);
    if (!r.ok) return res.status(404).json({ error: r.error });
    res.json({ success: true, device: r.device });
});

app.post('/api/devices/:id/remove', usersGate, requireAdmin, (req, res) => {
    const r = store.users.removeDevice(req.params.id);
    if (!r.ok) return res.status(404).json({ error: 'No such device' });
    res.json({ success: true });
});

// ─── Allowed hosts ──────────────────────────────────────────────
//
// Served to the app on /api/settings so moving to a new server is a dashboard
// edit rather than a reinstall. The app keeps its COMPILED-IN host as a
// permanent anchor that no remote list can remove, so a bad list here can never
// strand a phone.
app.get('/api/allowed-hosts', usersGate, requireAdmin, (req, res) => {
    res.json({ hosts: store.users.getAllowedHosts() });
});

app.post('/api/allowed-hosts', usersGate, requireAdmin, (req, res) => {
    const r = store.users.setAllowedHosts((req.body || {}).hosts);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ success: true, hosts: r.hosts });
});

// ─── Device registration (from the app, API key auth) ───────────
//
// A phone announcing itself. It is NOT rejected for having no owner: its
// messages file to admin and it appears on the dashboard as unassigned, waiting
// for a click. Rejecting it would mean a new phone silently forwards nothing,
// which is the worst possible failure for a system whose job is not to lose
// messages.
app.post('/api/register', requireApiKey, (req, res) => {
    if (!store.usersEnabled()) {
        // Older-app compatibility runs the other way too: with the flag off,
        // say so plainly rather than 404ing an app that will retry forever.
        return res.json({ success: true, usersEnabled: false });
    }
    const { deviceId, model, name } = req.body || {};
    const device = store.users.registerDevice(deviceId, { model, name });
    res.json({
        success: true, usersEnabled: true,
        deviceId: device.id,
        assigned: !!device.userId,
        allowedHosts: store.users.getAllowedHosts()
    });
});

// Full settings (for dashboard settings panel)
app.get('/api/full-settings', requireToken, (req, res) => {
    // fcm included so "is push actually reaching my phones?" is answerable.
    // send() is fire-and-forget by design, so without this a broken service
    // account is completely silent — the dashboard toggle still returns 200 and
    // the device just never hears about it.
    // config included so "which source are these filters from, and did my last
    // save actually reach the cloud?" is answerable without reading the logs.
    res.json(Object.assign(store.getSettings(), {
        fcm:    fcm.getStatus(),
        config: store.configStatus()
    }));
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
