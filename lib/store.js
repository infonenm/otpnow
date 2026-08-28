/**
 * lib/store.js — In-memory SMS + settings store
 *
 * Replaces Firebase RTDB entirely. All data lives in server memory.
 * - SMS auto-delete after configurable minutes
 * - Settings initialized from env vars, modifiable at runtime
 * - SSE broadcast to connected dashboard clients
 *
 * Trade-off: data is lost on server restart. Acceptable because:
 * - OTPs are consumed on fetch and auto-delete in 10-30 min
 * - Settings fall back to env var defaults on restart
 * - Android app's SQLite queue retries if server was briefly down
 */

const crypto = require('crypto');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { extractCode, clearPatternCache } = require('./otp');

// ─── Phone number canonicalization ──────────────────────────────
// Lives in lib/phone.js, which carries the spec and has a twin in the Android
// app (PhoneUtils.java). Keeping the rules in one place here means the server's
// store path and fetch path cannot drift apart from each other, and the vector
// table in test/phone.test.js is what keeps them from drifting away from the app.
const { canonicalizePhone } = require('./phone');

// ─── SMS store ──────────────────────────────────────────────────
const smsMap    = new Map();   // id → smsObject           (insertion-ordered)
const numberMap = new Map();   // recipient → { otp, smsKey, ts, consumed }

// recipient → Set<id>. A secondary index over smsMap, nothing more.
//
// WHY: two hot paths needed "every message for this recipient" and both got it
// by walking the ENTIRE map — the supersede loop in addSms (once per incoming
// SMS) and the fallback scan in getOtp (once per fetch). With a 30-minute
// retention that is O(total messages) per message, i.e. quadratic across a
// burst, which is exactly when the OTP has to be fast.
//
// smsMap remains the single source of truth. This index is derived, and there
// are only THREE places that may mutate it — addSms, removeSms and clearAll.
// test/store.test.js re-derives it by brute force after a randomised workload
// and asserts they match, because a silently drifted index would mean an OTP
// that never supersedes the previous one.
const byRecipient = new Map();

/** Hard ceiling on retained messages. See the eviction note in addSms. */
const MAX_MESSAGES = 5000;

function indexAdd(sms) {
    let ids = byRecipient.get(sms.recipient);
    if (!ids) { ids = new Set(); byRecipient.set(sms.recipient, ids); }
    ids.add(sms.id);
}

function indexRemove(sms) {
    const ids = byRecipient.get(sms.recipient);
    if (!ids) return;
    ids.delete(sms.id);
    if (ids.size === 0) byRecipient.delete(sms.recipient);   // don't leak empty sets
}

/** Every live message for one recipient. Empty array when there are none. */
function messagesFor(recipient) {
    const ids = byRecipient.get(recipient);
    if (!ids) return [];
    const out = [];
    for (const id of ids) {
        const sms = smsMap.get(id);
        if (sms) out.push(sms);
    }
    return out;
}

/**
 * The ONE removal path — index, numberMap and the SSE broadcast all in step.
 * The auto-delete sweep and the size cap both go through here so they cannot
 * drift apart from each other, which is how the index would rot.
 */
function removeSms(id, sms) {
    smsMap.delete(id);
    indexRemove(sms);
    const entry = numberMap.get(sms.recipient);
    if (entry && entry.smsKey === id) numberMap.delete(sms.recipient);
    broadcast('sms_delete', { id });
}

// ─── Settings ───────────────────────────────────────────────────
//
// globalForwarding IS PERSISTED. Everything else here can safely fall back to
// its env default after a restart; this one cannot.
//
// It used to be a hardcoded `true`. Since the app converges on the dashboard
// level, that meant: switch forwarding OFF, Render restarts for any reason, the
// setting silently comes back as ON, and every device turns itself back on
// within 30 seconds. An off switch that undoes itself is worse than no off
// switch, because you believe it worked.
//
// Two layers, because neither is sufficient alone on Render's free tier:
//   1. A state file. Survives a process restart or an OOM kill — the common
//      case. Does NOT survive a redeploy or a spin-down, which start from a
//      fresh container.
//   2. FORWARDING_DEFAULT env var. Survives everything, because Render sets it
//      on every boot. This is the one to use if you want a device fleet that
//      comes up OFF by default.
const STATE_FILE = process.env.STATE_FILE || path.join(os.tmpdir(), 'getotp-state.json');

