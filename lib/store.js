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
const { extractCode, extractDetailed, clearPatternCache, validatePattern, validateRule,
        senderClaimedBy, looksLikeOtp } = require('./otp');
const { sanitizeExamples } = require('./teach');

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
/** Longest SMS body kept (characters). A 10-part SMS is ~1,530. */
const MAX_MESSAGE_CHARS = 8000;
const MAX_SENDER_CHARS  = 200;

/**
 * Arrival order, as a strictly increasing integer stamped on every message.
 *
 * receivedAt is a millisecond clock, so two messages in the same millisecond tie
 * and a clock step backwards reorders them. "Newest wins" needs an order that can
 * do neither, because three different paths (addSms, the cold-start release and
 * the provisional correction) all have to agree on which message is newer.
 */
let seqCounter = 0;

/** Sender the app uses for dashboard Test messages. Lowest priority — see commitCode. */
const TEST_SENDER = history.TEST_SENDER;

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
function removeSms(id, sms, cleared) {
    // A message dropped by the size cap, or cleared by hand, still finished —
    // and the cap fires during exactly the flood you would want to investigate.
    // Only 'pending': anything else was archived when it reached that state.
    // @param cleared true when an operator deleted it, rather than the clock.
    // "expired" would be a lie on the fetch-rate metric — nobody failed to fetch
    // a message that was taken away.
    if (sms.status === 'pending') {
        history.record(sms, cleared ? 'cleared'
                                    : (sms.extractedCode ? 'expired' : 'no_code'));
    }
    smsMap.delete(id);
    indexRemove(sms);
    if (!byRecipient.has(sms.recipient)) lastLive.delete(sms.recipient);
    // The cold-start sets are keyed by id, so this is the one place they can be
    // kept honest. Without it a long Firestore outage would leave provisionalIds
    // holding ids for messages that were deleted half an hour ago.
    deferredIds.delete(id);
    provisionalIds.delete(id);
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

        // A blank name matches everything and shadows DEFAULT. Dropped here for
        // the same reason an uncompilable pattern is: it cannot do what it looks
        // like it does.
        const ruleProblem = validateRule(rule);
        if (ruleProblem) {
            console.error(`[store] ${source}: dropping rule ${JSON.stringify(label)} — `
                + ruleProblem);
            continue;
        }
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

/**
 * Taught examples (server 4.43.0, Teach from SMS): messages with a KNOWN right
 * code, re-checked whenever the filters change. Persisted with the filters —
 * state file and Firestore — as their own field, NOT inside the rules: an
 * older OTP Master saves rules as {phoneNumber, patterns} only, and anything
 * else inside a rule would be erased by its next save.
 */
function loadPersistedExamples() {
    return sanitizeExamples(persisted.filterExamples);
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
 *
 * =============================================================================
 * pushConfig SAYS WHO IS CALLING, AND IT IS LOAD-BEARING.
 *
 * This function has TWO callers with completely different intent:
 *
 *   true  — an operator changed a SETTING (setFilters, setGlobalForwarding,
 *           setAutoDeleteMinutes). The in-memory config IS the new truth and
 *           belongs in Firestore.
 *
 *   false — the IDENTITY changed (a user edited, or, far more often, a phone
 *           registering itself on every process start). Identity rides in the
 *           same state file, so the local write still has to happen — but the
 *           config in memory is whatever the boot load left there, and pushing
 *           it is not a save, it is an overwrite nobody asked for.
 *
 * It used to push unconditionally, and that destroyed real filter sets:
 *
 *   fresh container (redeploy or free-tier spin-up, so no state file)
 *     -> Firestore config read times out
 *     -> the guards correctly keep the env CATCH-ALL and refuse to migrate,
 *        logging "your saved config in Firestore is untouched"
 *     -> a phone registers two seconds later, markDirty -> persistState
 *     -> the catch-all is written over the operator's real filters
 *     -> the retry chain then reads back the catch-all it just wrote.
 *
 * Permanent, silent, and triggered by a phone rebooting. Same class as the
 * readConfig ok/data conflation, arriving through the IDENTITY door instead of
 * the migration door — which is why the migration guard could not see it.
 *
 * configSource moves inside the same branch for the same reason: a device
 * registration was reporting the running config as "dashboard", so the one
 * readout that answers "why is it using the catch-all?" started lying the
 * moment the first phone checked in.
 * =============================================================================
 *
 * @param {boolean} [pushConfig=true] false when only identity changed.
 */
/**
 * WHEN each config field was last changed HERE (a dashboard save), per field.
 *
 * A Firestore document is applied field by field: a field changed here AFTER
 * the document was written (its updatedAt) keeps the local value — the read is
 * older than it. Every other field takes the document's value.
 *
 * Per field, not all-or-nothing (review of 4.38.4): the first version threw
 * the whole document away when ANY save happened during the read, so a
 * toggle flipped during a cold start kept the env CATCH-ALL filters in memory
 * — and a promo's "2000" was served as an OTP. And by the document's own
 * timestamp, not by when the read started: a RETRY read that began after the
 * save but before its debounced write landed still read the older document,
 * and undid the toggle ("an off that turns itself back on").
 */
const localChangedAt = { filters: 0, globalForwarding: 0, autoDeleteMinutes: 0, filterExamples: 0 };
function noteLocalChange(key) { localChangedAt[key] = Date.now(); }

function persistState(pushConfig) {
    if (pushConfig === undefined) pushConfig = true;
    const tmp = STATE_FILE + '.tmp';

    // The running config is no longer whatever it was at boot — the operator
    // just set it. Without this the dashboard kept showing "running on env
    // defaults" in red after a successful save, because configSource was only
    // ever written at startup and by a Firestore load. Alarming, and wrong: the
    // catch-all warning is the one message that must never cry wolf, or it stops
    // being read on the day it is true.
    if (pushConfig) configSource = 'dashboard';

    try {
        fs.writeFileSync(tmp, JSON.stringify({
            globalForwarding:  settings.globalForwarding,
            filters:           settings.filters,
            autoDeleteMinutes: settings.autoDeleteMinutes,
            // Only when KNOWN: a fresh container's empty placeholder written
            // here would read back as "known" after a warm restart (review).
            filterExamples:    examplesKnown() ? settings.filterExamples : undefined,
            // Identity rides in the same file. Config has had this cache since
            // 4.20.0 and identity had none, so a failed Firestore read left the
            // system with no users at all — indistinguishable from deletion.
            identity:          usersEnabled() && users.isLoaded() ? users.snapshot() : undefined
        }));
        fs.renameSync(tmp, STATE_FILE);
    } catch (e) {
        // Best effort. A read-only or full filesystem must not break the toggle
        // itself — the env defaults still cover the restart case. Clean up the
        // temp file so a later successful write is not confused by it.
        console.warn(`[store] Could not persist state: ${e.message}`);
        try { fs.unlinkSync(tmp); } catch (ignored) { /* nothing to clean up */ }
    }

    // An identity-only save is finished here: the local file carries the
    // snapshot, and firestore.writeIdentity has the durable half. Nothing about
    // the CONFIG changed, so nothing about it may be written. See the header.
    if (!pushConfig) return;

    // OUTSIDE the try, deliberately. This used to sit inside it, so a read-only
    // or full filesystem — the one case the local cache cannot help with — also
    // stopped the config ever reaching Firestore. That is the exact opposite of
    // "best effort": the fallback failing took the primary down with it.
    firestore.writeConfig({
        filters:           settings.filters,
        globalForwarding:  settings.globalForwarding,
        autoDeleteMinutes: settings.autoDeleteMinutes,
        // Only when this process KNOWS them: on a fresh container whose
        // Firestore read has not succeeded yet, the examples in memory are an
        // empty placeholder, and writing it would erase the saved ones. Absent
        // = Firestore keeps what it has (firestore.js writes with merge).
        filterExamples:    examplesKnown() ? settings.filterExamples : undefined
    }, 'dashboard');
}

const settings = {
    globalForwarding:  loadPersistedForwarding(),
    clearLogTs:        0,
    testMessageTs:     0,
    fetchLatestTs:     0,
    autoDeleteMinutes: loadPersistedAutoDelete(),
    filters:           loadPersistedFilters(),
    filterExamples:    loadPersistedExamples()
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

// ─── The other half of the cold-start window ────────────────────
//
// =============================================================================
// THE 3s CEILING DID NOT CLOSE THE HOLE. IT ONLY MOVED IT.
//
// firestore.js raised its read timeout to 20s for a stated reason: a cold
// container's first Firestore call fetches an OAuth token, opens a gRPC channel
// and finishes a TLS handshake before it queries anything, and "three seconds
// was a coin flip, not a margin". But MAX_DEFERRAL_MS stayed at 3s — so on every
// cold start where the read takes 3-20s (the COMMON case, and a spin-up is
// frequently triggered BY the incoming SMS) the gate opened early and the
// message was extracted with the env CATCH-ALL after all. That is the exact
// wrong-code failure the deferral block was written to prevent.
//
// The answer is NOT a longer ceiling. 3s is the right ceiling: nothing may wait
// longer than that, and a longer one would slow the one path that is the
// product. The answer is that a code read under the catch-all is PROVISIONAL —
// an answer we were forced to give, not one we stand behind — so when the real
// config lands we go back and correct it.
//
// A message can only be corrected while it is still PENDING. One already handed
// out is gone, which is why the 3s ceiling stays tight: it keeps the population
// that can be got wrong AND fetched inside the same handful of seconds down to
// as close to nothing as this design allows.
//
// COSTS NOTHING IN THE STEADY STATE. configProvisional is false the moment a
// config load settles, so this is a cold-start-only path, exactly like the gate
// above. Ids leave the set when their message leaves memory (see removeSms), so
// it is bounded by MAX_MESSAGES even through a long Firestore outage.
// =============================================================================
let configProvisional = false;
const provisionalIds = new Set();

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
        // Absent from a document written before 4.43.0: keep what is here.
        if (Array.isArray(cfg.filterExamples)) settings.filterExamples = sanitizeExamples(cfg.filterExamples);

        configSource = source;
        console.log(`[store] Config from ${source}: ${settings.filters.length} rule(s), `
            + `globalForwarding=${settings.globalForwarding}`);
        // A retry can land minutes after boot, with a dashboard already open and
        // showing the env defaults. Without this it keeps showing them until
        // someone reloads the page — which looks exactly like the bug this fixes.
        broadcast('settings_change', { key: 'filters', value: settings.filters }, { adminOnly: true });
        broadcast('settings_change', { key: 'globalForwarding', value: settings.globalForwarding });
    }
    // markConfigReady FIRST: anything still held by the gate must be extracted
    // with the config that has just landed, not re-checked afterwards as if it
    // had been read with the catch-all.
    markConfigReady();
    endProvisional();
}

function markConfigReady() {
    if (configReady) return;
    configReady = true;
    resolveDeferred();
}

/**
 * The config question is settled — nothing further is coming that could change
 * an extraction. Correct anything read under the catch-all meanwhile.
 *
 * Called on a successful load AND on a successful read that found no document:
 * both are final answers. A FAILED read is not — a retry may still land — so it
 * leaves the window open.
 */
function endProvisional() {
    configProvisional = false;
    reconcileProvisional();
}

/**
 * Re-read messages that were extracted before the durable config arrived.
 *
 * Re-runs extractCode with the real filters and acts only where the answer
 * actually CHANGED, so on the normal path (the catch-all happened to agree, or
 * the filters were the same all along) this is a loop over a handful of ids that
 * does nothing at all.
 *
 * TOUCHES numberMap ONLY WHERE THIS MESSAGE IS STILL THE LIVE ONE. If something
 * newer has taken the number, it won: correcting a message that has already been
 * superseded must not resurrect it over a fresher code. Same rule as unconsume.
 */
function reconcileProvisional() {
    if (provisionalIds.size === 0) return;
    const ids = Array.from(provisionalIds);
    provisionalIds.clear();

    const corrected = reapplyBatch(ids, 'it was read with the catch-all');
    if (corrected > 0) {
        console.warn(`[store] Corrected ${corrected} message(s) extracted during the `
            + `cold-start window`);
    }
}

/**
 * Re-read a set of messages, oldest first, and wake waiters only AFTER the whole
 * set is committed.
 *
 * =============================================================================
 * WAKING INSIDE THE LOOP HANDED A PARKED FETCH THE OLDER CODE.
 *
 * A long-poll parked on the number consumes the instant it is woken. Woken after
 * message i of a batch, it took message i's code before the NEWER message i+1
 * had been installed — and a plain /get then returned i+1 as well: two codes
 * served, the waiter holding the wrong one. Found by an independent review of
 * 4.37.0 on both the cold-start release and the filter-save path. Same reason
 * addSms notifies LAST: nothing may be consumed until everything is committed.
 * =============================================================================
 *
 * @returns {number} how many messages changed
 */
/**
 * Recipients whose code changed by a restore (below) and whose waiters must
 * still be woken — AFTER the batch in progress, like every other wake-up here.
 */
const restoredRecipients = new Set();

function flushRestored() {
    if (!restoredRecipients.size) return;
    const list = Array.from(restoredRecipients);
    restoredRecipients.clear();
    for (const r of list) notifyWaiters(r);
}

/**
 * The live message for a number has just LOST its code — a filter correction
 * read it as no OTP after all (a promo the catch-all took for "2000"), or it
 * turned out to be from our own SIM. Whatever it superseded was superseded by
 * a code that never existed: put those back, and let the normal rule
 * (commitCode, oldest first) pick the live one again.
 *
 * Before this, the real OTP stayed 'superseded' and /get answered null for
 * the rest of its window (audit, 4.42.1 — reproduced).
 */
function restoreSuperseded(lost) {
    const now = Date.now();
    const back = messagesFor(lost.recipient)
        .filter(m => m.status === 'superseded' && m.supersededBy === lost.id
                     && now - (m.receivedAt || 0) <= MAX_OTP_AGE_MS)
        .sort((a, b) => a.seq - b.seq);
    for (const m of back) {
        m.status = 'pending';
        delete m.supersededBy;
        const code = extractCode(m.message, m.sender, m.recipient, settings.filters);
        commitCode(m, code);
        broadcast('sms_update', m, { userId: m.userId });
        console.warn(`[store] ${m.id}: restored — the code that superseded it (${lost.id}) is gone`);
    }
    if (back.length) restoredRecipients.add(lost.recipient);
    return back.length;
}

function reapplyBatch(ids, why) {
    const touched = new Set();
    let changed = 0;
    for (const id of byArrival(ids)) {
        const r = reapplyExtraction(id, why);
        if (r) { changed++; if (r.code) touched.add(r.recipient); }
    }
    for (const recipient of touched) notifyWaiters(recipient);
    flushRestored();
    return changed;
}

/** Ids sorted oldest-first by arrival, skipping ones no longer in memory. */
function byArrival(ids) {
    return ids.filter(id => smsMap.has(id))
              .sort((a, b) => smsMap.get(a).seq - smsMap.get(b).seq);
}

/**
 * Re-read ONE still-pending message with the filters now in force, and act only
 * if the answer changed. Shared by the cold-start correction and by a filter
 * save, so "the filters changed under a waiting message" has one meaning.
 *
 * Does NOT wake waiters — reapplyBatch does that once the whole batch is in.
 *
 * @returns {{recipient:string, code:string|null}|null} what changed, or null.
 */
function reapplyExtraction(id, why) {
    const sms = smsMap.get(id);
    // 'pending' only. A code already fetched cannot be taken back, and a
    // superseded or finished one is no longer anybody's answer.
    if (!sms || sms.status !== 'pending') return null;
    if (convertIfInternal(sms)) return null;

    const code = extractCode(sms.message, sms.sender, sms.recipient, settings.filters);
    const was  = sms.extractedCode || null;
    if ((code || null) === was) return null;

    console.warn(`[store] ${id}: ${why} — correcting ${was || '(none)'} to `
        + `${code || '(none)'}`);

    const entry = numberMap.get(sms.recipient);
    if (entry && entry.smsKey === id) {
        // It is already the live one: correct it in place.
        sms.code          = code || '';
        sms.extractedCode = code || null;
        if (code) entry.otp = code;
        else {
            numberMap.delete(sms.recipient);        // never really had a code
            restoreSuperseded(sms);                 // ...so what it displaced is live again
        }
    } else {
        // Not live. It may become live — but only through the same rule every
        // other path uses, so it can never displace a newer message.
        commitCode(sms, code);
    }

    broadcast('sms_update', sms, { userId: sms.userId });
    return { recipient: sms.recipient, code: code || null };
}

/**
 * Extract codes for messages that arrived before the config did.
 *
 * =============================================================================
 * OLDEST FIRST, THROUGH commitCode — AND BOTH HALVES OF THAT MATTER.
 *
 * This used to run its own copy of addSms's supersede loop, and the copy had
 * drifted in two ways:
 *
 *   1. Its supersede marked EVERY other pending message for the number — which,
 *      inside one held-back batch, includes the NEWER ones not yet processed.
 *      They were then skipped as "not pending", so the OLDEST message in the
 *      batch won. Verified: 111111 then 445566 during the window -> /get served
 *      111111.
 *   2. It ignored `stale`, so a four-minute-old queue replay arriving during a
 *      cold start could take over a fresh code — the exact thing addSms refuses.
 *
 * commitCode carries the arrival order (seq) and the stale rule, and is the
 * same step addSms uses, so a held-back message now behaves exactly like a
 * normal one, just later.
 * =============================================================================
 */
function resolveDeferred() {
    if (deferredIds.size === 0) return;
    const ids = byArrival(Array.from(deferredIds));
    deferredIds.clear();

    let extracted = 0;
    const touched = new Set();
    for (const id of ids) {
        const sms = smsMap.get(id);
        if (!sms || sms.status !== 'pending') continue;
        if (convertIfInternal(sms)) continue;

        // Released by the CEILING rather than by the config arriving, so this is
        // still the catch-all reading it. Tracked so the real config can correct
        // it — including the "no code" answer, which the real filters may well
        // disagree with in either direction.
        if (configProvisional) provisionalIds.add(id);

        const code = extractCode(sms.message, sms.sender, sms.recipient, settings.filters);
        if (!code) continue;

        commitCode(sms, code);
        broadcast('sms_update', sms, { userId: sms.userId });
        touched.add(sms.recipient);
        extracted++;
    }
    // AFTER the whole batch — see reapplyBatch. A waiter woken mid-loop took the
    // older code of two held-back messages for the same number.
    for (const recipient of touched) notifyWaiters(recipient);
    flushRestored();
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

/**
 * Bumped by reloadDurable. A retry chain captures the value it started with and
 * stops as soon as it no longer matches — so a manual retry replaces the running
 * chains instead of racing them.
 */
let loadGeneration = 0;

/**
 * True once the boot load has been attempted.
 *
 * The extraction gate may only ever be closed by the FIRST load. A manual
 * "Retry now" calls the same function, and hasPersistedConfig() reads the
 * boot-time state file — it never becomes true after a dashboard save — so a
 * reload would otherwise shut the gate again for up to 3s, holding OTPs on a
 * server that has been running happily for hours.
 */
let bootLoadDone = false;

function scheduleRetry(kind, attempt, fn) {
    const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
    const generation = loadGeneration;
    const t = setTimeout(() => {
        // A "Retry now" since this was scheduled has already started fresh
        // chains. Without this, every impatient click during an outage left
        // another indefinite chain behind, all hammering Firestore.
        if (generation !== loadGeneration) {
            console.log(`[store] ${kind} retry superseded by a manual reload — stopping`);
            return;
        }
        fn();
    }, delay);
    if (typeof t.unref === 'function') t.unref();
    console.warn(`[store] ${kind} load attempt ${attempt} failed — retrying in ${delay / 1000}s`);
}

function loadIdentity(attempt) {
    attempt = attempt || 0;
    if (!usersEnabled()) return;
    if (attempt === 0) {
        users.setPersister(snap => {
            firestore.writeIdentity(snap);   // durable
            // Local cache only. `false` is the whole fix for the bug where a
            // phone registering itself pushed the in-memory config — which on a
            // fresh container is the env CATCH-ALL — over the operator's saved
            // filters in Firestore. See persistState's header.
            persistState(false);
        });
    }

    if (!firestore.isEnabled()) {
        console.warn('[store] USERS_ENABLED is on but Firestore is not — users and '
            + 'devices will be lost on restart. Set FIRESTORE_ENABLED=true.');
        // Nothing durable exists, so nothing can be overwritten: allow in-memory
        // use rather than refusing every change.
        //
        // ONLY THE FIRST TIME. "Retry now" calls this again, and load({}) CLEARS
        // the maps — with no Firestore behind it that wiped every user created
        // since boot, with nothing to reload them from. (Found while testing
        // 4.38.0's reload handling.)
        if (!users.isLoaded()) users.load({});
        loadState.identity.ok = true;
        return;
    }

    loadState.identity.attempts = attempt + 1;
    // A "Retry now" while this read is out starts a newer one. This answer is
    // then OLDER: applying it would reload the users from a snapshot taken
    // before changes made since, and keep a second retry chain alive
    // (audit, 4.42.1).
    const gen = loadGeneration;
    firestore.readIdentity().then(result => {
        if (gen !== loadGeneration) return;
        if (!result.ok) {
            // DO NOT load — users.load() clears the maps, and the next automatic
            // change would push that empty set to Firestore. Accounts stay
            // untouched in Firestore; we simply try again.
            loadState.identity.lastError = firestore.getStatus().lastError || 'read failed';

            // Serve from the local cache so the system still WORKS while we keep
            // trying. loadCache leaves the state read-only — we will not write
            // a cache we are not sure is current back over Firestore.
            if (attempt === 0 && persisted.identity && !users.isLoaded()) {
                const n = users.loadCache(persisted.identity);
                reclassifyInternal();
                console.warn(`[store] Firestore unreadable — serving ${n.users} user(s) `
                    + `and ${n.devices} device(s) from the LOCAL CACHE. Read-only until a `
                    + `read succeeds; your Firestore data is untouched.`);
            }
            scheduleRetry('Identity', attempt + 1, () => loadIdentity(attempt + 1));
            return;
        }
        // Memory holds a change not yet written (a user created a moment ago):
        // the document just read is OLDER, and users.load() would replace
        // memory with it (audit, 4.42.1). Keep memory; its write is on the way.
        if (users.isLoaded() && firestore.getStatus().pendingIdentity) {
            console.warn('[store] Identity changed here since the read began — keeping memory');
            loadState.identity.ok = true;
            loadState.identity.lastError = null;
            return;
        }
        const n = users.load(result.data || {});
        loadState.identity.ok = true;
        loadState.identity.lastError = null;
        console.log(`[store] Identity loaded: ${n.users} user(s), ${n.devices} device(s)`);
        // Now we know which numbers are ours (review #6).
        reclassifyInternal();
    }).catch(e => {
        if (gen !== loadGeneration) return;
        loadState.identity.lastError = e.message;
        scheduleRetry('Identity', attempt + 1, () => loadIdentity(attempt + 1));
    });
}

function loadDurableConfig(attempt) {
    const firstEver = !bootLoadDone;
    bootLoadDone = true;
    if (!firestore.isEnabled()) {
        markConfigReady();
        loadState.config.ok = true;
        return;
    }

    // Close the gate ONLY now, and only when there is no local config to trust.
    // With a state file present the real filters are already live, so there is
    // nothing to wait for and nothing may be deferred.
    //
    // AND ONLY ON THE FIRST LOAD. A manual "Retry now" calls this again, and
    // hasPersistedConfig() reads the BOOT-TIME state file — it never becomes
    // true after a dashboard save. So a reload would shut the gate again for up
    // to 3s, holding OTPs on a server that has been running happily for hours.
    // `attempt === 0` does NOT distinguish these: reloadDurable also calls
    // loadDurableConfig(0). Only the very first invocation may close the gate.
    if (firstEver && !hasPersistedConfig()) {
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
                + `${MAX_DEFERRAL_MS}ms — proceeding on ${configSource}. Codes read `
                + `from here until it lands are PROVISIONAL and will be corrected.`);
            // Order matters: the flag has to be set before resolveDeferred runs,
            // or the messages the ceiling releases are not tracked at all.
            configProvisional = true;
            markConfigReady();
        }
    }, MAX_DEFERRAL_MS);
    if (typeof ceiling.unref === 'function') ceiling.unref();

    loadState.config.attempts = (attempt || 0) + 1;
    const gen = loadGeneration;
    firestore.readConfig().then(result => {
        clearTimeout(ceiling);
        // A "Retry now" started a newer read: this one's answer (and its retry
        // chain) is superseded.
        if (gen !== loadGeneration) return;

        if (result.ok && result.data) {
            const docAt = Number(result.data.updatedAt) || 0;
            const keep = Object.keys(localChangedAt).filter(k => localChangedAt[k] > docAt);
            if (!keep.length) {
                applyConfig(result.data, 'Firestore');
            } else {
                // Changed here after this document was written: those fields
                // stay; the rest come from the document. Then the MERGED config
                // is written — the save queued meanwhile carried this process's
                // older (maybe catch-all) copy of the other fields.
                const cfg = Object.assign({}, result.data);
                for (const k of keep) delete cfg[k];
                console.warn(`[store] Firestore config is older than this dashboard's change to `
                    + `${keep.join(', ')} — keeping those, taking the rest from Firestore`);
                applyConfig(cfg, 'Firestore');
                persistState(true);
            }
            loadState.config.ok = true;
            loadState.config.lastError = null;
            return;
        }
        // A FAILED read is not a final answer — a retry may still land a real
        // config — so the window stays open and anything read meanwhile stays
        // correctable. A successful read that found no document IS final:
        // nothing is coming, so endProvisional() below settles it.
        if (!result.ok) configProvisional = true;
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
        // The read SUCCEEDED and there is genuinely no document. Whatever is in
        // memory is the final config, so anything read during the window was
        // read correctly after all — this settles it and clears the set.
        endProvisional();

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
            autoDeleteMinutes: settings.autoDeleteMinutes,
            filterExamples:    settings.filterExamples
        }, 'migration').catch(() => { /* logged inside */ });
    }).catch(e => {
        clearTimeout(ceiling);
        if (gen !== loadGeneration) return;   // superseded by a manual reload
        configProvisional = true;   // a retry follows — see the .then branch
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
    const client = { res, userId: session.userId, role: session.role, session };
    sseClients.add(client);
    res.on('close', () => sseClients.delete(client));
}

/**
 * May this stream still receive anything? The session it was opened under
 * must still exist (not logged out, not revoked, not expired) and its account
 * must still be active. Checked on every broadcast and heartbeat: a stream
 * outlived deactivation and kept receiving every OTP for that user's phones
 * (audit, 4.42.1 — reproduced).
 */
function streamAllowed(client) {
    const s = client.session;
    if (s && s.revoked) return false;
    if (s && s.expiresAt && s.expiresAt <= Date.now()) return false;
    if (usersEnabled() && client.role !== 'admin' && !users.isActive(client.userId)) return false;
    return true;
}

function endStream(client) {
    sseClients.delete(client);
    try { client.res.end(); } catch (e) { /* already gone */ }
}

/** Close every stream whose session or account has gone. */
function closeDeadStreams() {
    for (const client of sseClients) if (!streamAllowed(client)) endStream(client);
}

/** A session leaves the map: anything opened under it must stop too. */
function retireSession(token, s) {
    if (s) s.revoked = true;
    sessions.delete(token);
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
        if (!streamAllowed(client)) { endStream(client); continue; }
        // skipAdmins: a second copy aimed at one more user, whose first copy
        // every admin has already received (the outbox, 4.41.0).
        if (audience && audience.skipAdmins && client.role === 'admin') continue;
        if (audience && client.role !== 'admin') {
            if (audience.adminOnly) continue;
            if (audience.userId && audience.userId !== client.userId) continue;
        }
        sseWrite(client, msg);
    }
}

