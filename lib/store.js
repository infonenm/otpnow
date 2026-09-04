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
const { extractCode, clearPatternCache, validatePattern } = require('./otp');

// ─── Phone number canonicalization ──────────────────────────────
// Lives in lib/phone.js, which carries the spec and has a twin in the Android
// app (PhoneUtils.java). Keeping the rules in one place here means the server's
// store path and fetch path cannot drift apart from each other, and the vector
// table in test/phone.test.js is what keeps them from drifting away from the app.
const { canonicalizePhone } = require('./phone');
const firestore = require('./firestore');
const users     = require('./users');
const history   = require('./history');

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
    // userId included so the stream can be scoped — a delete for someone
    // else's message must not reach this user either.
    broadcast('sms_delete', { id, userId: sms.userId }, { userId: sms.userId });
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
        // No file on first boot or after a redeploy — not an error, say nothing.
        if (e.code === 'ENOENT') return {};
        // Anything else means the file EXISTS and could not be used, which
        // silently reverts forwarding to FORWARDING_DEFAULT and the filters to
        // the catch-all. That is bugs #10 and #11 coming back through a side
        // door, and it used to happen without a single line in the log.
        console.error(`[store] STATE FILE UNUSABLE (${e.message}) — falling back to `
            + `env defaults. globalForwarding reverts to FORWARDING_DEFAULT and the `
            + `filters revert to OTP_PATTERNS (the catch-all). Re-save your filters `
            + `on the dashboard.`);
        return {};
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
        return sanitizeFilters(persisted.filters, 'state file');
    }
    return sanitizeFilters(parseFiltersEnv(), 'OTP_PATTERNS');
}

/**
 * Drop patterns that can never match, LOUDLY, at load time.
 *
 * =============================================================================
 * POST /api/filters REFUSES THESE. NOTHING CHECKED THE OTHER TWO DOORS.
 *
 * A pattern is unusable if it is double-escaped (`(\\d{4,8})` — a literal
 * backslash followed by four to eight letter d), if it has no capture group
 * (extractCode reads match[1]), or if it simply does not compile. The dashboard
 * route rejects all three when you save. But filters also arrive from the state
 * file and from OTP_PATTERNS, and neither was ever checked — so the guard
 * covered the one door where you would notice the mistake anyway and left the
 * two where you would not.
 *
 * Note in particular that parseFiltersEnv() splits a non-JSON OTP_PATTERNS on
 * "|", which also splits any regex ALTERNATION into two broken halves. That
 * used to produce patterns that compiled to nothing and were cached as null in
 * silence. Now it says so.
 *
 * WHAT IT DOES, AND WHY EACH CHOICE:
 *   - a bad pattern is dropped. It matched nothing before, so removing it
 *     changes no behaviour — it only makes the situation visible.
 *   - a rule left with NO usable pattern is dropped ENTIRELY. This one IS a
 *     behaviour change, and it is strictly an improvement: a sender rule does
 *     not fall back to DEFAULT, so a rule that claims a sender and matches
 *     nothing loses every OTP from it. Dropping the rule lets DEFAULT run.
 *   - nothing is written back to disk. Your saved configuration is yours; this
 *     only decides what actually runs, and the dashboard shows what runs.
 * =============================================================================
 */
function sanitizeFilters(rules, source) {
    if (!Array.isArray(rules)) return [];
    const out = [];

    for (const rule of rules) {
        if (!rule || typeof rule !== 'object') continue;
        const label = rule.phoneNumber == null ? '(unnamed)' : String(rule.phoneNumber);
        const kept = [];

        for (const p of (Array.isArray(rule.patterns) ? rule.patterns : [])) {
            const why = validatePattern(p);
            if (why) {
                console.error(`[store] ${source}: dropping unusable pattern for `
                    + `${label} — ${why} — got ${JSON.stringify(p)}`);
                continue;
            }
            kept.push(p);
        }

        if (kept.length === 0) {
            console.error(`[store] ${source}: dropping rule ${label} entirely — no usable `
                + `pattern left. `
                + (label === 'DEFAULT'
                    ? `DEFAULT is the fallback for every unmatched sender, so nothing will `
                      + `be extracted from them until this is fixed.`
                    : `A sender rule does not fall back to DEFAULT, so leaving it would lose `
                      + `every OTP from that sender; dropping it lets DEFAULT run.`));
            continue;
        }
        out.push(Object.assign({}, rule, { patterns: kept }));
    }

    if (out.length === 0) {
        console.error(`[store] ${source}: NO USABLE FILTER RULES — no OTP will be `
            + `extracted from any message until this is fixed on the dashboard.`);
    }
    return out;
}

function loadPersistedAutoDelete() {
    const v = parseInt(persisted.autoDeleteMinutes, 10);
    if (v > 0) return Math.max(1, Math.min(1440, v));
    return parseInt(process.env.AUTO_DELETE_MINUTES || '30', 10) || 30;
}

/**
 * One writer for the whole state file — a partial write would lose the rest.
 *
 * =============================================================================
 * WRITE TO A TEMP FILE AND RENAME. NEVER WRITE THE REAL FILE IN PLACE.
 *
 * writeFileSync truncates first and then writes. A crash, an OOM kill or a
 * container stop in the window between those two leaves a TRUNCATED file — and
 * readState() catches the parse error and returns {}, which silently restores
 * FORWARDING_DEFAULT and, worse, the catch-all filter. That is exactly the pair
 * of bugs this file was added to fix, reappearing in the one situation the file
 * exists for.
 *
 * rename(2) within a filesystem is atomic: a reader sees either the whole old
 * file or the whole new one, never a half-written one. The temp file sits
 * beside the real one so it is always the same filesystem.
 * =============================================================================
 */