function envDefaultForwarding() {
    const raw = (process.env.FORWARDING_DEFAULT || 'on').trim().toLowerCase();
    return !(raw === 'off' || raw === 'false' || raw === '0' || raw === 'no');
}

function readState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
    } catch (e) {
        return {};   // no file on first boot or after a redeploy — not an error
    }
}

const persisted = readState();

function loadPersistedForwarding() {
    if (typeof persisted.globalForwarding === 'boolean') {
        console.log(`[store] Restored globalForwarding=${persisted.globalForwarding}`);
        return persisted.globalForwarding;
    }
    const fromEnv = envDefaultForwarding();
    console.log(`[store] globalForwarding=${fromEnv} (from FORWARDING_DEFAULT)`);
    return fromEnv;
}

/**
 * FILTERS ARE PERSISTED TOO, and that matters more than it looks.
 *
 * They used to fall back to OTP_PATTERNS on every restart — which means the
 * catch-all default `(\d{4,8})`. That default matches almost any SMS, and since
 * a message with an extractable code SUPERSEDES the live OTP, a promotional SMS
 * arriving in the fetch window would quietly replace a real OTP with whatever
 * digits it happened to contain.
 *
 * Sender-specific rules are the fix for that, and they are only a fix if they
 * survive a restart. So they live in the state file with the on/off switch.
 */
function loadPersistedFilters() {
    if (Array.isArray(persisted.filters) && persisted.filters.length > 0) {
        console.log(`[store] Restored ${persisted.filters.length} filter rule(s)`);
        return persisted.filters;
    }
    return parseFiltersEnv();
}

function loadPersistedAutoDelete() {
    const v = parseInt(persisted.autoDeleteMinutes, 10);
    if (v > 0) return Math.max(1, Math.min(1440, v));
    return parseInt(process.env.AUTO_DELETE_MINUTES || '30', 10) || 30;
}

/** One writer for the whole state file — a partial write would lose the rest. */
function persistState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({
            globalForwarding:  settings.globalForwarding,
            filters:           settings.filters,
            autoDeleteMinutes: settings.autoDeleteMinutes
        }));
    } catch (e) {
        // Best effort. A read-only or full filesystem must not break the toggle
        // itself — the env defaults still cover the restart case.
        console.warn(`[store] Could not persist state: ${e.message}`);
    }
}

const settings = {
    globalForwarding:  loadPersistedForwarding(),
    clearLogTs:        0,
    testMessageTs:     0,
    fetchLatestTs:     0,
    autoDeleteMinutes: loadPersistedAutoDelete(),
    filters:           loadPersistedFilters()
};

function parseFiltersEnv() {
    const raw = process.env.OTP_PATTERNS || '(\\d{4,8})';
    // Support JSON array format or simple pipe-separated patterns
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
    } catch (e) { /* not JSON, treat as pipe-separated */ }
    return [{ phoneNumber: 'DEFAULT', patterns: raw.split('|').map(p => p.trim()).filter(Boolean) }];
}

// ─── SSE clients ────────────────────────────────────────────────
const sseClients = new Set();

function addSSEClient(res) {
    res.writeHead(200, {
        'Content-Type':      'text/event-stream',
        'Cache-Control':     'no-cache',
        'Connection':        'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    // Send initial heartbeat
    res.write(': connected\n\n');
    sseClients.add(res);
    res.on('close', () => sseClients.delete(res));
}

function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        try { client.write(msg); } catch (e) { sseClients.delete(client); }
    }
}

// Keep SSE connections alive with heartbeat every 30s
setInterval(() => {
    for (const client of sseClients) {
        try { client.write(': heartbeat\n\n'); } catch (e) { sseClients.delete(client); }
    }
}, 30_000);