/**
 * Write to one stream — or END it when it has stopped reading.
 *
 * A tab that is frozen, asleep or on a dead connection still looks open, and
 * Node buffers everything written to it until TCP gives up (~15 min on Linux).
 * Measured by review (4.43.1): about 13 MB per stalled stream under load, on a
 * 512 MB instance. Past SSE_MAX_BUFFER it is ended; a live dashboard
 * reconnects and resyncs by itself.
 */
const SSE_MAX_BUFFER = 1024 * 1024;
function sseWrite(client, chunk) {
    try {
        if (client.res.writableLength > SSE_MAX_BUFFER) {
            console.warn(`[sse] dropping a stream that stopped reading (${client.res.writableLength} bytes queued)`);
            // destroy, not end: end() queues behind the very buffer that is
            // the problem and holds it until TCP gives up.
            sseClients.delete(client);
            try { client.res.destroy(); } catch (e) { /* already gone */ }
            return;
        }
        client.res.write(chunk);
    } catch (e) { sseClients.delete(client); }
}

// Keep SSE connections alive with heartbeat every 30s
setInterval(() => {
    for (const client of sseClients) {
        if (!streamAllowed(client)) { endStream(client); continue; }
        sseWrite(client, ': heartbeat\n\n');
    }
}, 30_000).unref?.();

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