function persistState() {
    const tmp = STATE_FILE + '.tmp';

    // The running config is no longer whatever it was at boot — the operator
    // just set it. Without this the dashboard kept showing "running on env
    // defaults" in red after a successful save, because configSource was only
    // ever written at startup and by a Firestore load. Alarming, and wrong: the
    // catch-all warning is the one message that must never cry wolf, or it stops
    // being read on the day it is true.
    configSource = 'dashboard';

    try {
        fs.writeFileSync(tmp, JSON.stringify({
            globalForwarding:  settings.globalForwarding,
            filters:           settings.filters,
            autoDeleteMinutes: settings.autoDeleteMinutes
        }));
        fs.renameSync(tmp, STATE_FILE);
    } catch (e) {
        // Best effort. A read-only or full filesystem must not break the toggle
        // itself — the env defaults still cover the restart case. Clean up the
        // temp file so a later successful write is not confused by it.
        console.warn(`[store] Could not persist state: ${e.message}`);
        try { fs.unlinkSync(tmp); } catch (ignored) { /* nothing to clean up */ }
    }

    // OUTSIDE the try, deliberately. This used to sit inside it, so a read-only
    // or full filesystem — the one case the local cache cannot help with — also
    // stopped the config ever reaching Firestore. That is the exact opposite of
    // "best effort": the fallback failing took the primary down with it.
    firestore.writeConfig({
        filters:           settings.filters,
        globalForwarding:  settings.globalForwarding,
        autoDeleteMinutes: settings.autoDeleteMinutes
    }, 'dashboard');
}

const settings = {
    globalForwarding:  loadPersistedForwarding(),
    clearLogTs:        0,
    testMessageTs:     0,
    fetchLatestTs:     0,
    autoDeleteMinutes: loadPersistedAutoDelete(),
    filters:           loadPersistedFilters()
};

// ─── Where the running config came from ─────────────────────────
//
// Recorded so "why is it using the catch-all?" is answerable from /api/full-settings
// instead of by reading logs that have scrolled away.
let configSource = hasPersistedConfig() ? 'state file' : 'env defaults';

/**
 * The store key for a message whose SIM could not be resolved.
 *
 * =============================================================================
 * THE DEVICE ID MUST NOT CONTAIN DIGITS, AND THAT IS NOT FUSSINESS.
 *
 * canonicalizePhone strips non-digits from the WHOLE string, so a raw
 * "Unknown-<hex>" key can collapse into something that looks like a phone
 * number. addSms stored the raw string; getOtp canonicalizes its lookup. When
 * the two differ, the OTP is unfetchable.
 *
 * Measured over 20,000 random ids: 3.87% are mangled. And the results are not
 * junk — they look like this:
 *
 *     Unknown-148fd8ac8d19719e  ->  01488819719
 *
 * which is a valid Bangladeshi mobile number. So the failure is not merely "the
 * key does not match": that key can COLLIDE with a real recipient, which is the
 * exact bug the Unknown disambiguation exists to prevent.
 *
 * Found by a test that failed intermittently — roughly one run in twenty-five.
 *
 * The fix is to encode the id into letters only, so canonicalize finds no
 * digits and returns the string unchanged, always. The mapping is bijective
 * (0-9 -> q-z, a-f untouched), so ids stay unique and the key stays stable.
 * =============================================================================
 */
function unknownKey(deviceId) {
    let out = '';
    const id = String(deviceId);
    for (let i = 0; i < id.length; i++) {
        const c = id[i];
        out += (c >= '0' && c <= '9')
            ? String.fromCharCode(113 + (c.charCodeAt(0) - 48))   // 0-9 -> q..z
            : c;
    }
    return 'Unknown-' + out;
}

function hasPersistedConfig() {
    return Array.isArray(persisted.filters) && persisted.filters.length > 0;
}

// ═════════════════════════════════════════════════════════════════
// DEFERRED EXTRACTION — the one window where the wrong filters could run
// ═════════════════════════════════════════════════════════════════
//
// THE PROBLEM. Firestore is read asynchronously at boot, because nothing may
// block forwarding or fetching. On a WARM restart that costs nothing: the state
// file is read synchronously and the real filters are live before the first
// request. But on a FRESH container — a redeploy, or a free-tier spin-up —
// there is no state file, so the only config available is OTP_PATTERNS, which
// is the CATCH-ALL.
//
// And a spin-up is frequently triggered BY an incoming SMS, so the first
// message after a cold start is exactly the one at risk. Extracted under the
// catch-all it could yield the wrong digits — an amount, a reference number —
// and consume-on-read means that wrong code is handed out once and gone.
//
// A wrong OTP is worse than a late one. It fails the booking AND looks correct.
//
// THE FIX. During that window the message is still stored, still forwarded,
// still on the dashboard — nothing is blocked. Only the EXTRACTION waits, for
// at most 3 seconds, until the real config lands. A fetching script long-polling
// with &wait= simply stays parked a few hundred milliseconds longer and then
// receives the CORRECT code. That is the mechanism already built for "not ready
// yet"; this reuses it rather than inventing anything.
//
// SCOPE. `configReady` is true immediately whenever a state file exists, so
// this never triggers on a warm restart and never during normal running. It is
// a cold-start-only path.
//
// CEILING. If Firestore has not answered within 3 seconds, extraction proceeds
// with whatever config is available. Deferral can never become a hang.

// THE GATE STARTS OPEN, AND ONLY loadDurableConfig() MAY CLOSE IT.
//
// This was wrong in the first cut and the bug is worth recording, because it
// was invisible to the test suite. The line read:
//
//     let configReady = hasPersistedConfig() || !firestore.isEnabled();
//
// server.js requires lib/store BEFORE it calls firestore.init(), so at the
// moment that expression was evaluated isEnabled() was always false — and
// configReady was therefore always TRUE. Deferral could never fire in the real
// server. Verified by mimicking server.js's require order: a cold start
// extracted "2000" out of "Tk 2000.00 paid. Your OTP is 445566." and served it.
//
// The tests passed because they inject the stub client BEFORE requiring the
// store, which is the one order the real program never uses. A test that builds
// its world in a different order from production proves less than it appears to.
//
// Open by default is also the SAFE default: any caller that never invokes
// loadDurableConfig() (every existing test suite) behaves exactly as before,
// and no message can ever be deferred forever by an omission. server.js calls
// loadDurableConfig() synchronously before app.listen(), so no request can
// arrive in between.
let configReady = true;
const deferredIds = new Set();
const MAX_DEFERRAL_MS = 3000;