// ─── Auth (STATELESS — survives server restarts) ────────────────
// Token = HMAC(password, secret). Same password always produces the
// same token. Server validates by recomputing — no Map to lose on restart.
/**
 * Constant-time string comparison.
 *
 * The plain !== that used to be here leaked, in principle, how many leading
 * characters of a guess were correct. On its own that is a weak signal over the
 * internet — but it costs nothing to remove, and it pairs with the failure
 * back-off in server.js, which is the control that actually matters.
 */
function safeEqual(a, b) {
    const ba = Buffer.from(String(a), 'utf8');
    const bb = Buffer.from(String(b), 'utf8');
    // Compare a fixed-size digest so differing lengths cannot throw or short-circuit.
    const da = crypto.createHash('sha256').update(ba).digest();
    const db = crypto.createHash('sha256').update(bb).digest();
    return crypto.timingSafeEqual(da, db);
}

/**
 * Session tokens.
 *
 * =============================================================================
 * WHY THESE ARE NOW RANDOM AND EXPIRING, NOT AN HMAC OF THE PASSWORD
 *
 * The old token was HMAC(API_KEY, DASHBOARD_PASSWORD) — the same string forever.
 * Three consequences, all bad:
 *   - it never expired, so one leak was permanent;
 *   - it could not be revoked without changing the password;
 *   - it was DERIVED from the password, so anyone holding a token held a
 *     verifier for the password itself.
 *
 * Now: 32 random bytes, kept server-side with an expiry, revocable. A stolen
 * token is useless after TTL and can be killed immediately by logging out. The
 * password is never an input to the token.
 *
 * In-memory, so a redeploy logs you out. That is the correct trade for a
 * single-operator dashboard: the alternative is persisting credentials to disk
 * on a free-tier host to save one login.
 * =============================================================================
 */
const TOKEN_TTL_MS = Math.max(
    5, Math.min(43200, parseInt(process.env.SESSION_TTL_MINUTES || '720', 10) || 720)
) * 60 * 1000;

const sessions = new Map();   // token -> expiresAt

function pruneSessions() {
    const now = Date.now();
    for (const [t, exp] of sessions) if (exp <= now) sessions.delete(t);
}

function login(password) {
    const expected = process.env.DASHBOARD_PASSWORD || '';
    if (!expected) return null;
    if (typeof password !== 'string' || !safeEqual(password, expected)) return null;

    pruneSessions();
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + TOKEN_TTL_MS);
    return token;
}

/** Logout, and it means it — the token stops working server-side. */
function revokeToken(token) {
    return token ? sessions.delete(token) : false;
}

function validateToken(token) {
    if (!token || typeof token !== 'string') return false;
    const exp = sessions.get(token);
    if (!exp) return false;
    if (exp <= Date.now()) { sessions.delete(token); return false; }
    return true;
}

// ─── SMS operations ─────────────────────────────────────────────