/**
 * Single-use, short-lived tickets for the SSE stream.
 *
 * =============================================================================
 * EventSource CANNOT SET HEADERS, SO THE TOKEN WAS IN THE URL
 *
 * Referrer-Policy: no-referrer covers the browser, but Render's access logs and
 * any proxy in front record the full path — so a session token good for twelve
 * hours ended up in log storage nobody was thinking about.
 *
 * A ticket is exchanged for a stream ONCE, dies on use, and expires in thirty
 * seconds. Appearing in a log is then worth nothing.
 * =============================================================================
 */
const streamTickets = new Map();   // ticket -> { userId, role, expiresAt }
const TICKET_TTL_MS = 30_000;

function issueStreamTicket(session) {
    const ticket = crypto.randomBytes(24).toString('hex');
    streamTickets.set(ticket, {
        userId: session.userId, role: session.role, expiresAt: Date.now() + TICKET_TTL_MS,
        session                     // the stream lives exactly as long as this session
    });
    // Cheap sweep; tickets are few and die quickly.
    const now = Date.now();
    for (const [t, v] of streamTickets) if (v.expiresAt <= now) streamTickets.delete(t);
    return ticket;
}

/** Redeems and destroys. A replayed ticket is simply not there. */
function redeemStreamTicket(ticket) {
    if (!ticket || typeof ticket !== 'string') return null;
    const v = streamTickets.get(ticket);
    if (!v) return null;
    streamTickets.delete(ticket);
    if (v.expiresAt <= Date.now()) return null;
    if (usersEnabled() && !users.isActive(v.userId)) return null;
    if (v.session && v.session.revoked) return null;
    return v.session || { userId: v.userId, role: v.role };
}

