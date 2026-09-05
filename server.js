/**
 * server.js — GetOTP Render Server v4.32.3
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
 * DEPENDENCIES: express, and firebase-admin for FCM push and — since 4.23.0 —
 * Firestore, which holds the durable config, the user table and the SMS
 * archive. This header said "ZERO external dependencies. No Firebase" for
 * several releases after that stopped being true.
 *
 * Firestore is read at boot and written on change. It is NEVER on the path from
 * an SMS to the dashboard or from /get to an OTP — test/firestore.test.js
 * asserts that by counting calls. Everything an OTP touches is in memory.
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
const history   = require('./lib/history');

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
history.start();

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
    // X-Get-Key was missing while .env.example advertised it as an alternative
    // to ?key= — harmless for GM_xmlhttpRequest, broken for a browser fetch.
    res.setHeader('Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Api-Key, X-Get-Key');
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
    // HEADER ONLY. ?token= used to be accepted for every endpoint because the
    // SSE stream needed it; the stream now uses a single-use ticket instead, so
    // a long-lived session token never appears in a URL — or in a proxy log.
    const auth  = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
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

    // PER DEVICE, not global: a user may have turned their own phones back on
    // for a bounded window while the global switch is off. Same function the
    // app is answered with below, so enforcement and instruction cannot differ.
    if (!store.forwardingFor(deviceId)) {
        console.log(`[server] Declined SMS from ${sender} — forwarding is OFF`);
        // globalRaw travels with EVERY state the app is told, not just the poll.
        // Sending only the effective value made an override look like an admin
        // toggle — see the note on globalRaw in /api/settings.
        return res.json({ success: true, ignored: true,
                          globalForwarding: false,
                          globalRaw: store.isForwardingEnabled() });
    }

    if (deviceId) store.users.touchDevice(deviceId);
    const result = store.addSms(sender, recipient || 'Unknown', message,
                                arrivedAt || Date.now(), deviceId);
    res.json({ success: true, id: result.id, code: result.code || null,
               globalForwarding: true, globalRaw: store.isForwardingEnabled() });
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
    const cmds = store.commandsFor(req.query.deviceId);
    res.json({
        // The EFFECTIVE answer for this device — what it should DO.
        globalForwarding: store.forwardingFor(req.query.deviceId),
        // ...and the RAW global switch, which is what a "dashboard transition"
        // means. The app used to see only the effective value and treat every
        // change of it as an admin toggle, so a user starting or expiring their
        // own override silently cleared a deliberate local opt-out on their
        // phones. Two meanings, two fields.
        globalRaw:        store.isForwardingEnabled(),
        // Per device: the newer of the broadcast timestamp and this owner's.
        // RemoteCommands already de-duplicates by timestamp, so targeting
        // needed no app change at all.
        clearLogTs:       cmds.clearLogTs,
        testMessageTs:    cmds.testMessageTs,
        // Third one-shot. The poller is the carrier that survives a phone with
        // no Play Services, so a command that only rode FCM would silently not
        // work on exactly the devices most likely to have missed the SMS.
        fetchLatestTs:    cmds.fetchLatestTs,
        // OMITTED when unconfigured, rather than sent as [].
        //
        // The app treats an empty list as "not configured" and allows any host —
        // deliberately, so an older server that sends no list cannot brick a
        // phone. But this endpoint sent an explicit [] whenever the list was
        // unset OR users were switched off, which is indistinguishable from
        // that, and it also CLEARED a list a phone had already been given. So
        // turning USERS_ENABLED off silently un-configured every phone.
        //
        // Absent = "I have nothing to say, keep what you have".
        // Present = "this is the list, enforce it".
        ...(store.usersEnabled() && store.users.getAllowedHosts().length
              ? { allowedHosts: store.users.getAllowedHosts() } : {}),
        // Which user owns this device, so the app can join that FCM topic and
        // admin targeting can reach some phones and not others.
        userId:           (store.usersEnabled() && req.query.deviceId
                           && store.users.ownerOf(req.query.deviceId) !== store.users.ADMIN_ID)
                              ? store.users.ownerOf(req.query.deviceId)
                              : ''
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

    // No long-poll slot for this caller. Say so instead of parking, because
    // waitForOtp would refuse to park and resolve INSTANTLY — and the reply
    // below would then claim `timedOut` after zero milliseconds, which a client
    // reads as "I waited 25 s and nothing came" and answers by asking again
    // immediately. That turns saturation into a tight loop against a server
    // that is already saturated. `busy` is a different fact and deserves a
    // different word: back off, do not treat it as "no OTP yet".
    //
    // The NUMBER is passed so the per-number cap gets the same answer. A cap
    // that refused to park but still reported `timedOut` would recreate the
    // tight loop it exists to prevent, on exactly the number already causing it.
    if (store.waitersFull(number)) {
        console.warn('[server] No long-poll slot — answering busy rather than parking');
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
    store.revokeToken(h.startsWith('Bearer ') ? h.slice(7) : '');
    res.json({ success: true });
});

app.post('/api/login', asyncRoute(async (req, res) => {
    const { password, username } = req.body || {};
    if (!password) return res.status(400).json({ error: 'Missing password' });

    // username absent = admin, which is exactly today's behaviour.
    const token = await store.login(password, username);
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
let enrollFailures = 0;

// usersGate FIRST, and that order matters. With USERS_ENABLED off, loadIdentity
// never runs and isLoaded() is false — so putting the identity guard first would
// answer 503 "still loading" for a feature that is switched off and will never
// load. The flag question has to be settled before the readiness one. usersGate
// says exactly what the inline check here used to.
app.post('/api/set-password', usersGate, requireIdentityLoadedForEnroll,
         asyncRoute(async (req, res) => {
    const { username, code, password } = req.body || {};
    const r = await store.users.setPassword(username, code, password);

    if (!r.ok) {
        // Same back-off as /api/login, and for the same reason: an enrollment
        // code is eight characters and grants a real account. This endpoint is
        // unauthenticated by design — the code IS the authentication — so it was
        // the one guessable door with nothing in front of it.
        //
        // Only a FAILURE is delayed, so a legitimate enrollment is never slowed
        // however many attempts preceded it.
        const delay = Math.min(100 * Math.pow(2, enrollFailures), LOGIN_MAX_DELAY_MS);
        enrollFailures++;
        console.warn(`[server] Failed enrollment #${enrollFailures} — delaying ${delay}ms`);
        await new Promise(t => setTimeout(t, delay));
        return res.status(400).json({ error: r.error });
    }
    enrollFailures = 0;
    res.json({ success: true });
}));

// All current messages
app.get('/api/messages', requireToken, (req, res) => {
    // Scoped SERVER-SIDE. A user must not receive another user's messages and
    // have the browser hide them.
    res.json({ messages: store.getSmsFor(req.session.userId) });
});

// SSE real-time stream
// One ticket, one stream, thirty seconds.
app.get('/api/stream-ticket', requireToken, (req, res) => {
    res.json({ ticket: store.issueStreamTicket(req.session) });
});

app.get('/api/stream', (req, res) => {
    const session = store.redeemStreamTicket(req.query.ticket);
    if (!session) return res.status(401).json({ error: 'Invalid or expired stream ticket' });
    store.addSSEClient(res, session);
});

// Toggle forwarding
// GLOBAL settings are ADMIN ONLY, and this is enforced here rather than by
// hiding a button. Any signed-in user could previously change the OTP filters,
// the auto-delete window and the global forwarding switch — one user breaking
// extraction for everybody. A user's own controls (their messages, their
// override, commands aimed at their own phones) stay open to them.
app.post('/api/toggle', requireAdmin, (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
    const ts = Date.now();
    store.setGlobalForwarding(enabled);

    // A GLOBAL "disable" GOES TO EVERY DEVICE, INCLUDING ONES WITH A LIVE
    // OVERRIDE — and the app's response is to stop handing SMS to the queue at
    // all, so messages in that window are DROPPED, not delayed. The override is
    // documented as running its own clock; for up to 30 seconds it did not.
    //
    // So when any override is live, the broadcast push is skipped. Every device
    // still converges: the poller answers with the effective state for THAT
    // device within 30s, and until then the server declines and stores nothing,
    // so an ordinary user loses no message either — they simply keep pushing
    // into a refusal for a little longer.
    const live = Object.keys(store.listOverrides());
    if (enabled || live.length === 0) {
        fcm.send(enabled ? 'enable' : 'disable', ts);
    } else {
        console.warn(`[server] Global OFF: skipping the broadcast push because `
            + `${live.length} override(s) are live (${live.join(', ')}). Devices `
            + `converge on the 30s poll; the server declines meanwhile.`);
    }
    res.json({ success: true, globalForwarding: enabled });
});

// Clear forward log on devices
/**
 * Who a one-shot command is aimed at.
 *
 * A user can only ever command their own phones — the target is their own id
 * and the body is ignored. An admin may say "all" (the default, which is
 * exactly today's behaviour) or name one user.
 */