function addSms(sender, recipient, message, arrivedAt) {
    // Same reason as extractCode: a JSON body can carry any type. Normalise at
    // the boundary so nothing downstream has to defend itself.
    sender    = sender    == null ? '' : String(sender);
    recipient = recipient == null ? '' : String(recipient);
    message   = message   == null ? '' : String(message);

    const id        = crypto.randomBytes(8).toString('hex');
    const serverNow = Date.now();                              // FIX #2: always use server time for timing
    const normRecip = canonicalizePhone(recipient || 'Unknown'); // FIX #3: normalize recipient
    const code      = extractCode(message, sender, normRecip, settings.filters);
    const deleteAt  = serverNow + settings.autoDeleteMinutes * 60_000;  // FIX #2: deleteAt based on server clock

    // TWO TIMESTAMPS, AND THE DISTINCTION IS LOAD-BEARING:
    //
    //   receivedAt  when THIS server received it. Server clock, always sane,
    //               monotonic across devices. Everything that decides anything
    //               — expiry, ordering, the dashboard's countdown bar — uses it.
    //
    //   arrivedAt   when the DEVICE says the SMS landed. Device clock, so it can
    //               be skewed by hours, and for a message replayed off the app's
    //               retry queue it is legitimately much older than receivedAt.
    //               Display only. Never used for a decision.
    //
    // Previously there was one field carrying both meanings, so a skewed phone
    // clock reordered the dashboard and a queued replay drew an expiry bar wider
    // than 100%. The retry path also had to lie (sending "now" for an old
    // message) to avoid that, which destroyed the one piece of information the
    // field was there to carry.
    const deviceArrivedAt = Number(arrivedAt) > 0 ? Number(arrivedAt) : serverNow;

    const sms = {
        id, sender, recipient: normRecip, message,
        code:           code || '',
        extractedCode:  code || null,
        receivedAt:     serverNow,        // authoritative — server clock
        arrivedAt:      deviceArrivedAt,  // informational — device clock
        deleteAt,
        status:         'pending',
        viewedAt:       null
    };

    smsMap.set(id, sms);
    indexAdd(sms);
    enforceSizeCap();

    if (code) {
        // SUPERSEDE: kill ALL previous pending OTPs for this recipient instantly.
        // Indexed — this now touches only this recipient's messages (normally
        // one or zero) instead of walking every message on the server.
        for (const oldSms of messagesFor(normRecip)) {
            if (oldSms.id !== id && oldSms.status === 'pending') {
                oldSms.status = 'superseded';
                broadcast('sms_update', oldSms);
            }
        }

        // Replace the fast-lookup entry — use SERVER time for ts (FIX #2)
        numberMap.set(normRecip, { otp: code, smsKey: id, ts: serverNow, consumed: false });
    }

    broadcast('sms_new', sms);
    console.log(`[store] ${id} from=${sender} to=${normRecip} code=${code || '(none)'}`);

    // LAST, and only with a code: everything above must be committed before a
    // parked fetch is allowed to consume it. This is the step that removes the
    // polling interval from the end-to-end latency.
    if (code) notifyWaiters(normRecip);

    return { id, code };
}

// ─── Long-poll waiters ──────────────────────────────────────────
//
// THE LATENCY PROBLEM THIS SOLVES:
//
// Everything from "SMS lands on the phone" to "the OTP is in this server's
// memory" takes a few hundred milliseconds. Then the fetching script asks for
// it — and if it asks on a timer, the WAIT FOR THE NEXT TICK is by far the
// largest delay in the whole system. A script polling once a second adds 500 ms
// on average and up to 1000 ms, which is more than every other step combined.
//
// A waiter is a request that is already parked here when the SMS arrives.
// addSms wakes it immediately, so the OTP goes out on the connection that is
// already open: no extra round trip, no polling interval, no wasted requests.
//
// recipient → Set<{ resolve }>. Bounded, because an unbounded map of parked
// requests is a memory leak with a friendly name.
const waiters = new Map();
const MAX_WAITERS = 200;
let waiterCount = 0;

/**
 * Park until an OTP is available for this number, or the deadline passes.
 *
 * Resolution goes through getOtp(), so a long-poll consumes exactly the same
 * way a plain fetch does — consume-on-read, supersede and the dashboard update
 * all behave identically. Two waiters on one number cannot both win: the first
 * to run consumes it and the second keeps waiting.
 *
 * @returns {Promise<string|null>} the OTP, or null on timeout.
 */
function waitForOtp(number, timeoutMs, onCancel, senderTokens) {
    const normNumber = canonicalizePhone(number);

    return new Promise((resolve) => {
        if (waiterCount >= MAX_WAITERS) {
            // Refuse to park rather than grow without bound. The caller falls
            // back to returning "no OTP", which is what a plain fetch does.
            console.warn(`[store] waiter limit (${MAX_WAITERS}) reached — not parking`);
            return resolve(null);
        }

        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            remove();
            resolve(value);
        };

        const entry = {
            wake: () => {
                // Re-check through the real path. A waiter wakes only when a
                // new SMS has just landed, so this normally returns it — but
                // going through getOtp keeps expiry, supersede and sender
                // scoping in one place. A waiter scoped to another gateway
                // simply keeps waiting.
                const otp = getOtp(normNumber, senderTokens);
                if (otp) finish(otp);
            }
        };

        function remove() {
            const set = waiters.get(normNumber);
            if (!set) return;
            if (set.delete(entry)) waiterCount--;
            if (set.size === 0) waiters.delete(normNumber);
        }

        let set = waiters.get(normNumber);
        if (!set) { set = new Set(); waiters.set(normNumber, set); }
        set.add(entry);
        waiterCount++;

        const timer = setTimeout(() => finish(null), timeoutMs);
        // The client hanging up must free the slot immediately, not at timeout.
        if (typeof onCancel === 'function') onCancel(() => finish(null));
    });
}