function pruneSessions() {
    const now = Date.now();
    for (const [t, s] of sessions) if (s.expiresAt <= now) retireSession(t, s);
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
async function login(password, username) {
    const name = String(username || '').trim();

    if (!name || users.slug(name) === users.ADMIN_ID) {
        const expected = process.env.DASHBOARD_PASSWORD || '';
        if (!expected) return null;
        if (typeof password !== 'string' || !safeEqual(password, expected)) return null;
        return issueToken(users.ADMIN_ID, 'admin');
    }

    if (!usersEnabled()) return null;
    const who = await users.authenticate(name, password);
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
    if (s.expiresAt <= Date.now()) { retireSession(token, s); return null; }
    if (usersEnabled() && !users.isActive(s.userId)) {
        retireSession(token, s);
        console.warn(`[store] Session rejected — account "${s.userId}" is deactivated`);
        return null;
    }
    return s;
}

/** Kill every session belonging to one user. Used the instant they are deactivated. */
function revokeSessionsFor(userId) {
    let n = 0;
    for (const [t, s] of sessions) if (s.userId === userId) { retireSession(t, s); n++; }
    closeDeadStreams();
    return n;
}

/** Logout, and it means it — the token stops working server-side, and so does its stream. */
function revokeToken(token) {
    if (!token) return false;
    const s = sessions.get(token);
    if (!s) return false;
    retireSession(token, s);
    closeDeadStreams();
    return true;
}

function validateToken(token) {
    return getSession(token) !== null;
}

// ═════════════════════════════════════════════════════════════════
// IDEMPOTENCY — the same SMS pushed twice is stored once
// ═════════════════════════════════════════════════════════════════
//
// THE CASE THIS EXISTS FOR, WHICH NOTHING ELSE COVERS:
//
// The phone pushes an SMS, the server stores it, and the REPLY is lost — the
// radio dropped, the process was killed, the socket timed out one millisecond
// after the write. The device never learns it succeeded, so the queue row stays
// claimed, ages out, and the flush pushes the identical message again.
//
// Every defence for this lived on the DEVICE — the claim, the stale window, the
// forward log. That is the wrong side: the device cannot know what the server
// did with a reply it never received. The server can, and it is the only party
// that can, so this is where it belongs.
//
// WHY A DUPLICATE IS NOT HARMLESS. addSms mints a fresh id and supersedes, so a
// re-push of a code that has ALREADY BEEN FETCHED installs it again with
// consumed:false — handing the same OTP out a second time, and marking the
// first copy "superseded" in the archive. It also re-broadcasts and re-arms the
// expiry. None of that is what "the same message arrived twice" should mean.
//
// The id is computed by the phone from deviceId + sender + body + arrivedAt, so
// it is DETERMINISTIC: the live push, its own retry, the queue flush and Get
// Latest all produce the same value for the same SMS with no state to keep.
// Two genuinely distinct messages matching on all four are the same SMS for
// every purpose this server has.
//
// TTL is 10 minutes: comfortably past QueueFlusher's 5-minute useful window
// plus its 180s claim, so every re-push that could still legitimately arrive is
// caught, and nothing is remembered for longer than it can matter. An older app
// sends no msgId and is simply not deduplicated, exactly as today.
const seenMessages = new Map();   // msgId -> { id, code, at }
const SEEN_TTL_MS  = 10 * 60_000;
const SEEN_MAX     = 5000;        // bound, like every other map here

function rememberMessage(msgId, id, code) {
    // Insertion-ordered, so the front is the oldest. The 60s sweep normally
    // keeps this far below the cap; this is the flood case.
    // Delete before set: re-setting an existing key keeps its ORIGINAL position
    // in a Map while updating the value, which would break pruneSeen's
    // insertion-order assumption below the moment a long-expired id came back.
    seenMessages.delete(msgId);
    if (seenMessages.size >= SEEN_MAX) {
        for (const k of seenMessages.keys()) {
            seenMessages.delete(k);
            if (seenMessages.size < SEEN_MAX) break;
        }
    }
    seenMessages.set(msgId, { id, code: code || null, at: Date.now() });
}

function pruneSeen() {
    if (seenMessages.size === 0) return;
    const cutoff = Date.now() - SEEN_TTL_MS;
    for (const [k, v] of seenMessages) {
        if (v.at > cutoff) break;   // insertion-ordered: everything after is newer
        seenMessages.delete(k);
    }
}

// ─── SMS operations ─────────────────────────────────────────────

/**
 * @param {string} [deviceId] which phone sent this. Optional: an older app sends
 *        none, and I8 says it must keep working — see ownerOf().
 */
/**
 * Is this pending message from one of our own SIMs after all? (review #6)
 *
 * addSms decides at arrival. On a cold start the device list may not have
 * loaded yet, so a message from our own SIM can arrive looking ordinary and be
 * held back for the config. EVERY later extraction point asks again before a
 * code can go live — resolveDeferred and reapplyExtraction — and the identity
 * load re-checks everything still pending (reclassifyInternal). A message found
 * to be internal becomes exactly what addSms would have made it.
 *
 * @returns {boolean} true when it was converted (the caller must not extract).
 */
function convertIfInternal(sms) {
    if (!sms || sms.status !== 'pending') return false;
    const c = canonicalizePhone(sms.sender);
    if (!/^01[0-9]{9}$/.test(c) || !users.isSystemNumber(c)) return false;
    const entry = numberMap.get(sms.recipient);
    const wasLive = !!(entry && entry.smsKey === sms.id);
    if (wasLive) numberMap.delete(sms.recipient);
    sms.status = 'internal';
    sms.internal = true;
    sms.code = '';
    sms.extractedCode = null;
    deferredIds.delete(sms.id);
    provisionalIds.delete(sms.id);
    console.warn(`[store] ${sms.id} from ${sms.sender} is from our own SIM — now INTERNAL, never an OTP`);
    broadcast('sms_update', sms, { userId: sms.userId });
    // Its code had superseded a real OTP: that one is live again.
    if (wasLive) restoreSuperseded(sms);
    return true;
}

/** After identity loads: anything still pending from our own SIMs is internal. */
function reclassifyInternal() {
    let n = 0;
    for (const sms of smsMap.values()) if (convertIfInternal(sms)) n++;
    flushRestored();
    if (n) console.warn(`[store] ${n} pending message(s) turned out to be from our own SIMs`);
    return n;
}

/** Called for every internal SMS — set by the outbox (server 4.41.0). */
let internalHook = null;
function setInternalHook(fn) { internalHook = fn; }

function addSms(sender, recipient, message, arrivedAt, deviceId, msgId) {
    // FIRST, before anything is stored, broadcast or superseded. A duplicate is
    // answered with the ORIGINAL result — same id, same code — so the device
    // marks its row delivered and stops, which is the whole point.
    if (msgId) {
        const prior = seenMessages.get(String(msgId));
        if (prior && Date.now() - prior.at <= SEEN_TTL_MS) {
            console.log(`[store] Duplicate push ${msgId} — already stored as ${prior.id}, `
                + `nothing re-stored`);
            // Read the code LIVE where the message is still here: one stored
            // during the cold-start window was remembered with no code and has
            // since been extracted, and answering with the stale null would
            // under-report it.
            const live = smsMap.get(prior.id);
            return { id: prior.id,
                     code: live ? (live.extractedCode || null) : prior.code,
                     duplicate: true };
        }
    }

    // Same reason as extractCode: a JSON body can carry any type. Normalise at
    // the boundary so nothing downstream has to defend itself.
    sender    = sender    == null ? '' : String(sender).slice(0, MAX_SENDER_CHARS);
    recipient = recipient == null ? '' : String(recipient).slice(0, MAX_SENDER_CHARS);
    message   = message   == null ? '' : String(message);
    // A device id is a short token; anything else (an object, an array, 5 KB)
    // is dropped at the door — it reached the archive and stopped it (review,
    // 4.43.1). Unknown/absent ids behave exactly as before.
    deviceId = (typeof deviceId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) ? deviceId : null;
    // A real SMS is at most a few thousand characters; the JSON limit is 100 KB.
    // Bodies near that made extraction and Teach block the event loop for
    // seconds and let 5,000 messages hold ~500 MB (review, 4.43.1). Kept, cut.
    if (message.length > MAX_MESSAGE_CHARS) message = message.slice(0, MAX_MESSAGE_CHARS);

    const id        = crypto.randomBytes(8).toString('hex');
    const serverNow = Date.now();                              // FIX #2: always use server time for timing
    let normRecip   = canonicalizePhone(recipient || 'Unknown'); // FIX #3: normalize recipient
    // True when the number came from the device record rather than from the SMS.
    // Display only — the dashboard says so, nothing decides anything on it.
    let recipientFromDevice = false;

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
    //
    // ═════════════════════════════════════════════════════════════
    // BUT AN Unknown- KEY IS UNFETCHABLE, AND THAT WAS THE WHOLE COST.
    //
    // Every script asks GET /get?number=01XXXXXXXXX. Nothing is stored under
    // that key, so the message sat on the dashboard, looking delivered, and no
    // fetch could ever reach it — indistinguishable from "the SMS never came".
    // The disambiguation was right; having no way out of it was not.
    //
    // users.simFor() is the way out: the number a human typed in once for this
    // phone, because it is the only place that number exists. When it is set,
    // the message is filed under the REAL number and behaves like any other —
    // same index, same waiters, same supersede, same /get. When it is not, we
    // fall back to the device key exactly as before rather than guess.
    // ═════════════════════════════════════════════════════════════
    // ─────────────────────────────────────────────────────────────
    if (normRecip === 'Unknown' && deviceId) {
        // NOT gated on usersEnabled(), unlike ownerOf below. The device map is
        // empty when identity was never loaded, so simFor() answers null by
        // itself — and gating it would mean turning USERS_ENABLED off silently
        // un-fetched every phone whose number an admin had already supplied.
        const known = users.simFor(deviceId);
        if (known) {
            normRecip = known;                 // already canonical — users.setDeviceSim
            recipientFromDevice = true;
        } else {
            normRecip = unknownKey(deviceId);
        }
    }

    // ═════════════════════════════════════════════════════════════
    // THE OTP COLLISION GUARD (server 4.41.0, approved by Riad)
    //
    // An SMS FROM one of our own SIMs — the dashboard's Send SMS, or anyone
    // texting between two of our phones — is never an OTP. Filed as an ordinary
    // message it would go through commitCode and SUPERSEDE whatever code is
    // live on the receiving number: the exact loss this system exists to
    // prevent.
    //
    // It is stored with status 'internal' and NO code, from birth. Every path
    // that extracts or serves a code — commitCode here, the cold-start release,
    // the filter re-read, getOtp's fallback, the end-of-window sweep — acts only
    // on status 'pending', so this one status keeps it out of all of them at
    // once. No second supersede rule, no new branch in any of those paths.
    //
    // A Set lookup (users.isSystemNumber); nothing here may touch the network.
    // ═════════════════════════════════════════════════════════════
    const senderCanon = canonicalizePhone(sender);
    const internal = /^01[0-9]{9}$/.test(senderCanon) && users.isSystemNumber(senderCanon);

    // Cold-start window only: the durable config has not landed yet, so the
    // filters currently in memory are the CATCH-ALL and would extract the wrong
    // digits. Store, forward and broadcast exactly as normal — only the
    // extraction waits. See the deferred-extraction block above.
    const defer     = !configReady && !internal;
    const detailed  = (defer || internal) ? { code: null, rule: null, pattern: null }
                            : extractDetailed(message, sender, normRecip, settings.filters);
    const code      = detailed.code;
    // FIX #2: deleteAt based on server clock. Never BEFORE the OTP window ends
    // (audit, 4.42.1): auto-delete may be 1 min while a code stays fetchable
    // for OTP_MAX_AGE_SECONDS (120 s default, up to 600) — the sweep removed a
    // live code, and the archive called it expired.
    const deleteAt  = serverNow + Math.max(settings.autoDeleteMinutes * 60_000, MAX_OTP_AGE_MS);

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
        // The SIM could not name itself; this number is the one set on the
        // device. Worth showing, because it is the one recipient on the board
        // that was not read off the message.
        recipientFromDevice,
        code:           code || '',
        extractedCode:  code || null,
        receivedAt:     serverNow,        // authoritative — server clock
        arrivedAt:      deviceArrivedAt,  // informational — device clock
        deleteAt,
        // 'internal' = from one of our own SIMs; see the collision guard above.
        status:         internal ? 'internal' : 'pending',
        internal,
        viewedAt:       null,
        // Strict arrival order — see seqCounter. Decides "newer" everywhere.
        seq:            ++seqCounter,
        // A dashboard Test message. Lowest priority — see commitCode.
        test:           sender === TEST_SENDER
    };

    smsMap.set(id, sms);
    indexAdd(sms);
    enforceSizeCap();

    if (defer) {
        deferredIds.add(id);
        console.warn(`[store] ${id} held for the real config — extraction deferred`);
    } else if (configProvisional && !internal) {
        // The gate has opened on the CEILING, not on the config arriving — this
        // is the larger population, since the window runs from 3s until the read
        // settles. Read with the catch-all now so nothing is held up; corrected
        // by reconcileProvisional the moment the real config lands.
        provisionalIds.add(id);
    }

    // ═════════════════════════════════════════════════════════════
    // A MESSAGE OLDER THAN THE OTP WINDOW MAY NOT SUPERSEDE ANYTHING
    //
    // QueueFlusher will replay a message for up to 5 minutes, deliberately, so
    // that one delayed by a cold start still arrives. The server had no matching
    // guard: addSms superseded unconditionally and stamped a fresh receivedAt,
    // so a four-minute-old replay took over the live OTP for that number AND got
    // a further two minutes of life as the current one.
    //
    // Verified: a real code 445566 arrived, then a 4-minute-old replay of 111111
    // was pushed, and /get returned 111111.
    //
    // The message is still STORED, broadcast and archived — it is evidence, and
    // the dashboard should show it. It simply may not become the live code, and
    // getOtp's fallback scan skips it for the same reason.
    //
    // arrivedAt is the DEVICE clock, so an implausible value (skewed, or from
    // the future) is not trusted — the same fail-open rule SmsReceiver applies
    // to the SMSC timestamp. Only a plausibly-old message is held back.
    // ═════════════════════════════════════════════════════════════
    const age = serverNow - deviceArrivedAt;
    const plausible = age > -60_000 && age < 24 * 3600_000;
    const stale = plausible && age > MAX_OTP_AGE_MS;
    if (stale) sms.stale = true;
    // Whether this phone's arrivedAt may be compared with another's from the
    // same phone (commitCode rule 4). Same trust window as `stale`.
    sms.arrivalTrusted = plausible;

    if (code && stale) {
        console.warn(`[store] ${id} is ${Math.round(age / 1000)}s old — stored but NOT `
            + `superseding: a replay must not take over a live OTP`);
    }

    // SUPERSEDE and install as the live code — the one shared step. Stale,
    // test and arrival-order rules all live inside it.
    if (code) commitCode(sms, code);
    // No code: maybe a format change. Checked a few seconds from now.
    else if (!internal && !sms.test) scheduleUnreadCheck(id, 0);

    // Universal extracted a code with no sender rule — schedule a suggestion
    // check so the dashboard can offer a one-click "Add rule" for this sender.
    if (code && !defer && detailed.pattern === '@universal') {
        scheduleSuggestionCheck(id);
    }

    broadcast('sms_new', sms, { userId: sms.userId });
    console.log(`[store] ${id} from=${sender} to=${normRecip} code=${code || '(none)'}`
        + (internal ? ' — INTERNAL (from our own SIM, never an OTP)' : ''));
    // Lets the outbox mark a dashboard-sent SMS as received on the other phone.
    // Synchronous and in memory; a failure here must never fail the store.
    if (internal && typeof internalHook === 'function') {
        try { internalHook(senderCanon, normRecip, message, serverNow); }
        catch (e) { console.warn('[store] internal hook failed:', e && e.message); }
    }

    // LAST, and only with a code: everything above must be committed before a
    // parked fetch is allowed to consume it. This is the step that removes the
    // polling interval from the end-to-end latency.
    if (code) notifyWaiters(normRecip);

    // AFTER everything is committed. Remembering earlier would mean a duplicate
    // arriving mid-store could be answered with an id whose message is not yet
    // on the board.
    if (msgId) rememberMessage(String(msgId), id, code);

    return { id, code };
}