/**
 * @returns {string|null|false} user id, null for everyone, false if invalid.
 *
 * FALSE IS NOT null. slug() returns '' for a name with no letters or digits, and
 * '' is falsy — so a malformed target fell straight through to the broadcast
 * branch. Aiming at garbage widened the scope to every device, which is the
 * opposite of what the caller asked for. Widening scope on bad input is never
 * the safe default.
 */
function commandTarget(req) {
    if (req.session.role !== 'admin') return req.session.userId;
    const t = (req.body || {}).target;
    if (t === undefined || t === null || t === '' || t === 'all') return null;

    const id = store.users.slug(t);
    if (!id) return false;
    if (store.usersEnabled() && !store.users.listUsers().some(u => u.id === id)) return false;
    return id;
}

/** Shared guard: reject an invalid target rather than broadening it. */
function rejectBadTarget(target, res) {
    if (target !== false) return false;
    res.status(400).json({ error: 'Unknown target user. Use "all" or an existing user id.' });
    return true;
}

/** Broadcast topic, or one owner's. */
function topicFor(target) { return target ? 'user_' + target : undefined; }

app.post('/api/clear-log', requireToken, (req, res) => {
    const target = commandTarget(req);
    if (rejectBadTarget(target, res)) return;
    const ts = store.triggerClearLog(Date.now(), target);
    fcm.send('clear_log', ts, topicFor(target));
    res.json({ success: true, target: target || 'all' });
});