/** Wake everyone parked on this number. Called from addSms. */
function notifyWaiters(recipient) {
    const set = waiters.get(recipient);
    if (!set || set.size === 0) return;
    // Copy: wake() consumes and mutates the set through remove().
    for (const entry of Array.from(set)) entry.wake();
}

/**
 * Memory guardrail, not a retention policy.
 *
 * Retention is `autoDeleteMinutes` and that is what normally bounds the store.
 * This only matters if something abnormal happens — a flood, a device stuck in
 * a resend loop — on a 512 MB free instance where running out of memory takes
 * the whole service down and loses EVERYTHING, including the settings. Evicting
 * the oldest few is strictly better than that, and at any realistic volume this
 * never fires. It logs loudly when it does, because it firing means something
 * upstream is wrong.
 */
let capWarnedAt = 0;
const CAP_WARN_INTERVAL_MS = 60_000;

function enforceSizeCap() {
    if (smsMap.size <= MAX_MESSAGES) return;
    let evicted = 0;
    // Map iterates in insertion order, so the front is the oldest.
    for (const [id, sms] of smsMap) {
        if (smsMap.size <= MAX_MESSAGES) break;
        removeSms(id, sms);
        evicted++;
    }
    // Throttled: once the cap is reached EVERY subsequent message evicts one,
    // so an unthrottled warning here would itself become the flood.
    const now = Date.now();
    if (now - capWarnedAt >= CAP_WARN_INTERVAL_MS) {
        capWarnedAt = now;
        console.warn(`[store] SIZE CAP HIT — evicting oldest to hold ${MAX_MESSAGES} ` +
                     `messages. Check for a device resending in a loop.`);
    }
}

/**
 * How long an OTP stays live if nobody fetches it.
 *
 * =============================================================================
 * AN OTP IS RETIRED BY A SUCCESSFUL FETCH, BY A NEWER ONE, OR BY THIS CLOCK.
 *
 * Consume-on-read is deliberate and is the owner's rule: once a fetch has
 * actually returned the code, it is spent. This window is the backstop for the
 * case where nobody fetches it at all, so a code that was never used cannot sit
 * there waiting to be handed to a request whose own SMS has not landed yet.
 *
 * I removed this once, reading "the latest OTP will always work" as "repeat
 * reads must keep working". It means supersede: a newer SMS instantly replaces
 * an older one. Both rules are enforced below; do not conflate them again.
 *
 * The one hazard consume-on-read creates is a fetch that consumes the code and
 * then fails to deliver it — a long-poll whose client hung up mid-answer. That
 * is what unconsume() exists for; without it a dropped connection would eat an
 * OTP with no way to get it back.
 * =============================================================================
 */
const MAX_OTP_AGE_MS = Math.max(
    5, Math.min(600, parseInt(process.env.OTP_MAX_AGE_SECONDS || '120', 10) || 120)
) * 1000;

/**
 * Does this SMS sender match any of the tokens a gateway alias is scoped to?
 * Same normalisation as the filter matcher in otp.js, so "bKash", "bkash" and
 * "BKASH-16247" all match the token "bkash".
 */
function senderMatches(sender, tokens) {
    if (!tokens || tokens.length === 0) return true;      // unscoped: any sender
    const norm = String(sender || '').toUpperCase().replace(/[\s_-]/g, '');
    return tokens.some(t => {
        const n = String(t).toUpperCase().replace(/[\s_-]/g, '');
        return n !== '' && norm.includes(n);
    });
}

/**
 * @param {string}   number       recipient, any format
 * @param {string[]} [senderTokens] when given, only an OTP from a matching
 *                   sender is returned — and a non-matching one is NOT
 *                   consumed, so scoping a gateway alias can never eat the
 *                   OTP another gateway is waiting for.
 */