/**
 * Record a message's code and, if it is entitled to, make it THE live code for
 * its number — superseding older pending messages on the way.
 *
 * =============================================================================
 * THE ONE PLACE "NEWEST WINS" IS DECIDED.
 *
 * There used to be three copies of this step — addSms, the cold-start release
 * (resolveDeferred) and the provisional correction — and they had drifted: the
 * copies ignored `stale`, and the deferred one let the OLDEST message in a batch
 * win. Every path now calls this, so the rules below hold everywhere at once.
 *
 * THE RULES, in order:
 *   1. A STALE message (a replay older than the OTP window) never becomes live
 *      and never supersedes. It can still be served by getOtp's fallback when
 *      nothing else exists for the number — see the note there.
 *   2. Nothing displaces a NEWER message. Order is `seq`, not a clock.
 *   3. A Test message never displaces a LIVE REAL code, and never supersedes a
 *      real message. Any real SMS does displace a test. So Test still proves the
 *      whole pipeline on an idle number (a fetch returns the test code), but
 *      pressing it can no longer destroy an OTP someone is waiting for.
 *      Verified before this: a live IVAC 445566, then Test -> /get served the
 *      test code.
 *   4. From the SAME phone, a message the phone itself says arrived EARLIER
 *      never displaces one it says arrived later. seq is the order the SERVER
 *      heard them in; a re-push (queue retry, Get Latest, an older app without
 *      a stable msgId) is heard late but happened early. Comparing arrivedAt is
 *      only sound within one device — one clock — so across devices seq rules.
 *
 * Does NOT broadcast the message itself or wake waiters: the caller does both,
 * after everything is committed, because a woken waiter consumes immediately.
 *
 * @returns {boolean} true if the message became the live code.
 * =============================================================================
 */
function commitCode(sms, code) {
    sms.code          = code || '';
    sms.extractedCode = code || null;
    if (!code) return false;

    if (sms.stale) {                                                     // rule 1
        // Never live. It stays eligible for getOtp's fallback ("better than
        // nothing when there is nothing") — unless a code that arrived AFTER it
        // has already gone live, in which case it is not "nothing", it is old.
        if (laterWentLive(sms)) refuse(sms, 'a later code for this number already went live');
        return false;
    }

    const entry = numberMap.get(sms.recipient);
    if (entry) {
        if ((entry.seq || 0) > sms.seq) {                                // rule 2
            refuse(sms, 'a newer message is already the live code');
            return false;
        }
        if (sms.test && !entry.test && !entry.consumed
                && Date.now() - (entry.ts || 0) <= MAX_OTP_AGE_MS) {     // rule 3
            refuse(sms, 'a real code is live — a Test never displaces one');
            return false;
        }
        if (sameDeviceAndLater(entry, sms)) {                            // rule 4
            refuse(sms, 'it arrived on the phone before the live code');
            return false;
        }
    }

    // Indexed — touches only this recipient's messages, normally one or zero.
    for (const oldSms of messagesFor(sms.recipient)) {
        if (oldSms.id === sms.id || oldSms.status !== 'pending') continue;
        // A message with no code was never in the running: it finishes as
        // no_code. Marking it "superseded" counted every promo before an OTP
        // against the fetch rate (review, 4.43.1).
        if (!oldSms.extractedCode) continue;
        if (oldSms.seq > sms.seq) continue;                              // rule 2
        if (sms.test && !oldSms.test) continue;                          // rule 3
        if (sameDeviceAndLater(oldSms, sms)) continue;                   // rule 4
        oldSms.status = 'superseded';
        oldSms.supersededBy = sms.id;          // undone if sms turns out to have no code
        history.record(oldSms, 'superseded');
        broadcast('sms_update', oldSms, { userId: oldSms.userId });
    }

    numberMap.set(sms.recipient, liveEntry(sms, code, false));
    markLive(sms);
    return true;
}