// Send test message to devices
app.post('/api/test', requireToken, (req, res) => {
    const target = commandTarget(req);
    if (rejectBadTarget(target, res)) return;
    const ts = store.triggerTestMessage(Date.now(), target);
    fcm.send('test', ts, topicFor(target));
    res.json({ success: true, target: target || 'all' });
});

// Force the device to fetch and forward its newest SMS.
//
// Distinct from /api/test, which asks the device to invent a message. This asks
// it to go and find a real one it may never have seen — the case where the app
// was force-stopped when the SMS arrived, and nothing on this server can know
// the message ever existed.
app.post('/api/fetch-latest', requireToken, (req, res) => {
    const target = commandTarget(req);
    if (rejectBadTarget(target, res)) return;
    const ts = store.triggerFetchLatest(Date.now(), target);
    fcm.send('fetch_latest', ts, topicFor(target));
    res.json({ success: true, fetchLatestTs: ts, target: target || 'all' });
});

// ─── Per-user forwarding override ───────────────────────────────
//
// A user turning their OWN phones back on while the admin's global switch is
// off. Any signed-in user may do this for themselves — there is deliberately no
// per-user bar on it, by Riad's decision.
app.post('/api/override', usersGate, requireToken, (req, res) => {
    const { minutes, userId } = req.body || {};
    // An admin may start one on a user's behalf; a user only for themselves.
    const target = (req.session.role === 'admin' && userId)
        ? store.users.slug(userId) : req.session.userId;

    const r = store.startOverride(target, minutes);
    if (!r.ok) return res.status(400).json({ error: r.error });

    // A DISTINCT ACTION, not 'enable'.
    //
    // It reused 'enable', and the push handler treats enable/disable as "the
    // admin toggled the dashboard" — which clears local_opt_out. So starting
    // your own override switched your phone back on even if you had
    // deliberately switched it off AT the phone. 'override_on' says what it is:
    // forward now, but the global switch has NOT moved.
    fcm.send('override_on', Date.now(), 'user_' + target);
    res.json({ success: true, expiresAt: r.expiresAt, minutes: r.minutes,
               clamped: r.clamped, ceiling: store.overrideCeilingMinutes() });
});