function isConfigReady() { return configReady; }

/**
 * Apply a config that has just arrived, then extract anything held back.
 * @param {string} source for the log and /api/full-settings
 */
function applyConfig(cfg, source) {
    if (cfg) {
        if (Array.isArray(cfg.filters) && cfg.filters.length > 0) {
            settings.filters = sanitizeFilters(cfg.filters, source);
            clearPatternCache();
        }
        if (typeof cfg.globalForwarding === 'boolean') {
            settings.globalForwarding = cfg.globalForwarding;
        }
        const mins = parseInt(cfg.autoDeleteMinutes, 10);
        if (mins > 0) settings.autoDeleteMinutes = Math.max(1, Math.min(1440, mins));

        configSource = source;
        console.log(`[store] Config from ${source}: ${settings.filters.length} rule(s), `
            + `globalForwarding=${settings.globalForwarding}`);
        // A retry can land minutes after boot, with a dashboard already open and
        // showing the env defaults. Without this it keeps showing them until
        // someone reloads the page — which looks exactly like the bug this fixes.
        broadcast('settings_change', { key: 'filters', value: settings.filters }, { adminOnly: true });
        broadcast('settings_change', { key: 'globalForwarding', value: settings.globalForwarding });
    }
    markConfigReady();
}

function markConfigReady() {
    if (configReady) return;
    configReady = true;
    resolveDeferred();
}

/**
 * Extract codes for messages that arrived before the config did.
 *
 * Goes through the same supersede / numberMap / notifyWaiters sequence addSms
 * uses, in the same order, so a deferred message behaves exactly as a normal
 * one — just later. Messages already deleted or already superseded are skipped.
 */
function resolveDeferred() {
    if (deferredIds.size === 0) return;
    const ids = Array.from(deferredIds);
    deferredIds.clear();

    let extracted = 0;
    for (const id of ids) {
        const sms = smsMap.get(id);
        if (!sms || sms.status !== 'pending') continue;

        const code = extractCode(sms.message, sms.sender, sms.recipient, settings.filters);
        if (!code) continue;

        sms.code = code;
        sms.extractedCode = code;

        for (const oldSms of messagesFor(sms.recipient)) {
            if (oldSms.id !== id && oldSms.status === 'pending') {
                oldSms.status = 'superseded';
                // The live path records this; the deferred path did not, so a
                // message superseded during the cold-start window vanished from
                // history entirely.
                history.record(oldSms, 'superseded');
                broadcast('sms_update', oldSms, { userId: oldSms.userId });
            }
        }
        numberMap.set(sms.recipient,
            { otp: code, smsKey: id, ts: sms.receivedAt, consumed: false });
        broadcast('sms_update', sms, { userId: sms.userId });
        notifyWaiters(sms.recipient);
        extracted++;
    }
    if (extracted > 0) {
        console.log(`[store] Extracted ${extracted} message(s) held back for the real config`);
    }
}

/**
 * Load the durable config, off the startup path.
 *
 * Deliberately NOT awaited by server.js: the server listens immediately and
 * both forwarding and fetching work from the first millisecond.
 */
// ─── Identity (users and devices) ───────────────────────────────
//
// Behind its own flag, off by default, so this phase is inert until you turn it
// on and rollback is one env var.
function usersEnabled() {
    const v = String(process.env.USERS_ENABLED || '').trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
}

/**
 * Load users and devices, off the startup path exactly like the config.
 *
 * Nothing waits on this: with no identity loaded, ownerOf() returns admin and
 * the server behaves as it does today. There is no equivalent of the config's
 * deferred-extraction window here, because identity affects only who SEES a
 * message, never how its code is extracted.
 */
// ═════════════════════════════════════════════════════════════════
// THE BOOT LOAD RETRIES. IT USED TO GIVE UP AFTER ONE ATTEMPT.
// ═════════════════════════════════════════════════════════════════
//
// This is the root cause of three separate rounds of apparent data loss, and it
// is worth stating exactly, because the symptom pointed somewhere else entirely.
//
// The config and identity reads happened ONCE at boot, with a three-second
// ceiling. A cold container's first Firestore call has to fetch an OAuth token,
// open a gRPC channel and finish a TLS handshake before it queries anything, so
// three seconds is a coin flip rather than a margin.
//
// When it lost: the config never loaded, so the dashboard showed the env-default
// CATCH-ALL and the filters looked deleted. The identity never loaded, so there
// were no users and they looked deleted too. The guards then correctly refused
// to write — which is why the data was still in Firestore the whole time, intact
// and invisible.
//
// And nothing ever tried again. One unlucky second at startup left the server
// degraded until somebody redeployed it, which produced another unlucky second.
//
// So: retry with backoff, indefinitely. A load that has never succeeded is a
// fault to keep working at, not a state to settle into.

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];

/** Track it per source so the dashboard can say WHICH one is failing. */
const loadState = {
    config:   { ok: false, attempts: 0, lastError: null },
    identity: { ok: false, attempts: 0, lastError: null }
};

function scheduleRetry(kind, attempt, fn) {
    const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
    const t = setTimeout(fn, delay);
    if (typeof t.unref === 'function') t.unref();
    console.warn(`[store] ${kind} load attempt ${attempt} failed — retrying in ${delay / 1000}s`);
}