/**
 * A message commitCode would not make live is FINISHED, not waiting.
 *
 * =============================================================================
 * LEFT 'pending', A REFUSED MESSAGE WAS SERVED LATER.
 *
 * It reached the server after the live code, so its window closes later too.
 * Once the live entry aged out, getOtp's fallback found it — pending, with a
 * code — and served it: a code OLDER than one already spent, or a Test code to
 * a script waiting for its next real OTP. Found by an independent review of
 * 4.37.0 and reproduced. It is superseded at the moment it is refused, which is
 * also the true outcome for the archive (it was "expired" before, which counted
 * against the fetch rate).
 *
 * The caller broadcasts the message, so the status goes out with it.
 * =============================================================================
 */
function refuse(sms, why) {
    if (sms.status !== 'pending') return;
    sms.status = 'superseded';
    history.record(sms, 'superseded');
    console.warn(`[store] ${sms.id} for ${sms.recipient} not made live — ${why}`);
}

// ─── The last message that went live, per number ────────────────
//
// numberMap forgets a number when its entry ages out, so it cannot answer "has
// anything NEWER than this message already been served here?" once the window
// has passed — which is exactly when getOtp's fallback looks. This remembers the
// newest message that went live for each number for as long as that number has
// any message in memory (cleared in removeSms / clearAll).
const lastLive = new Map();   // recipient -> { seq, deviceId, arrivedAt, receivedAt, arrivalTrusted }

function markLive(sms) {
    const prev = lastLive.get(sms.recipient);
    if (prev && prev.seq > sms.seq) return;
    lastLive.set(sms.recipient, {
        seq: sms.seq, deviceId: sms.deviceId || null, arrivedAt: sms.arrivedAt,
        receivedAt: sms.receivedAt, arrivalTrusted: !!sms.arrivalTrusted
    });
}

/**
 * Has a message that ARRIVED after `sms` already gone live on its number?
 *
 * Same phone, both clocks plausible: compare the phone's own arrival times.
 * Otherwise, when this message's arrival time is plausible: compare it with the
 * server time the live one was received. Otherwise only server order is known.
 */
function laterWentLive(sms) {
    const L = lastLive.get(sms.recipient);
    if (!L || L.seq === sms.seq) return false;
    if (sms.deviceId && L.deviceId === sms.deviceId && L.arrivalTrusted && sms.arrivalTrusted) {
        return Number(L.arrivedAt) > Number(sms.arrivedAt);
    }
    if (sms.arrivalTrusted) return Number(L.receivedAt) > Number(sms.arrivedAt);
    return L.seq > sms.seq;
}

/** The numberMap entry for a message. Server clock for ts, never the device's. */
function liveEntry(sms, code, consumed) {
    return {
        otp: code, smsKey: sms.id, ts: sms.receivedAt, consumed: !!consumed,
        seq: sms.seq, test: !!sms.test,
        deviceId: sms.deviceId || null, arrivedAt: sms.arrivedAt,
        arrivalTrusted: !!sms.arrivalTrusted
    };
}

/**
 * Rule 4 of commitCode: `other` came from the same phone as `sms` and that
 * phone's own clock says `other` arrived later. False whenever either side has
 * no device id — older apps send none, and two unknown phones share no clock.
 */
function sameDeviceAndLater(other, sms) {
    // Only when BOTH arrival times are plausible (within addSms's trust window)
    // and NEITHER was stamped ahead of the server. A phone whose clock ran
    // ahead and was then corrected (NTP) stamps its next real OTP EARLIER than
    // the one it stamped in the future, so that OTP was refused and the old
    // code served (review, 4.43.1 — a clock 50 s fast was still "trusted"). A
    // message cannot arrive on the phone after the server received it.
    return !!(other && sms.deviceId && other.deviceId === sms.deviceId
              && other.arrivalTrusted && sms.arrivalTrusted
              && !stampedAhead(other) && !stampedAhead(sms)
              && Number(other.arrivedAt) > Number(sms.arrivedAt));
}