function getOtp(number, senderTokens) {
    // FIX #3: normalize the lookup number so +880/880/01 all match
    const normNumber = canonicalizePhone(number);

    // Fast path: check numberMap
    const entry = numberMap.get(normNumber);
    if (entry && entry.otp) {
        // The ONLY reason to stop serving it: it aged out. A newer SMS would
        // have replaced this entry outright, so whatever is here is the latest.
        if (Date.now() - (entry.ts || 0) > MAX_OTP_AGE_MS) {
            numberMap.delete(normNumber);
            return null;
        }

        // Already fetched once — spent.
        if (entry.consumed) return null;

        // Wrong sender for this gateway: leave it alone, untouched and unspent.
        if (senderTokens && entry.smsKey && smsMap.has(entry.smsKey)
                && !senderMatches(smsMap.get(entry.smsKey).sender, senderTokens)) {
            return null;
        }

        // CONSUME. From here the caller owns this code; if it cannot actually
        // deliver it, it must call unconsume().
        entry.consumed = true;
        if (entry.smsKey && smsMap.has(entry.smsKey)) {
            const sms  = smsMap.get(entry.smsKey);
            sms.status   = 'used';
            sms.viewedAt = Date.now();
            broadcast('sms_update', sms);
        }
        return String(entry.otp);
    }

    // Fallback: this recipient's UNFETCHED messages. Reached only when numberMap
    // has no entry for the number at all.
    const candidates = messagesFor(normNumber)
        .filter(sms => sms.status === 'pending' && senderMatches(sms.sender, senderTokens));
    candidates.sort((a, b) => b.receivedAt - a.receivedAt);

    for (const sms of candidates) {
        // receivedAt, not arrivedAt: the fast path above expires on server time,
        // and this fallback used device time, so the same message could be live
        // on one path and expired on the other depending on the phone's clock.
        if (Date.now() - sms.receivedAt > MAX_OTP_AGE_MS) continue;
        const code = sms.extractedCode || extractCode(sms.message, sms.sender, sms.recipient, settings.filters);
        if (!code) continue;

        // Consume: mark used, and record it as already-spent so a second fetch
        // takes the fast path above and correctly gets nothing.
        sms.status   = 'used';
        sms.viewedAt = Date.now();
        numberMap.set(normNumber, { otp: code, smsKey: sms.id, ts: sms.receivedAt, consumed: true });
        broadcast('sms_update', sms);
        return String(code);
    }

    return null;
}

/**
 * Put a consumed OTP back, because the fetch that took it never delivered it.
 *
 * =============================================================================
 * WHY THIS IS NEEDED THE MOMENT CONSUME-ON-READ EXISTS
 *
 * getOtp() marks the code spent the instant it returns it. For a plain fetch
 * that is fine — returning and delivering are the same act. For a LONG-POLL
 * they are not: the request may have been parked for twenty seconds, and the
 * client can hang up in the moment between the OTP being handed over and the
 * response being written. Without this, that code is gone: consumed, never
 * received, and unrecoverable, with the SMS showing "Used" on the dashboard.
 *
 * Strictly conditional — it only restores the SAME code, still the current one
 * for that number, still inside its window. It can never resurrect a code that
 * has been superseded or has aged out, so it cannot be used to serve something
 * stale.
 *
 * @returns {boolean} true if the OTP was restored
 */
function unconsume(number, otp) {
    const normNumber = canonicalizePhone(number);
    const entry = numberMap.get(normNumber);

    if (!entry || !entry.consumed) return false;
    if (String(entry.otp) !== String(otp)) return false;          // superseded meanwhile
    if (Date.now() - (entry.ts || 0) > MAX_OTP_AGE_MS) return false;   // aged out anyway

    entry.consumed = false;
    if (entry.smsKey && smsMap.has(entry.smsKey)) {
        const sms = smsMap.get(entry.smsKey);
        if (sms.status === 'used') {
            sms.status   = 'pending';
            sms.viewedAt = null;
            broadcast('sms_update', sms);
        }
    }
    console.log(`[store] Returned unfetched OTP for ${normNumber} — client disconnected`);
    return true;
}