function loadIdentity(attempt) {
    attempt = attempt || 0;
    if (!usersEnabled()) return;
    if (attempt === 0) users.setPersister(snap => firestore.writeIdentity(snap));

    if (!firestore.isEnabled()) {
        console.warn('[store] USERS_ENABLED is on but Firestore is not — users and '
            + 'devices will be lost on restart. Set FIRESTORE_ENABLED=true.');
        // Nothing durable exists, so nothing can be overwritten: allow in-memory
        // use rather than refusing every change.
        users.load({});
        loadState.identity.ok = true;
        return;
    }

    loadState.identity.attempts = attempt + 1;
    firestore.readIdentity().then(result => {
        if (!result.ok) {
            // DO NOT load — users.load() clears the maps, and the next automatic
            // change would push that empty set to Firestore. Accounts stay
            // untouched in Firestore; we simply try again.
            loadState.identity.lastError = firestore.getStatus().lastError || 'read failed';
            scheduleRetry('Identity', attempt + 1, () => loadIdentity(attempt + 1));
            return;
        }
        const n = users.load(result.data || {});
        loadState.identity.ok = true;
        loadState.identity.lastError = null;
        console.log(`[store] Identity loaded: ${n.users} user(s), ${n.devices} device(s)`);
    }).catch(e => {
        loadState.identity.lastError = e.message;
        scheduleRetry('Identity', attempt + 1, () => loadIdentity(attempt + 1));
    });
}

function loadDurableConfig(attempt) {
    if (!firestore.isEnabled()) {
        markConfigReady();
        loadState.config.ok = true;
        return;
    }

    // Close the gate ONLY now, and only when there is no local config to trust.
    // With a state file present the real filters are already live, so there is
    // nothing to wait for and nothing may be deferred.
    if (!hasPersistedConfig()) {
        configReady = false;
        console.warn('[store] No local config — holding OTP extraction until the '
            + 'durable config lands (max ' + MAX_DEFERRAL_MS + 'ms). Messages are '
            + 'still stored and forwarded normally.');
    }

    // Hard ceiling, armed before the read so a hung network cannot hold
    // extraction past it.
    const ceiling = setTimeout(() => {
        if (!configReady) {
            console.error('[store] Firestore did not answer within '
                + `${MAX_DEFERRAL_MS}ms — proceeding on ${configSource}`);
            markConfigReady();
        }
    }, MAX_DEFERRAL_MS);
    if (typeof ceiling.unref === 'function') ceiling.unref();

    loadState.config.attempts = (attempt || 0) + 1;
    firestore.readConfig().then(result => {
        clearTimeout(ceiling);

        if (result.ok && result.data) {
            applyConfig(result.data, 'Firestore');
            loadState.config.ok = true;
            loadState.config.lastError = null;
            return;
        }
        markConfigReady();

        if (!result.ok) {
            // Keep the local config, write nothing, and TRY AGAIN. Settling for
            // env defaults here is what made the filters look deleted.
            loadState.config.lastError = firestore.getStatus().lastError || 'read failed';
            console.error('[store] Firestore unreadable — keeping local config, NOT '
                + 'migrating, and retrying. Your saved config in Firestore is untouched.');
            scheduleRetry('Config', (attempt || 0) + 1, () => loadDurableConfig((attempt || 0) + 1));
            return;
        }
        loadState.config.ok = true;

        // ─────────────────────────────────────────────────────────
        // TWO GUARDS ON MIGRATION, BOTH LEARNED THE HARD WAY.
        //
        // 1. ONLY AFTER A SUCCESSFUL READ. A failed read used to look exactly
        //    like an empty document, so a slow boot overwrote a saved filter
        //    set with the catch-all. If we do not KNOW the document is absent,
        //    we touch nothing.
        //
        // 2. ONLY IF THERE IS SOMETHING WORTH MIGRATING. On a fresh container
        //    the local config IS the env default, and writing the catch-all up
        //    to Firestore is not a migration — it is destroying whatever is
        //    there with a value nobody chose. The first real save writes the
        //    real config anyway.
        // ─────────────────────────────────────────────────────────
        if (!hasPersistedConfig()) {
            console.warn('[store] No Firestore config and nothing local worth migrating — '
                + 'running on env defaults. Save your filters on the dashboard.');
            return;
        }
        console.log('[store] No Firestore config yet — migrating local config up');
        firestore.writeConfigNow({
            filters:           settings.filters,
            globalForwarding:  settings.globalForwarding,
            autoDeleteMinutes: settings.autoDeleteMinutes
        }, 'migration').catch(() => { /* logged inside */ });
    }).catch(e => {
        clearTimeout(ceiling);
        markConfigReady();
        loadState.config.lastError = e.message;
        scheduleRetry('Config', (attempt || 0) + 1, () => loadDurableConfig((attempt || 0) + 1));
    });
}

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

/**
 * @param {object} session { userId, role } — REQUIRED.
 *
 * =============================================================================
 * THE STREAM USED TO SEND EVERY USER'S MESSAGES TO EVERY LOGGED-IN USER
 *
 * A client was stored as a bare `res` with no identity, and broadcast() wrote to
 * all of them. So /api/messages correctly returned only your own on page load,
 * and then the live stream fed you everyone else's — full text and codes —
 * from that moment on. The scoping added in Phase 4 was defeated by the
 * mechanism that makes the dashboard live.
 *
 * A session is now mandatory rather than optional: an optional parameter would
 * mean a future caller that forgets it silently reopens the hole.
 * =============================================================================
 */
function addSSEClient(res, session) {
    if (!session || !session.userId) throw new Error('addSSEClient requires a session');
    res.writeHead(200, {
        'Content-Type':      'text/event-stream',
        'Cache-Control':     'no-cache',
        'Connection':        'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    // Send initial heartbeat
    res.write(': connected\n\n');
    const client = { res, userId: session.userId, role: session.role };
    sseClients.add(client);
    res.on('close', () => sseClients.delete(client));
}

/**
 * @param {object} [audience]
 *        { userId }    only that user, plus every admin
 *        { adminOnly } admins only
 *        omitted       everyone
 *
 * Admins always receive everything: the admin view is the whole system, and a
 * message they cannot see is one they cannot act on.
 */
function broadcast(event, data, audience) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        if (audience && client.role !== 'admin') {
            if (audience.adminOnly) continue;
            if (audience.userId && audience.userId !== client.userId) continue;
        }
        try { client.res.write(msg); } catch (e) { sseClients.delete(client); }
    }
}