/** The phone's arrival time is later than the server's receipt (+5 s slack). */
const AHEAD_SLACK_MS = 5000;
function stampedAhead(x) {
    const received = Number(x.receivedAt !== undefined ? x.receivedAt : x.ts) || 0;
    return received > 0 && Number(x.arrivedAt) - received > AHEAD_SLACK_MS;
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

/**
 * Absolute ceiling on parked requests. A pure memory bound, nothing else.
 *
 * =============================================================================
 * WAS 200, AND THAT WAS THE WRONG SIZE FOR THE WRONG REASON.
 *
 * 200 was picked as "a map of parked requests must not grow without bound",
 * which is true — but it made a SHARED pool out of something that has no
 * business being shared. Requests for DIFFERENT numbers do not interact in any
 * way: notifyWaiters() only ever touches waiters.get(thatRecipient), and getOtp
 * is a Map lookup. Yet a global cap of 200 means number B can be answered
 * `busy` because of number A, which is the one coupling the design does not
 * otherwise have.
 *
 * The real cost of a waiter is the open HTTP connection, and that exists
 * whether or not we park it — Node and the host bound concurrent sockets long
 * before this number does. What is left is a Set entry, a closure and a timer.
 * So the ceiling can be an order of magnitude higher without costing anything,
 * and with the per-number cap below doing the actual protecting, the global one
 * stops binding in normal operation at all.
 *
 * Sized so it cannot bind in this deployment: 1000 global against 5 per number
 * is 200 DISTINCT numbers all at full per-number quota simultaneously, against
 * a fleet of at most ~100 SIMs. Every number that shows up gets a slot.
 * =============================================================================
 */
const MAX_WAITERS = Math.max(1,
    parseInt(process.env.MAX_WAITERS || '1000', 10) || 1000);

/**
 * Per-number ceiling, ON TOP of the global one.
 *
 * =============================================================================
 * ONE NUMBER MUST NOT BE ABLE TO TAKE EVERY SLOT.
 *
 * The global cap stops the map growing without bound, and that is all it does.
 * It says nothing about WHOSE requests filled it — so a single script looping
 * `?number=X&wait=25` occupies all 200 slots within seconds, and every OTHER
 * number is answered `busy` for as long as that lasts. That is not a hypothesis
 * about an attacker: /get is unauthenticated by design and is called from
 * Tampermonkey and Python, and a script whose own retry loop has gone wrong
 * looks exactly like one.
 *
 * Legitimate demand for one number is small and knowable, and Riad has stated
 * it directly: several numbers are fetched at once, but the SAME number is not
 * fetched repeatedly at the same time. So one script plus the three gateway
 * aliases plus a retry is already the realistic ceiling, and 5 covers it with
 * room to spare.
 *
 * THIS is the cap that does the protecting, and it is deliberately SMALL so the
 * global one can be large. A tight per-number limit contains a runaway loop at
 * the number causing it within a handful of slots, which is what leaves the
 * global ceiling free to be high enough that a request for a different number
 * is never refused. The two numbers are chosen together: 5 x 200 distinct
 * numbers = the 1000 above.
 *
 * Clamped to the global cap: a per-number limit above it could never bind and
 * would just be a misleading number in the config.
 * =============================================================================
 */
const MAX_WAITERS_PER_NUMBER = Math.max(1, Math.min(MAX_WAITERS,
    parseInt(process.env.MAX_WAITERS_PER_NUMBER || '5', 10) || 5));

let waiterCount = 0;

/** How many requests are parked on this (already canonical) number. */
function waitersOn(normNumber) {
    const set = waiters.get(normNumber);
    return set ? set.size : 0;
}

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
        // Both caps are checked HERE as well as in serveOtp, deliberately. The
        // route checks first so it can answer `busy` rather than a zero-length
        // `timedOut`; this one is the invariant, so a future caller that forgets
        // to ask cannot grow the map past either limit.
        if (waiterCount >= MAX_WAITERS) {
            // Refuse to park rather than grow without bound. The caller falls
            // back to returning "no OTP", which is what a plain fetch does.
            console.warn(`[store] waiter limit (${MAX_WAITERS}) reached — not parking`);
            return resolve(null);
        }
        if (waitersOn(normNumber) >= MAX_WAITERS_PER_NUMBER) {
            console.warn(`[store] per-number waiter limit (${MAX_WAITERS_PER_NUMBER}) `
                + `reached for ${normNumber} — not parking. Other numbers are unaffected.`);
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
 * THE SAME rule the filter matcher uses (otp.senderClaimedBy), so "bKash",
 * "bkash" and "BKASH-16247" all match the token "bkash" — and a number token
 * such as "16216" matches as a number, not as any string containing it.
 */
function senderMatches(sender, tokens) {
    if (!tokens || tokens.length === 0) return true;      // unscoped: any sender
    return tokens.some(t => senderClaimedBy(t, sender));
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
    let entry = numberMap.get(normNumber);
    // The ONLY reason to stop serving it: it aged out. A newer SMS would have
    // replaced this entry outright, so whatever is here is the latest. Dropped,
    // and then the number has NO entry — so the fallback below runs now, as it
    // would on the next call. Returning null here made a parked /get?wait=,
    // woken by a fetchable replay, miss it and time out while a plain /get a
    // moment later returned it (audit, 4.42.1).
    if (entry && entry.otp && Date.now() - (entry.ts || 0) > MAX_OTP_AGE_MS) {
        numberMap.delete(normNumber);
        entry = null;
    }
    if (entry && entry.otp) {

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

    // ═════════════════════════════════════════════════════════════
    // A STALE MESSAGE IS ALLOWED HERE. THAT IS DELIBERATE, AND IT IS A
    // CORRECTION OF 4.29.0.
    //
    // Not superseding is the property that matters: a four-minute-old replay
    // must never take over a code that just arrived. That is enforced in
    // addSms, by refusing it the numberMap entry.
    //
    // But 4.29.0 ALSO excluded it here, and this path is only reached when
    // there is no live entry for the number at all. So the exclusion turned
    // "cannot overwrite a fresher code" into "cannot be delivered at all" —
    // in exactly the situation QueueFlusher's five-minute window exists for:
    // a cold start delayed the push, nothing else arrived, and the code was
    // still perfectly good. That is a MISSED OTP, which is the failure this
    // whole system is built to avoid.
    //
    // So: it can never win against something fresher, and it is still better
    // than nothing when there is nothing.
    // ═════════════════════════════════════════════════════════════
    // Never a message older than a code that has already gone live here: the
    // fallback is "better than nothing", and a spent newer code is not nothing.
    // receivedAt for the window, not arrivedAt: the fast path above expires on
    // server time. extractedCode is the code read when the message was stored
    // (or re-read when the config or filters changed — see reapplyExtraction);
    // re-running every regex here on every fetch was a steady cost for an answer
    // that could not have changed.
    const now = Date.now();
    const candidates = messagesFor(normNumber)
        .filter(sms => sms.status === 'pending' && senderMatches(sms.sender, senderTokens)
                       && !laterWentLive(sms) && sms.extractedCode
                       && now - sms.receivedAt <= MAX_OTP_AGE_MS);

    // ═════════════════════════════════════════════════════════════
    // THE NEWEST BY THE SAME RULES AS commitCode — NOT BY receivedAt.
    //
    // Two stale replays never go live (rule 1), so both wait here. Sorted by
    // the time the SERVER heard them, the older code won whenever the phone
    // re-pushed out of order — Get Latest pressed twice sends the newest
    // missed OTP first, then the older one — and on any same-millisecond tie.
    // Reproduced by review (4.43.1): /get served 111111 after 222222 arrived.
    // Same phone: its own arrival order (rule 4). Otherwise: server order (seq).
    // ═════════════════════════════════════════════════════════════
    let best = null;
    for (const c of candidates) {
        if (!best || sameDeviceAndLater(c, best) || (!sameDeviceAndLater(best, c) && c.seq > best.seq)) best = c;
    }

    for (const sms of best ? [best] : []) {
        const code = sms.extractedCode;

        // Consume: mark used, and record it as already-spent so a second fetch
        // takes the fast path above and correctly gets nothing.
        sms.status   = 'used';
        sms.viewedAt = Date.now();
        history.record(sms, 'fetched');
        numberMap.set(normNumber, liveEntry(sms, code, true));
        markLive(sms);
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
            if (sms.userId === userId) { removeSms(id, sms, true); n++; }
        }
        console.log(`[store] Cleared ${n} message(s) for ${userId}`);
        return n;
    }
    // ARCHIVE FIRST. The per-user path went through removeSms and was archived;
    // this one wiped the maps directly and recorded nothing — so an admin "Clear
    // all" erased exactly the messages you would want to look up afterwards.
    // The same fix applied in one place and not the parallel one, again.
    //
    // Recorded in a loop but broadcast ONCE: per-message sms_delete events here
    // would be a storm, and clear_all already tells every client to empty.
    let archived = 0;
    for (const sms of smsMap.values()) {
        if (sms.status === 'pending') { history.record(sms, 'cleared'); archived++; }
    }

    smsMap.clear();
    numberMap.clear();
    byRecipient.clear();
    lastLive.clear();
    // This path does not go through removeSms, so it has to say so itself —
    // the same parallel-path omission noted in the archive comment above.
    deferredIds.clear();
    provisionalIds.clear();
    broadcast('clear_all', {});
    console.log(`[store] All SMS cleared (${archived} pending message(s) archived)`);
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
        filters:           settings.filters,
        // How long a code is fetchable. The dashboard needs it to show when a
        // code stops being servable — which is NOT the auto-delete time.
        otpMaxAgeSeconds:  MAX_OTP_AGE_MS / 1000
    };
}

function setGlobalForwarding(enabled) {
    settings.globalForwarding = !!enabled;
    noteLocalChange('globalForwarding');
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
    // A REMOVED DEVICE FORWARDS NOTHING, AND THIS OUTRANKS EVERYTHING BELOW —
    // the global switch, an owner's override, the lot. Removing a phone on the
    // dashboard is the operator saying "not this one", and the server is the
    // only side that can make that true regardless of what the phone believes,
    // has been told, or has been force-stopped before hearing.
    //
    // Ungated by usersEnabled(): the map is empty when identity never loaded,
    // so isRevoked answers false by itself, and gating it would mean flipping
    // USERS_ENABLED off quietly un-revoked every phone anyone had removed.
    if (users.isRevoked(deviceId)) return false;

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
    // Scoped like every other stream event: a command aimed at one user goes
    // to that user and the admins, not to every signed-in user — it names who
    // was targeted.
    broadcast('settings_change', { key: 'clearLogTs', value: t, userId: userId || null },
              userId && userId !== users.ADMIN_ID ? { userId } : undefined);
    return t;
}

function triggerTestMessage(ts, userId) {
    const t = ts || Date.now();
    if (userId && userId !== users.ADMIN_ID) setTargeted(targeted.test, userId, t);
    else settings.testMessageTs = t;
    // Scoped like every other stream event: a command aimed at one user goes
    // to that user and the admins, not to every signed-in user — it names who
    // was targeted.
    broadcast('settings_change', { key: 'testMessageTs', value: t, userId: userId || null },
              userId && userId !== users.ADMIN_ID ? { userId } : undefined);
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
    // Scoped like every other stream event: a command aimed at one user goes
    // to that user and the admins, not to every signed-in user — it names who
    // was targeted.
    broadcast('settings_change', { key: 'fetchLatestTs', value: t, userId: userId || null },
              userId && userId !== users.ADMIN_ID ? { userId } : undefined);
    return t;
}

function setAutoDeleteMinutes(mins) {
    settings.autoDeleteMinutes = Math.max(1, Math.min(1440, parseInt(mins, 10) || 30));
    noteLocalChange('autoDeleteMinutes');
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

/**
 * @param {Array} filters
 * @param {Array} [examples] the taught examples to store WITH them (Teach) —
 *   one state write, one Firestore write, so the two can never disagree.
 */
function setFilters(filters, examples) {
    // Teach's write (filters + examples) only on the SAVED config — see
    // teachReady. The route checks first; this is the second lock.
    if (Array.isArray(examples) && !teachReady()) {
        throw new Error('Teach refused: the saved filters have not loaded yet');
    }
    if (Array.isArray(filters)) {
        filters = mergeFilterRules(filters);
        settings.filters = filters;
        noteLocalChange('filters');
        if (Array.isArray(examples)) {
            settings.filterExamples = sanitizeExamples(examples);
            noteLocalChange('filterExamples');
        }
        persistState();
        // Drop compiled regexes for the old rule set — otherwise a pattern the
        // operator just deleted would sit in the cache for the process lifetime.
        clearPatternCache();
        broadcast('settings_change', { key: 'filters', value: settings.filters }, { adminOnly: true });
        console.log(`[store] Filters updated: ${filters.length} rule(s)`);
        reextractWaiting();
    }
}

/** Are the examples in memory the real ones (not a boot placeholder)? */
function examplesKnown() {
    return !firestore.isEnabled() || loadState.config.ok || localChangedAt.filterExamples > 0
        || Array.isArray(persisted.filterExamples);
}

/**
 * May Teach run? Only on the SAVED filters and examples: Add writes the whole
 * filter set (and the examples) back, so running it on the env catch-all —
 * fresh container, Firestore not read yet — would overwrite the real ones.
 */
function teachReady() {
    if (!configReady || configProvisional || !examplesKnown()) return false;
    // The danger is ONE case: Firestore holds a config this process has not
    // read yet. Firestore off, or read and found empty, or a local state file:
    // what is running IS the saved config (review, 4.43.1 — Teach refused
    // forever on a fresh deploy with nothing saved anywhere yet).
    return !firestore.isEnabled() || loadState.config.ok || configSource !== 'env defaults';
}

function getFilterExamples() { return settings.filterExamples.map(e => Object.assign({}, e)); }

/** Remove/replace taught examples only (Teach's ✕). Filters untouched. */
function setFilterExamples(examples) {
    settings.filterExamples = sanitizeExamples(examples);
    noteLocalChange('filterExamples');
    persistState();
}

/**
 * The newest messages in memory, for Teach's "what changes for recent SMS".
 * Copies of the fields it reads; never internal or Test messages.
 */
function recentMessages(limit) {
    const out = [];
    for (const sms of smsMap.values()) {
        if (sms.internal || sms.test) continue;
        out.push({ sender: sms.sender, recipient: sms.recipient, message: sms.message,
                   code: sms.extractedCode || null, receivedAt: sms.receivedAt });
    }
    return out.slice(-(limit || 200));
}

// ═════════════════════════════════════════════════════════════════
// "SMS NOT READ" (server 4.43.0)
//
// A message that a SENDER RULE claimed and could not read is the signature of
// a format change. It is reported — to the Teach list, the dashboard and the
// admin's phone — a few seconds AFTER it arrived, not at once: a message held
// for the cold-start config, or read provisionally, is only finished when
// that settles, and a filter fixed meanwhile must not still alert.
//
// Never on the SMS path: addSms only arms a timer; the check runs later.
// ═════════════════════════════════════════════════════════════════
const UNREAD_CHECK_MS   = 4000;
const UNREAD_MAX_CHECKS = 30;          // ~2 min of waiting for the config to settle
let unreadHook = null;
function setUnreadHook(fn) { unreadHook = fn; }

function scheduleUnreadCheck(id, tries) {
    if (typeof unreadHook !== 'function') return;
    const t = setTimeout(() => checkUnread(id, (tries || 0) + 1), UNREAD_CHECK_MS);
    if (typeof t.unref === 'function') t.unref();
}

function checkUnread(id, tries) {
    const sms = smsMap.get(id);
    if (!sms || sms.extractedCode || sms.internal || sms.test) return;
    if (!configReady || deferredIds.has(id) || provisionalIds.has(id)) {
        if (tries < UNREAD_MAX_CHECKS) scheduleUnreadCheck(id, tries);
        else console.warn(`[store] ${id}: no code, but the config never settled — "SMS not read" not checked`);
        return;
    }
    const r = extractDetailed(sms.message, sms.sender, sms.recipient, settings.filters);
    if (r.code || !r.rule || r.rule === 'DEFAULT') return;
    try { unreadHook(sms, r.rule, looksLikeOtp(sms.message)); }
    catch (e) { console.warn('[store] unread hook failed:', e && e.message); }
}

// ═════════════════════════════════════════════════════════════════
//  Auto-teach suggestions (server 4.44.0)
//
// When the universal extractor read a code — no sender-specific rule claimed
// it — the code is served, but a directly matched pattern would be more
// reliable for future messages. A suggestion hook runs teach.analyze() and
// queues the result for one-click operator approval on the dashboard.
//
// Like the unread check this runs on a timer AFTER the message is stored,
// never on the SMS path itself.
// ═════════════════════════════════════════════════════════════════
let suggestionHook = null;
function setSuggestionHook(fn) { suggestionHook = fn; }

function scheduleSuggestionCheck(id) {
    if (typeof suggestionHook !== 'function') return;
    // Run 5 s after arrival — config must be settled, and the message
    // committed. Re-uses the same pattern as scheduleUnreadCheck.
    const t = setTimeout(() => checkSuggestion(id), 5000);
    if (typeof t.unref === 'function') t.unref();
}

function checkSuggestion(id) {
    const sms = smsMap.get(id);
    if (!sms || !sms.extractedCode || sms.internal || sms.test) return;
    if (!configReady) return;    // config not settled — no suggestion
    try { suggestionHook(sms); }
    catch (e) { console.warn('[store] suggestion hook failed:', e && e.message); }
}

/**
 * Re-read every message still waiting inside its OTP window with the filters
 * that were just saved.
 *
 * The case: a code is waiting, the operator sees it was read wrong (or not at
 * all) and fixes the filter. That fix should reach the message already sitting
 * there, not only the next one. getOtp's fallback used to achieve this by
 * re-extracting on every fetch; doing it once, here, at the moment the filters
 * actually change, gives the same answer without the per-fetch cost.
 *
 * Bounded: only pending messages younger than the OTP window, and held-back
 * (deferred) ones are left to the cold-start release that owns them.
 */
function reextractWaiting() {
    if (!configReady) return;
    const now = Date.now();
    const ids = [];
    for (const [id, sms] of smsMap) {
        if (sms.status === 'pending' && !deferredIds.has(id)
                && now - sms.receivedAt <= MAX_OTP_AGE_MS) ids.push(id);
    }
    reapplyBatch(ids, 'the filters changed');
}

// ─── Finishing messages at the end of their OTP window ──────────
//
// =============================================================================
// "PENDING" USED TO MEAN "NOT DELETED YET", NOT "FETCHABLE".
//
// A code stops being servable after MAX_OTP_AGE_MS (default 120 s), but the
// message stayed `pending` until auto-delete (default 30 min). So the dashboard
// showed a pending code with "28m remaining" that /get would never return, and
// the archive recorded "expired" half an hour late — or never, if the process
// restarted in between.
//
// Now the outcome is settled when it actually happens: at the end of the window
// a still-pending message becomes `expired` (it had a code nobody fetched) or
// `no_code` (no filter matched). Nothing that serves an OTP reads these
// statuses differently from before — every serving path already refused a
// message past the window — so this changes what is REPORTED, not what is
// SERVED.
// =============================================================================
function finalizeExpired(now) {
    now = now || Date.now();
    let n = 0;
    for (const [id, sms] of smsMap) {
        if (sms.status !== 'pending') continue;
        if (now - sms.receivedAt <= MAX_OTP_AGE_MS) continue;
        // Held back for the config: not finished, just not read yet.
        if (deferredIds.has(id)) continue;

        sms.status = sms.extractedCode ? 'expired' : 'no_code';
        provisionalIds.delete(id);
        const entry = numberMap.get(sms.recipient);
        if (entry && entry.smsKey === id) numberMap.delete(sms.recipient);
        // Test messages are filtered out inside record().
        history.record(sms, sms.status);
        broadcast('sms_update', sms, { userId: sms.userId });
        n++;
    }
    return n;
}

// Delete devices silent for longer than users.DELETE_AFTER_DAYS (server 4.39.0).
// Hourly is plenty for a 15-day rule; unref'd so it never holds the process.
setInterval(() => {
    try { if (usersEnabled()) users.sweepInactive(); }
    catch (e) { console.error('[store] sweepInactive failed:', e && e.message); }
}, 3_600_000).unref?.();

const FINALIZE_INTERVAL_MS = 5_000;
setInterval(() => { try { finalizeExpired(); } catch (e) {
    console.error('[store] finalizeExpired failed:', e && e.message);
} }, FINALIZE_INTERVAL_MS).unref?.();

// ─── Auto-delete expired SMS ────────────────────────────────────
setInterval(() => {
    // Expired sessions were only ever pruned inside login(), so a dashboard
    // nobody logs into again keeps every dead token in memory for the life of
    // the process. Cheap, and this timer is already running.
    pruneSessions();
    pruneSeen();

    if (smsMap.size === 0) return;
    const now     = Date.now();
    let   deleted = 0;
    for (const [id, sms] of smsMap) {
        if (now >= sms.deleteAt) {
            // The last moment the outcome is knowable. 'used' was archived when
            // it was fetched; anything still pending was never fetched, and a
            // message with no code was never extractable in the first place.
            // NOT RECORDED HERE. removeSms() owns it, and has since 4.28.4 —
            // this block stayed behind, so every expired message was queued
            // TWICE. Firestore dedupes by smsId so no duplicate document
            // appeared, which is exactly why it went unnoticed: it silently
            // halved the queue headroom during an outage and doubled the
            // written counter on the dashboard.
            //
            // One owner per fact. removeSms is the only place a message leaves
            // memory, so it is the only place that can archive it exactly once.
            removeSms(id, sms);
            deleted++;
        }
    }
    if (deleted > 0) console.log(`[store] Auto-deleted ${deleted} expired message(s)`);
}, 60_000).unref?.();

// ─── Exports ────────────────────────────────────────────────────
module.exports = {
    addSms, getOtp, getAllSms, clearAll, waitForOtp, unconsume, senderMatches,
    /** Exposed for tests: run the end-of-window sweep now. */
    _finalizeExpired: finalizeExpired,
    OTP_MAX_AGE_MS: MAX_OTP_AGE_MS,
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
        // "Running, but on the catch-all, and these will be re-read when the
        // real config lands." Distinct from `deferred`, which is "held up".
        provisional:  configProvisional,
        provisionalCount: provisionalIds.size,
        // "Never loaded" and "loaded, and genuinely empty" look identical on a
        // dashboard unless you say which. Three rounds of "my data is gone"
        // were actually this.
        load:         { config: Object.assign({}, loadState.config),
                        identity: Object.assign({}, loadState.identity) },
        firestore:    firestore.getStatus()
    }),
    /**
     * The admin's "Retry now".
     *
     * FLUSHES FIRST. A reload that overtakes a debounced write re-reads the
     * document as it was before that change and replaces memory with it —
     * losing, for example, a user created two seconds ago.
     */
    /**
     * The admin's "Retry now".
     *
     * FLUSHES FIRST — a reload that overtakes a debounced write re-reads the
     * document as it was before that change and replaces memory with it.
     *
     * And it CANCELS the chains already running. Each click used to start
     * another indefinite retry chain on top of any still scheduling, so three
     * impatient clicks during an outage meant three chains hammering Firestore
     * forever. scheduleRetry checks the generation and a superseded chain stops.
     */
    reloadDurable: () => firestore.flushNow().then(() => {
        loadGeneration++;
        loadDurableConfig(0);
        loadIdentity(0);
    }),
    /**
     * Is there a free long-poll slot for this number? /get asks BEFORE parking,
     * so it can answer "busy" instead of "timedOut". They are not the same thing
     * and a client that cannot tell them apart re-asks in a tight loop: a
     * refused park resolves instantly, so "timedOut" after 0 ms invited exactly
     * that.
     *
     * Takes the number so the PER-NUMBER cap gets the same treatment. Without
     * it, a number that had filled its own quota fell through to parking,
     * waitForOtp refused, and the caller reported the zero-millisecond
     * "timedOut" this function exists to prevent. Called with no argument it
     * still answers the global question, which is what the tests do.
     */
    waitersFull: (number) => {
        if (waiterCount >= MAX_WAITERS) return true;
        if (number === undefined || number === null) return false;
        return waitersOn(canonicalizePhone(number)) >= MAX_WAITERS_PER_NUMBER;
    },
    /** Exposed for tests and for the capacity line on the dashboard. */
    waiterLimits: () => ({ global: MAX_WAITERS, perNumber: MAX_WAITERS_PER_NUMBER,
                           parked: waiterCount }),
    mergeFilterRules,
    revokeToken,
    triggerFetchLatest,
    isForwardingEnabled: () => settings.globalForwarding,
    /**
     * A device's reported SIMs changed (4.40.0). Admin-only: the event carries
     * no data — the panel re-reads /api/devices, which is admin-scoped already,
     * so this cannot leak one user's numbers to another.
     */
    setInternalHook,
    /** Exposed for tests: re-check pending messages against our own numbers. */
    _reclassifyInternal: () => reclassifyInternal(),
    /** For the outbox: SSE to one audience. */
    broadcast,
    notifyDevicesChanged: () => broadcast('devices_change', { at: Date.now() }, { adminOnly: true }),
    // Test-only surface. Nothing in server.js touches these; they exist so
    // test/store.test.js can re-derive the index by brute force and compare.
    _internals: { smsMap, byRecipient, numberMap, MAX_MESSAGES },
    getSettings, setGlobalForwarding, triggerClearLog, triggerTestMessage,
    setAutoDeleteMinutes, setFilters,
    getFilterExamples, setFilterExamples, recentMessages, setUnreadHook, setSuggestionHook, teachReady,
    /** Exposed for tests: run the unread check for one message now. */
    _checkUnread: (id) => checkUnread(id, UNREAD_MAX_CHECKS),
    addSSEClient, login, validateToken, getSession, revokeSessionsFor,
    issueStreamTicket, redeemStreamTicket,
    users,
    canonicalizePhone
};