function getAllSms() {
    // Server clock: one device with a wrong clock must not be able to push its
    // messages to the top (or bottom) of everyone else's dashboard.
    return Array.from(smsMap.values()).sort((a, b) => b.receivedAt - a.receivedAt);
}

function clearAll() {
    smsMap.clear();
    numberMap.clear();
    byRecipient.clear();
    broadcast('clear_all', {});
    console.log('[store] All SMS cleared');
}

// ─── Settings operations ────────────────────────────────────────

function getSettings() {
    return {
        globalForwarding:  settings.globalForwarding,
        clearLogTs:        settings.clearLogTs,
        testMessageTs:     settings.testMessageTs,
        fetchLatestTs:     settings.fetchLatestTs,
        autoDeleteMinutes: settings.autoDeleteMinutes,
        filters:           settings.filters
    };
}

function setGlobalForwarding(enabled) {
    settings.globalForwarding = !!enabled;
    persistState();
    broadcast('settings_change', { key: 'globalForwarding', value: settings.globalForwarding });
    console.log(`[store] globalForwarding = ${settings.globalForwarding}`);
}

function triggerClearLog(ts) {
    settings.clearLogTs = ts || Date.now();
    broadcast('settings_change', { key: 'clearLogTs', value: settings.clearLogTs });
}

function triggerTestMessage(ts) {
    settings.testMessageTs = ts || Date.now();
    broadcast('settings_change', { key: 'testMessageTs', value: settings.testMessageTs });
}

/**
 * Ask the device to fetch and forward its most recent SMS.
 *
 * The recovery the system did not have: every other path assumes the app SAW the
 * message. If the phone was force-stopped when it arrived, the app never got the
 * broadcast, so the queue and the forward log are both empty and nothing on this
 * server will ever hear about it. Only the phone's own SMS provider still has it.
 *
 * A one-shot like the others: a timestamp the device claims exactly once,
 * carried by both FCM and the poller.
 */
function triggerFetchLatest(ts) {
    settings.fetchLatestTs = ts || Date.now();
    broadcast('settings_change', { key: 'fetchLatestTs', value: settings.fetchLatestTs });
    return settings.fetchLatestTs;
}

function setAutoDeleteMinutes(mins) {
    settings.autoDeleteMinutes = Math.max(1, Math.min(1440, parseInt(mins, 10) || 30));
    persistState();
    broadcast('settings_change', { key: 'autoDeleteMinutes', value: settings.autoDeleteMinutes });
}

function setFilters(filters) {
    if (Array.isArray(filters)) {
        settings.filters = filters;
        persistState();
        // Drop compiled regexes for the old rule set — otherwise a pattern the
        // operator just deleted would sit in the cache for the process lifetime.
        clearPatternCache();
        broadcast('settings_change', { key: 'filters', value: settings.filters });
        console.log(`[store] Filters updated: ${filters.length} rule(s)`);
    }
}

// ─── Auto-delete expired SMS ────────────────────────────────────
setInterval(() => {
    if (smsMap.size === 0) return;
    const now     = Date.now();
    let   deleted = 0;
    for (const [id, sms] of smsMap) {
        if (now >= sms.deleteAt) {
            removeSms(id, sms);
            deleted++;
        }
    }
    if (deleted > 0) console.log(`[store] Auto-deleted ${deleted} expired message(s)`);
}, 60_000);

// ─── Exports ────────────────────────────────────────────────────
module.exports = {
    addSms, getOtp, getAllSms, clearAll, waitForOtp, unconsume, senderMatches,
    revokeToken,
    triggerFetchLatest,
    isForwardingEnabled: () => settings.globalForwarding,
    // Test-only surface. Nothing in server.js touches these; they exist so
    // test/store.test.js can re-derive the index by brute force and compare.
    _internals: { smsMap, byRecipient, numberMap, MAX_MESSAGES },
    getSettings, setGlobalForwarding, triggerClearLog, triggerTestMessage,
    setAutoDeleteMinutes, setFilters,
    addSSEClient, login, validateToken,
    canonicalizePhone
};