// Keep SSE connections alive with heartbeat every 30s
setInterval(() => {
    for (const client of sseClients) {
        try { client.res.write(': heartbeat\n\n'); } catch (e) { sseClients.delete(client); }
    }
}, 30_000);

// ─── Auth ───────────────────────────────────────────────────────
//
// !! THIS BLOCK ONCE DESCRIBED A DESIGN THAT WAS DELIBERATELY REMOVED. !!
//
// It read: "STATELESS — survives server restarts. Token = HMAC(password,
// secret). Same password always produces the same token. Server validates by
// recomputing — no Map to lose on restart." That is NOT what the code below
// does, and has not been for several releases. The comment sat directly above
// the replacement, in the present tense, telling anyone reading top-to-bottom
// that the thing they were about to change was the intended design.
//
// A derived token never expires, cannot be revoked without changing the
// password, and is itself a verifier FOR the password — so one leak was
// permanent and total. Sessions are now 32 random bytes held server-side with
// an expiry, revocable on logout. Losing them on a redeploy is the price and it
// is the right one. DO NOT GO BACK TO A DERIVED TOKEN. See the session block
// below for the full reasoning.
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

const sessions = new Map();   // token -> { userId, role, expiresAt }

function pruneSessions() {
    const now = Date.now();
    for (const [t, s] of sessions) if (s.expiresAt <= now) sessions.delete(t);
}

function issueToken(userId, role) {
    pruneSessions();
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { userId, role, expiresAt: Date.now() + TOKEN_TTL_MS });
    return token;
}

/**
 * Dashboard login.
 *
 * ADMIN IS THE ENV PASSWORD, ALWAYS. Making admin an ordinary record would mean
 * a Firestore outage or one bad write could lock you out of your own dashboard,
 * and the recovery would be an env var anyway — so the env var IS the recovery
 * path, permanently.
 *
 * @param {string} password
 * @param {string} [username] absent = admin, which is exactly today's behaviour
 * @returns {string|null} session token
 */
function login(password, username) {
    const name = String(username || '').trim();

    if (!name || users.slug(name) === users.ADMIN_ID) {
        const expected = process.env.DASHBOARD_PASSWORD || '';
        if (!expected) return null;
        if (typeof password !== 'string' || !safeEqual(password, expected)) return null;
        return issueToken(users.ADMIN_ID, 'admin');
    }

    if (!usersEnabled()) return null;
    const who = users.authenticate(name, password);
    if (!who) return null;
    return issueToken(who.id, who.role);
}

/**
 * Resolve a token to its session, or null.
 *
 * RE-CHECKS THAT THE ACCOUNT IS STILL ACTIVE, on every call. Checking only at
 * login would leave a deactivated user in full control until their token
 * expired — up to twelve hours. This way their buttons stop responding
 * mid-session. It costs a Map lookup: users live in memory, so there is no
 * Firestore call and nothing measurable on any request.
 */
function getSession(token) {
    if (!token || typeof token !== 'string') return null;
    const s = sessions.get(token);
    if (!s) return null;
    if (s.expiresAt <= Date.now()) { sessions.delete(token); return null; }
    if (usersEnabled() && !users.isActive(s.userId)) {
        sessions.delete(token);
        console.warn(`[store] Session rejected — account "${s.userId}" is deactivated`);
        return null;
    }
    return s;
}

/** Kill every session belonging to one user. Used the instant they are deactivated. */
function revokeSessionsFor(userId) {
    let n = 0;
    for (const [t, s] of sessions) if (s.userId === userId) { sessions.delete(t); n++; }
    return n;
}

/** Logout, and it means it — the token stops working server-side. */
function revokeToken(token) {
    return token ? sessions.delete(token) : false;
}

function validateToken(token) {
    return getSession(token) !== null;
}

// ─── SMS operations ─────────────────────────────────────────────

/**
 * @param {string} [deviceId] which phone sent this. Optional: an older app sends
 *        none, and I8 says it must keep working — see ownerOf().
 */