app.post('/api/override/cancel', usersGate, requireToken, (req, res) => {
    const { userId } = req.body || {};
    const target = (req.session.role === 'admin' && userId)
        ? store.users.slug(userId) : req.session.userId;
    store.cancelOverride(target);
    if (!store.isForwardingEnabled()) fcm.send('override_off', Date.now(), 'user_' + target);
    res.json({ success: true });
});

app.get('/api/override', usersGate, requireToken, (req, res) => {
    res.json({
        ceiling:   store.overrideCeilingMinutes(),
        mine:      store.overrideRemaining(req.session.userId),
        all:       req.session.role === 'admin' ? store.listOverrides() : undefined
    });
});

// Clear all SMS from server
app.post('/api/clear-all', requireToken, (req, res) => {
    // A user clears only their own. Admin clears everything, as today.
    store.clearAll(req.session.role === 'admin' ? null : req.session.userId);
    res.json({ success: true });
});

// Update filters
app.post('/api/filters', requireAdmin, (req, res) => {
    const { filters } = req.body || {};
    if (!Array.isArray(filters)) return res.status(400).json({ error: 'filters must be an array' });

    // Refuse a rule that can never match. A double-escaped or group-less
    // pattern looks perfectly fine sitting in the dashboard and silently loses
    // every OTP from that sender — and because a sender rule does not fall back
    // to DEFAULT, one bad paste kills that sender outright. Fail here instead.
    const problems = [];
    for (const rule of filters) {
        const label = (rule && rule.phoneNumber) || '(unnamed)';
        // Patterns were validated exhaustively and the NAME never was — so a
        // rule with a blank name saved cleanly and then claimed every sender.
        const ruleProblem = otp.validateRule(rule);
        if (ruleProblem) { problems.push(`${label}: ${ruleProblem}`); continue; }
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
app.post('/api/auto-delete', requireAdmin, (req, res) => {
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

/**
 * Refuse a change that could not be saved.
 *
 * While the identity load has never succeeded, markDirty() correctly refuses to
 * persist — so creating a user "worked", appeared on screen, and vanished at the
 * next restart. Silently. Accepting an edit you cannot keep is worse than
 * refusing it, because the operator walks away believing it is done.
 */
/**
 * @returns {boolean} true if the request was already answered and must stop.
 *
 * One check, two audiences. The admin can act on "press Retry now"; someone
 * enrolling with a code cannot — they are not looking at Settings and have no
 * way to reach it. Telling them to would send them hunting for a screen they
 * will never find, so they get the one instruction that is true for them.
 */
function identityNotLoaded(res, message) {
    if (store.users.isLoaded()) return false;
    res.status(503).json({ error: message });
    return true;
}

// DECLARATIONS, not const middleware. Routes are registered in file order and
// /api/set-password sits several hundred lines ABOVE this block; a const here
// would be in its temporal dead zone at registration time and the server would
// refuse to start. usersGate above is a declaration for the same reason.
function requireIdentityLoaded(req, res, next) {
    if (identityNotLoaded(res,
        'User data has not loaded from Firestore yet, so changes cannot be '
      + 'saved and would be lost at the next restart. Your existing accounts '
      + 'are safe in Firestore. Open Settings > Config storage and press '
      + 'Retry now, or wait — it retries by itself.')) return;
    next();
}

/**
 * The same guard, worded for the person enrolling.
 *
 * =============================================================================
 * /api/set-password WAS THE ONE IDENTITY WRITE WITH NO GUARD.
 *
 * Every other mutating identity route has had this since it was added; this one
 * was missed, and it is the route a NEW user hits. During a Firestore outage it
 * accepted the password, cleared the one-time enrollment code in memory, and
 * then markDirty() correctly refused to persist any of it — so the account came
 * back after the next restart with no password and the OLD code live again,
 * while the person had been told they were enrolled and could not sign in.
 *
 * Refusing up front is the whole point of the guard: an edit you cannot keep
 * must not be accepted, and this is the edit that costs someone their account.
 * =============================================================================
 */
function requireIdentityLoadedForEnroll(req, res, next) {
    if (identityNotLoaded(res,
        'The server cannot save your password right now because it is still loading '
      + 'its user data. Nothing has been changed and your enrollment code still '
      + 'works — wait a moment and try again, or tell the admin if it keeps '
      + 'happening.')) return;
    next();
}

app.get('/api/users', usersGate, requireAdmin, (req, res) => {
    res.json({ users: store.users.listUsers(), stats: store.users.stats() });
});

// Create a user. The enrollment code is returned ONCE, here. Hand it over out
// of band; it is what stops a passwordless account being claimed by whoever
// learns the username.
app.post('/api/users', usersGate, requireAdmin, requireIdentityLoaded, (req, res) => {
    const { name } = req.body || {};
    const r = store.users.createUser(name);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ success: true, user: r.user, enrollCode: r.enrollCode });
});

// Reissue a code. The existing password stops working immediately — this is
// both the reset path and the "they forgot it" path.
app.post('/api/users/:id/reissue', usersGate, requireAdmin, requireIdentityLoaded, (req, res) => {
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
app.post('/api/users/:id/active', usersGate, requireAdmin, requireIdentityLoaded, (req, res) => {
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
app.post('/api/users/:id/purge', usersGate, requireAdmin, requireIdentityLoaded, (req, res) => {
    const id = store.users.slug(req.params.id);
    const r = store.users.purgeUser(id);
    if (!r.ok) return res.status(404).json({ error: r.error });
    store.revokeSessionsFor(id);
    res.json({ success: true, unassignedDevices: r.unassignedDevices });
});

// ─── Devices ────────────────────────────────────────────────────

// ─── Move phones to a new server ────────────────────────────────
//
// The app has understood `set_url` since 4.28.0 and nothing could send it, so
// the feature existed only in the phone. This is the other half.
//
// THE ALLOWLIST IS CHECKED HERE TOO, not only on the phone. The app would refuse
// a host that is not on the list — correctly — but the operator would see a
// cheerful "sent" and no phones moving, with no way to tell that from FCM being
// broken. Refusing here means the mistake is reported where it was made.
app.post('/api/set-url', usersGate, requireAdmin, (req, res) => {
    const { url, target } = req.body || {};
    const raw = String(url || '').trim();
    if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(raw)) {
        return res.status(400).json({ error: 'Enter a full https:// URL' });
    }
    const host = raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
    const allowed = store.users.getAllowedHosts();
    if (allowed.length && !allowed.includes(host)) {
        return res.status(400).json({
            error: `"${host}" is not on the allowed hosts list, so every phone would `
                 + `refuse it. Add it under Allowed server hosts first.`
        });
    }

    // Same rule as the one-shot commands: a malformed target must not become
    // "every phone", which here would move the entire fleet to a new server.
    let who = null;
    if (target !== undefined && target !== null && target !== '' && target !== 'all') {
        who = store.users.slug(target);
        if (!who || !store.users.listUsers().some(u => u.id === who)) {
            return res.status(400).json({ error: 'Unknown target user. Omit it, or use "all".' });
        }
    }
    fcm.send('set_url', Date.now(), who ? 'user_' + who : undefined, { url: raw });
    console.warn(`[server] set_url pushed: ${raw} -> ${who || 'all devices'}`);
    res.json({
        success: true, url: raw, target: who || 'all',
        // Honest about what was actually achieved: FCM accepted a message.
        note: 'Pushed. Phones without Play Services, or force-stopped, will not '
            + 'receive this — change those by hand in the app.'
    });
});

// Force a re-read of config and identity from Firestore.
//
// The boot read retries on its own, but when a load has been failing you want to
// be able to say "try now" and watch, rather than wait out a backoff and wonder.
app.post('/api/reload', requireAdmin, asyncRoute(async (req, res) => {
    // Awaited: the flush inside must complete before we answer, or the dashboard
    // refreshes against a state the reload has not finished producing.
    await store.reloadDurable();
    res.json({ success: true });
}));

app.get('/api/devices', usersGate, requireAdmin, (req, res) => {
    res.json({ devices: store.users.listDevices() });
});

app.post('/api/devices/:id/assign', usersGate, requireAdmin, requireIdentityLoaded, (req, res) => {
    const { userId } = req.body || {};
    const r = store.users.assignDevice(req.params.id, userId === null ? null : userId);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ success: true, device: r.device });
});

app.post('/api/devices/:id/rename', usersGate, requireAdmin, requireIdentityLoaded, (req, res) => {
    const r = store.users.renameDevice(req.params.id, (req.body || {}).name);
    if (!r.ok) return res.status(404).json({ error: r.error });
    res.json({ success: true, device: r.device });
});

app.post('/api/devices/:id/remove', usersGate, requireAdmin, requireIdentityLoaded, (req, res) => {
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

app.post('/api/allowed-hosts', usersGate, requireAdmin, requireIdentityLoaded, (req, res) => {
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
    const { deviceId, model, name, claimedUser } = req.body || {};
    const device = store.users.registerDevice(deviceId, { model, name, claimedUser });
    if (device && device.error) return res.status(400).json({ error: device.error });
    res.json({
        success: true, usersEnabled: true,
        deviceId: device.id,
        assigned: !!device.userId,
        // The EFFECTIVE owner after precedence, not the raw assignment — this
        // is what the phone joins an FCM topic for.
        userId:   store.users.ownerOf(device.id) === store.users.ADMIN_ID
                      ? '' : store.users.ownerOf(device.id),
        claimStatus: store.users.claimStatus(device.id),
        allowedHosts: store.users.getAllowedHosts()
    });
});

// ═════════════════════════════════════════════════════════════════
// HISTORY (admin only)
// ═════════════════════════════════════════════════════════════════
//
// Admin only, by decision. The archive holds full SMS text.

function historyGate(req, res, next) {
    if (!history.enabled()) {
        return res.status(404).json({ error: 'History is not enabled' });
    }
    next();
}

app.get('/api/history', historyGate, requireAdmin, asyncRoute(async (req, res) => {
    const rows = await firestore.queryHistory(history.COLLECTION, {
        userId: req.query.userId || null,
        from:   req.query.from   || null,
        to:     req.query.to     || null,
        limit:  req.query.limit  || 200
    });
    res.json({ messages: rows, stats: history.stats() });
}));

/**
 * Daily counts by outcome, for the activity strip.
 *
 * Computed from the same rows rather than a separate aggregate collection: at
 * 5-10 users the volume does not justify one, and an aggregate that can drift
 * out of step with the data it summarises is a bug waiting to happen.
 */
app.get('/api/history/summary', historyGate, requireAdmin, asyncRoute(async (req, res) => {
    const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 30));
    const from = Date.now() - days * 86400_000;
    // Firestore caps what one query returns, so this is a sample, not a census
    // — and it was being presented as totals. Say so rather than quietly
    // understating a busy month.
    const LIMIT = 500;
    const rows = await firestore.queryHistory(history.COLLECTION, { from, limit: LIMIT });

    const byDay = {};
    for (const r of rows) {
        const day = new Date(r.receivedAt).toISOString().slice(0, 10);
        if (!byDay[day]) byDay[day] = { day, total: 0, fetched: 0, expired: 0, superseded: 0, no_code: 0 };
        byDay[day].total++;
        if (byDay[day][r.outcome] !== undefined) byDay[day][r.outcome]++;
    }
    const totals = rows.reduce((a, r) => {
        a.total++; if (a[r.outcome] !== undefined) a[r.outcome]++; return a;
    }, { total: 0, fetched: 0, expired: 0, superseded: 0, no_code: 0 });

    res.json({
        days: Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)),
        totals,
        truncated: rows.length >= LIMIT,
        limit: LIMIT,
        // The one number that is this system's health: of the codes it managed
        // to extract, how many were actually used.
        fetchRate: totals.total ? Math.round((totals.fetched / totals.total) * 100) : null
    });
}));

app.post('/api/history/delete', historyGate, requireAdmin, asyncRoute(async (req, res) => {
    const { ids, olderThanDays } = req.body || {};
    if (Array.isArray(ids) && ids.length) {
        const n = await firestore.deleteHistory(history.COLLECTION, ids.map(String));
        return res.json({ success: true, deleted: n });
    }
    if (olderThanDays !== undefined) {
        const days = parseInt(olderThanDays, 10);
        if (!(days >= 0)) return res.status(400).json({ error: 'olderThanDays must be a number' });
        const n = await firestore.deleteHistoryBefore(history.COLLECTION,
            Date.now() - days * 86400_000);
        return res.json({ success: true, deleted: n });
    }
    res.status(400).json({ error: 'Give ids or olderThanDays' });
}));

// Full settings (for dashboard settings panel)
// Scoped by role. This returned identity.userList — every user id and name —
// and every user's override, to ANY signed-in caller, while /api/users was
// admin-only. An inconsistent boundary is a boundary with a hole in it.
app.get('/api/full-settings', requireToken, (req, res) => {
    const isAdmin = req.session.role === 'admin';
    // fcm included so "is push actually reaching my phones?" is answerable.
    // send() is fire-and-forget by design, so without this a broken service
    // account is completely silent — the dashboard toggle still returns 200 and
    // the device just never hears about it.
    // config included so "which source are these filters from, and did my last
    // save actually reach the cloud?" is answerable without reading the logs.
    const settings = store.getSettings();
    if (!isAdmin) { delete settings.filters; }
    res.json(Object.assign(settings, {
        fcm:     isAdmin ? fcm.getStatus() : null,
        config:  isAdmin ? store.configStatus() : null,
        history: isAdmin ? history.stats() : null,
        identity: !store.usersEnabled() ? null : (isAdmin
            ? Object.assign(store.users.stats(), { overrides: store.listOverrides(),
                                                   overrideCeiling: store.overrideCeilingMinutes() })
            // A user needs exactly two things from here: how long an override may
            // run, and whether THEIRS is running. Not the roster.
            : { overrideCeiling: store.overrideCeilingMinutes(),
                overrides: store.overrideRemaining(req.session.userId) > 0
                    ? { [req.session.userId]: { remainingMs: store.overrideRemaining(req.session.userId) } }
                    : {} }),
        me: { userId: req.session.userId, role: req.session.role }
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
// ABOVE the static handler, despite what the note above says about mounting
// static last. A file called public/health would otherwise shadow the keepalive
// endpoint — harmless today, and a genuinely confusing outage the day someone
// adds one. /health is one comparison; the ordering argument was about the
// filesystem stat that /sms and /get would pay for, and this route is neither.
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() | 0 });
});

app.use(express.static(path.join(__dirname, 'public')));


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