function addSms(sender, recipient, message, arrivedAt, deviceId) {
    // Same reason as extractCode: a JSON body can carry any type. Normalise at
    // the boundary so nothing downstream has to defend itself.
    sender    = sender    == null ? '' : String(sender);
    recipient = recipient == null ? '' : String(recipient);
    message   = message   == null ? '' : String(message);

    const id        = crypto.randomBytes(8).toString('hex');
    const serverNow = Date.now();                              // FIX #2: always use server time for timing
    let normRecip   = canonicalizePhone(recipient || 'Unknown'); // FIX #3: normalize recipient

    // WHOSE MESSAGE IS THIS. Falls back to admin for an unknown or absent
    // device, so an older app — which sends no deviceId — keeps working and
    // nothing is ever dropped for want of identity (I8).
    const ownerId = usersEnabled() ? users.ownerOf(deviceId) : users.ADMIN_ID;

    // ─────────────────────────────────────────────────────────────
    // "Unknown" IS A COLLISION THE MOMENT THERE ARE TWO DEVICES.
    //
    // PhoneUtils files a message under the literal string "Unknown" when the
    // SIM cannot be resolved — routine on Bangladeshi carriers that never write
    // EF_MSISDN. With one phone that is a display quirk. With two, BOTH write to
    // the same key, so one person's SMS supersedes another's live OTP and
    // whoever fetches first gets a code that was never theirs.
    //
    // Disambiguating by device makes the keys naturally distinct. Note this is
    // NOT a rekey: real phone numbers are already globally unique, so the
    // recipient string remains the key for every real message and getOtp(), the
    // recipient index and the waiters are all untouched (I11).
    // ─────────────────────────────────────────────────────────────
    if (normRecip === 'Unknown' && deviceId) normRecip = unknownKey(deviceId);

    // Cold-start window only: the durable config has not landed yet, so the
    // filters currently in memory are the CATCH-ALL and would extract the wrong
    // digits. Store, forward and broadcast exactly as normal — only the
    // extraction waits. See the deferred-extraction block above.
    const defer     = !configReady;
    const code      = defer ? null
                            : extractCode(message, sender, normRecip, settings.filters);
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
        // Identity is ADDITIVE — two display fields and an owner. Nothing that
        // decides anything about an OTP reads them.
        userId:      ownerId,
        deviceId:    deviceId || null,
        deviceLabel: (usersEnabled() && deviceId) ? users.deviceLabel(deviceId) : null,
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

    if (defer) {
        deferredIds.add(id);
        console.warn(`[store] ${id} held for the real config — extraction deferred`);
    }

    if (code) {
        // SUPERSEDE: kill ALL previous pending OTPs for this recipient instantly.
        // Indexed — this now touches only this recipient's messages (normally
        // one or zero) instead of walking every message on the server.
        for (const oldSms of messagesFor(normRecip)) {
            if (oldSms.id !== id && oldSms.status === 'pending') {
                oldSms.status = 'superseded';
                history.record(oldSms, 'superseded');
                broadcast('sms_update', oldSms, { userId: oldSms.userId });
            }
        }

        // Replace the fast-lookup entry — use SERVER time for ts (FIX #2)
        numberMap.set(normRecip, { otp: code, smsKey: id, ts: serverNow, consumed: false });
    }

    broadcast('sms_new', sms, { userId: sms.userId });
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
            // Finished, and the outcome is settled. Queued, not written — see
            // lib/history.js. Nothing about this call can delay the return below.
            history.record(sms, 'fetched');
            broadcast('sms_update', sms, { userId: sms.userId });
        }
        return String(entry.otp);
    }

    // Fallback: this recipient's UNFETCHED messages. Reached only when numberMap
    // has no entry for the number at all.
    //
    // GATED ON THE CONFIG, and this was a genuine hole caught by
    // test/firestore.test.js. This path calls extractCode() itself rather than
    // reading sms.extractedCode, so during the cold-start window it would have
    // done under the covers exactly what addSms was deliberately held back from
    // doing: extract with the catch-all, and — worse than addSms — consume the
    // result immediately. A deferred message must be invisible to every
    // extraction path, not just to the one that stored it.
    if (!configReady) return null;

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
        history.record(sms, 'fetched');
        numberMap.set(normNumber, { otp: code, smsKey: sms.id, ts: sms.receivedAt, consumed: true });
        broadcast('sms_update', sms, { userId: sms.userId });
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
            broadcast('sms_update', sms, { userId: sms.userId });
        }
    }
    console.log(`[store] Returned unfetched OTP for ${normNumber} — client disconnected`);

    // WAKE ANYONE PARKED ON THIS NUMBER.
    //
    // Without this the restore was half a fix. unconsume() exists for exactly
    // one situation — a long-poll whose client hung up between being handed the
    // code and the response being written — and that client's very next act is
    // another long-poll for the same number. It would park on a code that was
    // already sitting there, restored and available, and block for its full
    // wait window (up to 25 s) before answering. Measured: waiter got null while
    // a plain fetch immediately afterwards returned the code.
    //
    // Placed LAST, after the entry, the message status and the broadcast are all
    // committed, for the same reason addSms notifies last: a woken waiter
    // consumes through getOtp() and must never observe a half-restored state.
    notifyWaiters(normNumber);
    return true;
}

function getAllSms() {
    // Server clock: one device with a wrong clock must not be able to push its
    // messages to the top (or bottom) of everyone else's dashboard.
    return Array.from(smsMap.values()).sort((a, b) => b.receivedAt - a.receivedAt);
}

/**
 * @param {string} [userId] clear only this user's messages. Omit for everything.
 *
 * Scoped removal goes through removeSms so the recipient index, numberMap and
 * the SSE broadcast stay in step — the three-place rule at the top of this file.
 * Clearing wholesale is still a straight wipe, which is cheaper and is what
 * admin does.
 */
function clearAll(userId) {
    if (userId) {
        let n = 0;
        for (const [id, sms] of Array.from(smsMap)) {
            if (sms.userId === userId) { removeSms(id, sms); n++; }
        }
        console.log(`[store] Cleared ${n} message(s) for ${userId}`);
        return n;
    }
    smsMap.clear();
    numberMap.clear();
    byRecipient.clear();
    broadcast('clear_all', {});
    console.log('[store] All SMS cleared');
    return -1;
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

// ═════════════════════════════════════════════════════════════════
// PER-USER FORWARDING OVERRIDE
// ═════════════════════════════════════════════════════════════════
//
// When the admin switches forwarding OFF globally, a user may turn their OWN
// phones back on for a bounded window.
//
//     effective(device) = globalForwarding OR (owner's override active)
//
// FOUR PROPERTIES, EACH DELIBERATE:
//
// 1. ENFORCED SERVER-SIDE, like the global switch (I5). A device that never
//    receives the message still cannot deliver, and a device that never
//    receives the EXPIRY still cannot deliver past it. The phone is told the
//    answer; it does not compute it.
//
// 2. IT RUNS OUT ITS OWN CLOCK. When the admin re-enables global forwarding an
//    active override is NOT cancelled — Riad's decision, and it matches how
//    every other switch here behaves: a thing you turned on for 30 minutes
//    stays on for 30 minutes. It simply stops mattering while global is on.
//
// 3. THE CEILING IS THE ADMIN'S. A request for longer is CLAMPED, not refused:
//    refusing an over-long request on a system whose job is not to miss OTPs
//    would trade a small annoyance for a missed booking.
//
// 4. DEACTIVATION ENDS IT IMMEDIATELY. Running out the clock is for the normal
//    transition; deactivation is a deliberate revocation and takes effect now.
//
// In memory only, and that is correct: a redeploy that loses a 30-minute window
// leaves the system in its SAFE state (off), and the user can start another.
// Persisting it would mean a redeploy could resurrect an expired one.

const overrides = new Map();   // userId -> expiresAt

function overrideCeilingMinutes() {
    const raw = parseInt(process.env.OVERRIDE_MAX_MINUTES || '30', 10);
    return Math.max(1, Math.min(240, raw || 30));
}

/**
 * @returns {{ok:boolean, expiresAt?:number, minutes?:number, clamped?:boolean, error?:string}}
 */
function startOverride(userId, minutes) {
    if (!usersEnabled()) return { ok: false, error: 'Users are not enabled' };
    if (!userId || userId === users.ADMIN_ID) {
        // Admin has the global switch. A personal override would be a second
        // way to do the same thing, which is how two switches drift apart.
        return { ok: false, error: 'Admin uses the global switch' };
    }
    if (!users.isActive(userId)) return { ok: false, error: 'Account is not active' };

    const ceiling = overrideCeilingMinutes();
    const asked   = parseInt(minutes, 10);
    const want    = (asked > 0 ? asked : ceiling);
    const granted = Math.min(want, ceiling);

    const expiresAt = Date.now() + granted * 60_000;
    overrides.set(userId, expiresAt);
    broadcast('settings_change', { key: 'override', value: { userId, expiresAt } }, { userId });
    console.log(`[store] Override for ${userId}: ${granted} min `
        + `(asked ${want}, ceiling ${ceiling})`);
    return { ok: true, expiresAt, minutes: granted, clamped: granted < want };
}

function cancelOverride(userId) {
    const had = overrides.delete(userId);
    if (had) {
        broadcast('settings_change', { key: 'override', value: { userId, expiresAt: 0 } }, { userId });
        console.log(`[store] Override for ${userId} cancelled`);
    }
    return had;
}

/** Remaining ms, or 0. Expired entries are dropped on read — no sweeper needed. */
function overrideRemaining(userId) {
    if (!userId) return 0;
    const exp = overrides.get(userId);
    if (!exp) return 0;
    if (exp <= Date.now()) { overrides.delete(userId); return 0; }
    return exp - Date.now();
}

function listOverrides() {
    const out = {};
    for (const id of Array.from(overrides.keys())) {
        const left = overrideRemaining(id);
        if (left > 0) out[id] = { expiresAt: overrides.get(id), remainingMs: left };
    }
    return out;
}

/**
 * Should THIS device be forwarding right now?
 *
 * The single answer both /sms and /api/settings use, so the enforcement and the
 * instruction can never disagree — which is the failure mode that produced the
 * old "off switch that undoes itself".
 */
function forwardingFor(deviceId) {
    // A DEACTIVATED OWNER'S PHONES FORWARD NOTHING — and this outranks the
    // global switch. Deactivating is how you take someone out of the system;
    // leaving their phones pushing SMS into the admin's view is not what
    // "deactivated" means to the person doing it.
    //
    // Checked against the raw assignment and the raw claim, NOT ownerOf(), which
    // deliberately falls back to admin for an inactive owner. That fallback is
    // about where a message is FILED, not about whether it may arrive at all.
    //
    // An UNASSIGNED device is unaffected: a new phone must forward from the
    // moment it is installed, or it looks broken before you have had the chance
    // to assign it.
    if (usersEnabled()) {
        const d = users.getDevice(deviceId);
        if (d) {
            const claimed = d.claimedUserId && !String(d.claimedUserId).startsWith('?')
                ? d.claimedUserId : null;
            const owner = d.userId || claimed;
            if (owner && owner !== users.ADMIN_ID && !users.isActive(owner)) return false;
        }
    }

    if (settings.globalForwarding) return true;
    if (!usersEnabled()) return false;
    const owner = users.ownerOf(deviceId);
    if (!owner || owner === users.ADMIN_ID) return false;
    return overrideRemaining(owner) > 0;
}

// ═════════════════════════════════════════════════════════════════
// ONE-SHOT COMMANDS, OPTIONALLY AIMED AT ONE USER
// ═════════════════════════════════════════════════════════════════
//
// The timestamps have always been global. Targeting adds a per-user layer over
// them, and the device is served whichever is NEWER — its owner's, or the
// broadcast one.
//
// max() rather than a replacement, because the two are independent: an admin
// aiming Test at one user must not cancel a fleet-wide Clear Log issued a
// moment earlier, and a later broadcast must still reach a user who was
// targeted before it. RemoteCommands already de-duplicates by timestamp, so a
// device that sees the same value twice runs it once — no app change needed for
// any of this.

const targeted = { clearLog: new Map(), test: new Map(), fetchLatest: new Map() };

/** The newest of the broadcast timestamp and this owner's, if any. */
function tsFor(map, broadcastTs, owner) {
    if (!owner) return broadcastTs;
    return Math.max(broadcastTs || 0, map.get(owner) || 0);
}

function setTargeted(map, userId, ts) {
    map.set(userId, ts);
    // Bounded: one entry per user, and users are few. Nothing to sweep.
}

function triggerClearLog(ts, userId) {
    const t = ts || Date.now();
    if (userId && userId !== users.ADMIN_ID) setTargeted(targeted.clearLog, userId, t);
    else settings.clearLogTs = t;
    broadcast('settings_change', { key: 'clearLogTs', value: t, userId: userId || null });
    return t;
}

function triggerTestMessage(ts, userId) {
    const t = ts || Date.now();
    if (userId && userId !== users.ADMIN_ID) setTargeted(targeted.test, userId, t);
    else settings.testMessageTs = t;
    broadcast('settings_change', { key: 'testMessageTs', value: t, userId: userId || null });
    return t;
}

/** What THIS device should see for the three one-shots. */
function commandsFor(deviceId) {
    const owner = usersEnabled() ? users.ownerOf(deviceId) : null;
    const scoped = owner && owner !== users.ADMIN_ID ? owner : null;
    return {
        clearLogTs:    tsFor(targeted.clearLog,    settings.clearLogTs,    scoped),
        testMessageTs: tsFor(targeted.test,        settings.testMessageTs, scoped),
        fetchLatestTs: tsFor(targeted.fetchLatest, settings.fetchLatestTs, scoped)
    };
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
function triggerFetchLatest(ts, userId) {
    const t = ts || Date.now();
    if (userId && userId !== users.ADMIN_ID) setTargeted(targeted.fetchLatest, userId, t);
    else settings.fetchLatestTs = t;
    broadcast('settings_change', { key: 'fetchLatestTs', value: t, userId: userId || null });
    return t;
}

function setAutoDeleteMinutes(mins) {
    settings.autoDeleteMinutes = Math.max(1, Math.min(1440, parseInt(mins, 10) || 30));
    persistState();
    broadcast('settings_change', { key: 'autoDeleteMinutes', value: settings.autoDeleteMinutes }, { adminOnly: true });
}

/**
 * Fold rules that target the same sender into one.
 *
 * =========================================================================
 * WHY THIS EXISTS
 *
 * Sender matching normalises: upper-case, then spaces, underscores and hyphens
 * are stripped. So "IVAC_BD", "IVACBD" and "IVAC BD" are all the SAME sender.
 * Matching also stops at the FIRST rule that claims a sender.
 *
 * That combination is a trap. An operator adding a second rule for a sender —
 * intending a fallback pattern for when the message format changes — instead
 * created a rule that could never run, and had no way to tell. The fallback
 * looked present and was silently dead.
 *
 * Merging turns that into what was meant: one rule, patterns tried in order.
 * Order is preserved — the first occurrence keeps its position and its patterns
 * come first, so an existing setup does not change behaviour by being merged.
 * =========================================================================
 */
function mergeFilterRules(filters) {
    const norm = v => String(v == null ? '' : v).toUpperCase().replace(/[\s_-]/g, '');
    const byKey = new Map();
    const order = [];

    for (const rule of filters) {
        if (!rule || typeof rule !== 'object') continue;
        const key = rule.phoneNumber === 'DEFAULT' ? 'DEFAULT' : norm(rule.phoneNumber);
        const pats = Array.isArray(rule.patterns) ? rule.patterns : [];
        if (!byKey.has(key)) {
            byKey.set(key, { phoneNumber: rule.phoneNumber, patterns: [...pats] });
            order.push(key);
        } else {
            const existing = byKey.get(key);
            for (const p of pats) {
                if (!existing.patterns.includes(p)) existing.patterns.push(p);
            }
        }
    }
    return order.map(k => byKey.get(k));
}

function setFilters(filters) {
    if (Array.isArray(filters)) {
        filters = mergeFilterRules(filters);
        settings.filters = filters;
        persistState();
        // Drop compiled regexes for the old rule set — otherwise a pattern the
        // operator just deleted would sit in the cache for the process lifetime.
        clearPatternCache();
        broadcast('settings_change', { key: 'filters', value: settings.filters }, { adminOnly: true });
        console.log(`[store] Filters updated: ${filters.length} rule(s)`);
    }
}

// ─── Auto-delete expired SMS ────────────────────────────────────
setInterval(() => {
    // Expired sessions were only ever pruned inside login(), so a dashboard
    // nobody logs into again keeps every dead token in memory for the life of
    // the process. Cheap, and this timer is already running.
    pruneSessions();

    if (smsMap.size === 0) return;
    const now     = Date.now();
    let   deleted = 0;
    for (const [id, sms] of smsMap) {
        if (now >= sms.deleteAt) {
            // The last moment the outcome is knowable. 'used' was archived when
            // it was fetched; anything still pending was never fetched, and a
            // message with no code was never extractable in the first place.
            // ONLY 'pending'. A superseded message was already archived at the
            // moment it was superseded; recording it again here wrote 'expired'
            // over it, because the batch writes by smsId and the later value
            // wins. That inflated the written count AND corrupted the outcome
            // totals — including the fetch rate, which is the one number meant
            // to say whether the system is healthy.
            if (sms.status === 'pending') {
                history.record(sms, sms.extractedCode ? 'expired' : 'no_code');
            }
            removeSms(id, sms);
            deleted++;
        }
    }
    if (deleted > 0) console.log(`[store] Auto-deleted ${deleted} expired message(s)`);
}, 60_000);

// ─── Exports ────────────────────────────────────────────────────
module.exports = {
    addSms, getOtp, getAllSms, clearAll, waitForOtp, unconsume, senderMatches,
    loadDurableConfig, isConfigReady, loadIdentity, usersEnabled,
    startOverride, cancelOverride, overrideRemaining, listOverrides,
    forwardingFor, overrideCeilingMinutes, commandsFor, unknownKey,
    /** Messages visible to one caller. Admin sees everything. */
    getSmsFor: (userId) => {
        const all = getAllSms();
        if (!usersEnabled() || userId === users.ADMIN_ID) return all;
        return all.filter(m => m.userId === userId);
    },
    /** Which source the running config came from — surfaced on the dashboard. */
    configStatus: () => ({
        source:       configSource,
        ready:        configReady,
        deferred:     deferredIds.size,
        // "Never loaded" and "loaded, and genuinely empty" look identical on a
        // dashboard unless you say which. Three rounds of "my data is gone"
        // were actually this.
        load:         { config: Object.assign({}, loadState.config),
                        identity: Object.assign({}, loadState.identity) },
        firestore:    firestore.getStatus()
    }),
    /** Force both loads now — the admin's "Reload from Firestore". */
    reloadDurable: () => { loadDurableConfig(0); loadIdentity(0); },
    /**
     * Are all long-poll slots taken? /get asks BEFORE parking, so it can answer
     * "busy" instead of "timedOut". They are not the same thing and a client
     * that cannot tell them apart re-asks in a tight loop: a refused park
     * resolves instantly, so "timedOut" after 0 ms invited exactly that.
     */
    waitersFull: () => waiterCount >= MAX_WAITERS,
    mergeFilterRules,
    revokeToken,
    triggerFetchLatest,
    isForwardingEnabled: () => settings.globalForwarding,
    // Test-only surface. Nothing in server.js touches these; they exist so
    // test/store.test.js can re-derive the index by brute force and compare.
    _internals: { smsMap, byRecipient, numberMap, MAX_MESSAGES },
    getSettings, setGlobalForwarding, triggerClearLog, triggerTestMessage,
    setAutoDeleteMinutes, setFilters,
    addSSEClient, login, validateToken, getSession, revokeSessionsFor,
    users,
    canonicalizePhone
};
