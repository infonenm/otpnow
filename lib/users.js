/**
 * lib/users.js — user accounts and device registry.
 *
 * =============================================================================
 * THE RULE THIS FILE LIVES BY
 *
 * Everything here is held IN MEMORY and read from memory. Firestore is where it
 * is saved: read once at boot, written when something changes, never on a
 * request path — not the OTP path, and not the dashboard path either.
 *
 * "Checked on every request" (deactivation) therefore costs a Map lookup, not a
 * network call. That distinction is the whole reason this design is acceptable
 * at all, and test/users.test.js counts calls to prove it holds.
 * =============================================================================
 *
 * SHAPE
 *
 *   users[id]    = { id, name, passwordHash, enrollCode, role, active, createdAt }
 *   devices[id]  = { id, name, userId, model, lastSeen, createdAt,
 *                    sims: [slot1, slot2] | null, simLog: [...] }   (sims: 4.40.0)
 *   allowedHosts = [ "otpnow.onrender.com", ... ]
 *
 * ADMIN IS NOT A RECORD. The admin authenticates with DASHBOARD_PASSWORD from
 * the environment, exactly as today. Making admin an ordinary row would mean a
 * Firestore outage, or one bad write, could lock you out of your own dashboard —
 * and the recovery would be an env var anyway. So the env var IS the recovery
 * path, permanently. Admin cannot be deactivated, deleted, or demoted.
 */

const crypto = require('crypto');
// Pure, no I/O — the one thing this module may import. setDeviceSim has to
// store the SAME key the store files under, or a configured number is still
// unfetchable.
const { canonicalizePhone } = require('./phone');

const ADMIN_ID = 'admin';

// ─── In-memory state ────────────────────────────────────────────
const users   = new Map();   // id -> user
const devices = new Map();   // id -> device

// ═════════════════════════════════════════════════════════════════
// REMOVED DEVICES. id -> { at, installId, name, model }
//
// "Remove" USED TO MEAN NOTHING, AND THAT IS THE POINT OF THIS MAP.
//
// The phone generates its own id and re-registers on every process start — an
// FCM wake, the 4-minute alarm chain, a reboot. So removing a device deleted a
// row that the same phone put straight back, unassigned, within minutes. The
// button looked like a revocation and was a refresh.
//
// Remembering the removal is what turns it into one. A revoked id is refused at
// registration, is not forwarding-eligible, and cannot come back on its own —
// only a reinstall of the app lifts it (see INSTALLS below).
//
// PERSISTED with the rest of identity: a revocation that a redeploy undoes is
// not a revocation. It is the one piece of device state that MUST survive, and
// for the opposite reason to lastSeen, which must not.
// ═════════════════════════════════════════════════════════════════
const revoked = new Map();

// ═════════════════════════════════════════════════════════════════
// INSTALLS, AND WHAT "REMOVED" MEANS (server 4.39.0, Riad's rule)
//
// A removed phone is gone until the app is REINSTALLED, and then it comes back
// as a NEW, UNASSIGNED device. No username, no "Allow back".
//
// From app 4.34.0 a phone's device id SURVIVES a reinstall (it is derived from
// the platform's per-app id), so a reinstall alone no longer makes a new row —
// which is what stops the device list growing. That means "reinstalled" has to
// be told apart from "the same install, still running". Each install therefore
// also sends an installId: random, created on first run, gone with the app's
// data. A removal records the installId it removed; a request from the same
// device id with a DIFFERENT installId is a reinstall, and lifts it.
//
// A removal recorded with no installId (a phone on an older app, whose device
// id is random) is never lifted that way — and needs no lifting: reinstalling
// such a phone gives it a new device id anyway.
// ═════════════════════════════════════════════════════════════════
const INSTALL_ID_RE = /^[a-f0-9]{16}$/i;
const validInstall = v => typeof v === 'string' && INSTALL_ID_RE.test(v);

// ═════════════════════════════════════════════════════════════════
// INACTIVE DEVICES (server 4.39.0, Riad's rule)
//
// Hidden from the dashboard after HIDE days without contact (a "Show inactive"
// switch reveals them), DELETED after DELETE days. A deleted phone that checks
// in again comes back as an unassigned device; messages and history are not
// touched by any of this.
//
// "Contact" is lastSeen, which lives in memory (every poll), plus seenAt, a
// coarse copy persisted at most once an hour per device — without it, every
// server restart would make every device look silent since the epoch.
// ═════════════════════════════════════════════════════════════════
const DAY_MS = 86_400_000;
const HIDE_AFTER_DAYS   = 7;
const DELETE_AFTER_DAYS = 15;
const SEEN_PERSIST_MS   = 3_600_000;

function lastActive(d) {
    return Math.max(d.lastSeen || 0, d.seenAt || 0);
}

// ═════════════════════════════════════════════════════════════════
// SIM NUMBERS REPORTED BY THE PHONE (server 4.40.0, Riad's spec)
//
// The phone already knows its SIM 1 / SIM 2 numbers — typed, found by "Get
// Number", or read from the SIM — and files every OTP under them. The server
// never saw that list, so the dashboard could not say which numbers a device
// carries. App 4.35.0 sends it on /api/register: on start, on every save or
// clear, and on every SIM change.
//
// WHAT THIS IS NOT: it is not the admin's `simNumber` below (setDeviceSim).
// That one is a FALLBACK for messages the phone could not attribute at all, and
// it decides where those OTPs are filed. This list decides nothing about
// routing — /sms, /get and the store are untouched by it. It is the device
// registry the dashboard (and the later send-SMS feature) reads.
//
// One record per slot, REPLACED by each report: a new number for SIM 1
// overwrites the old one, an empty one clears it. The phone is the authority on
// what is in its own slots.
//
//   unconfirmed  the phone saw a DIFFERENT SIM appear in that slot and nobody
//                has saved a number for it since. The number shown (if any) was
//                not entered for this SIM. The later send feature must refuse
//                to send from such a slot.
//
// ABSENT and EMPTY are different answers (the rule from the 4.25/4.26 data-loss
// bugs): an older app sends no `sims` key at all, and that keeps what is stored.
// Only a report that is present replaces it.
// ═════════════════════════════════════════════════════════════════
const SIM_LOG_MAX = 10;
const SIM_SOURCES = new Set(['manual', 'auto', '']);
/** A phone clock this far off is not believed for "when the SIM changed". */
const SIM_CLOCK_SLACK_MS = DAY_MS;
const EARLIEST_PLAUSIBLE_MS = Date.UTC(2024, 0, 1);

/** Bumped whenever any device's reported SIMs change, so the caller can push a refresh. */
let simsVersion = 0;

function blankSim(slot) {
    return { slot, number: '', source: '', unconfirmed: false, changedAt: 0, changedFrom: '',
             present: null };
}

/**
 * A reported number, canonical, or '' — never anything else.
 *
 * '' for anything that is not a Bangladeshi mobile number. This is attacker-
 * reachable (the API key ships in the APK), so nothing but digits in the one
 * known shape is ever stored; the dashboard escapes at render time as well.
 */
function cleanSimNumber(v) {
    const raw = String(v == null ? '' : v).trim().slice(0, 32);
    if (!raw) return '';
    const c = canonicalizePhone(raw);
    return /^01[0-9]{9}$/.test(c) ? c : '';
}

/**
 * The phone's report as exactly two slot records, or null when it is not a
 * report at all (absent, or not an array) — null means "keep what is stored".
 */
function normalizeSimReport(list, now) {
    if (!Array.isArray(list)) return null;
    now = now || Date.now();
    const out = [blankSim(1), blankSim(2)];
    for (const s of list.slice(0, 4)) {
        if (!s || typeof s !== 'object') continue;
        const slot = Number(s.slot);
        if (slot !== 1 && slot !== 2) continue;
        const number = cleanSimNumber(s.number);
        const unconfirmed = s.unconfirmed === true;
        let changedAt = 0;
        if (unconfirmed) {
            const at = Math.floor(Number(s.changedAt));
            // The phone's clock. Believed only when plausible; otherwise "now"
            // is closer to the truth than a date in 1970 or next year.
            changedAt = (at >= EARLIEST_PLAUSIBLE_MS && at <= now + SIM_CLOCK_SLACK_MS) ? at : now;
        }
        const source = String(s.source == null ? '' : s.source);
        out[slot - 1] = {
            slot, number,
            source: number && SIM_SOURCES.has(source) ? source : '',
            unconfirmed, changedAt,
            changedFrom: unconfirmed ? cleanSimNumber(s.changedFrom) : '',
            // Is a SIM card in the slot right now (app 4.36.0)? null = the
            // phone did not say (older app, or it could not read the slot).
            present: s.present === true ? true : (s.present === false ? false : null)
        };
    }
    return out;
}

/** One change-log line for a slot, or null when nothing worth logging changed. */
function simLogEntry(a, b, now) {
    const base = { at: now, slot: b.slot, from: a.number, to: b.number };
    if (!a.unconfirmed && b.unconfirmed) {
        // A different SIM is in the slot. "from" is what the phone last had
        // for it, which it reports itself because the typed number is already
        // gone by the time it tells us.
        return Object.assign(base, { event: 'sim_changed', from: b.changedFrom || a.number });
    }
    if (a.number !== b.number) {
        return Object.assign(base, {
            event: !b.number ? 'cleared' : (a.number ? 'changed' : 'set'),
            // Saving a number is also what confirms a changed SIM.
            confirmed: a.unconfirmed && !b.unconfirmed
        });
    }
    if (a.unconfirmed && !b.unconfirmed) return Object.assign(base, { event: 'confirmed' });
    return null;
}

/**
 * Apply a phone's SIM report to its device record.
 * @returns {boolean} true when what is stored changed.
 */
function applySimReport(d, list, now) {
    now = now || Date.now();
    const next = normalizeSimReport(list, now);
    if (!next) return false;
    const prev = Array.isArray(d.sims) ? d.sims : null;
    if (prev && JSON.stringify(prev) === JSON.stringify(next)) return false;
    // The FIRST report is the starting point, not a change: logging it would
    // fill every device's history with a line per slot on the day it upgrades.
    if (prev) {
        for (let i = 0; i < 2; i++) {
            const e = simLogEntry(prev[i] || blankSim(i + 1), next[i], now);
            if (e) d.simLog = [e].concat(Array.isArray(d.simLog) ? d.simLog : []).slice(0, SIM_LOG_MAX);
        }
    }
    d.sims = next;
    simsVersion++;
    systemNumbersStale = true;
    return true;
}

// ═════════════════════════════════════════════════════════════════
// SENDING SMS FROM THE DASHBOARD — PER-USER PERMISSION (server 4.41.0)
//
// Riad's rule: OFF for every user until the admin turns it on, with a daily
// ceiling the admin sets. The admin (env password, not a record) always may.
// A user's SIM balance is real money, which is why both exist.
// ═════════════════════════════════════════════════════════════════
const DEFAULT_SEND_DAILY_LIMIT = 50;
const MAX_SEND_DAILY_LIMIT = 1000;

function clampSendLimit(v) {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 1) return DEFAULT_SEND_DAILY_LIMIT;
    return Math.min(n, MAX_SEND_DAILY_LIMIT);
}

function sendLimitOf(u) { return clampSendLimit(u && u.sendDailyLimit); }

/**
 * @param {{enabled?:boolean, dailyLimit?:number}} p — either or both
 */
function setSendPermission(id, p) {
    const u = users.get(slug(id));
    if (!u) return { ok: false, error: 'No such user' };
    p = p || {};
    if (p.enabled !== undefined && typeof p.enabled !== 'boolean') {
        return { ok: false, error: 'enabled must be true or false' };
    }
    if (p.dailyLimit !== undefined) {
        const n = Math.floor(Number(p.dailyLimit));
        if (!Number.isFinite(n) || n < 1 || n > MAX_SEND_DAILY_LIMIT) {
            return { ok: false, error: `Daily limit must be 1–${MAX_SEND_DAILY_LIMIT}` };
        }
        u.sendDailyLimit = n;
    }
    if (p.enabled !== undefined) u.sendEnabled = p.enabled;
    markDirty();
    return { ok: true, user: publicUser(u) };
}

/** May this user send at all? Admin always; a user only when switched on and active. */
function sendPolicy(userId) {
    if (userId === ADMIN_ID) return { enabled: true, dailyLimit: null };
    const u = users.get(userId);
    if (!u || !u.active) return { enabled: false, dailyLimit: 0 };
    return { enabled: !!u.sendEnabled, dailyLimit: sendLimitOf(u) };
}

// ═════════════════════════════════════════════════════════════════
// "IS THIS ONE OF OUR OWN SIMS?" — for the OTP collision guard (4.41.0)
//
// An SMS one of our phones SENDS to another of our phones arrives at the
// second phone and is forwarded like any SMS. Filed as an ordinary message it
// would supersede — destroy — a live OTP on that number. So store.addSms asks
// this, on the /sms path: it must cost a Set lookup, never a scan. The set is
// rebuilt lazily, only after something that can change it.
// ═════════════════════════════════════════════════════════════════
let systemNumbers = new Set();
let systemNumbersStale = true;

function rebuildSystemNumbers() {
    const next = new Set();
    for (const d of devices.values()) {
        // The admin's fallback number was typed by the admin: always trusted.
        if (d.simNumber) next.add(d.simNumber);
        // A PHONE'S OWN REPORT counts only for a phone someone owns — assigned
        // on the dashboard, or claimed for a real active user (review #6). The
        // API key ships inside the APK, so an unowned "device" could otherwise
        // report any number and make that sender's OTPs unservable.
        if (ownerOf(d.id) === ADMIN_ID && !d.userId) continue;
        for (const s of (Array.isArray(d.sims) ? d.sims : [])) if (s.number) next.add(s.number);
    }
    systemNumbers = next;
    systemNumbersStale = false;
}

/** @param {string} canon a canonical number (01XXXXXXXXX) */
function isSystemNumber(canon) {
    if (!canon || canon.length !== 11) return false;
    if (systemNumbersStale) rebuildSystemNumbers();
    return systemNumbers.has(canon);
}

/** Stored log lines, re-validated on load — a document is data, not trusted shape. */
function cleanSimLog(list) {
    if (!Array.isArray(list)) return [];
    const EVENTS = new Set(['sim_changed', 'set', 'changed', 'cleared', 'confirmed']);
    return list.slice(0, SIM_LOG_MAX)
        .filter(e => e && EVENTS.has(e.event) && (e.slot === 1 || e.slot === 2))
        .map(e => ({ at: Number(e.at) || 0, slot: e.slot, event: e.event,
                     from: cleanSimNumber(e.from), to: cleanSimNumber(e.to),
                     ...(e.confirmed ? { confirmed: true } : {}) }));
}

let allowedHosts = [];
let dirty = false;           // reported in stats(); see markDirty/load
let persistFn = null;        // injected by store.js — keeps this module I/O-free

/**
 * Injected rather than required, so this module never imports firestore and
 * cannot accidentally acquire a network call on a read path.
 */
function setPersister(fn) { persistFn = fn; }

/**
 * Has a load actually succeeded?
 *
 * =========================================================================
 * NOTHING IS PERSISTED BEFORE A SUCCESSFUL LOAD. THIS IS THE LAST LINE.
 *
 * The in-memory maps start EMPTY. If a boot-time read fails and anything then
 * calls markDirty() — a device registering does, by itself, with no operator
 * involved — the empty set is written to Firestore and every account is gone.
 * Permanently, because the stored copy was the only one.
 *
 * That happened in production. The read is now guarded at its own level too,
 * but this flag is the backstop: an empty map is only ever written if we know
 * for certain the stored state was also empty.
 * =========================================================================
 */
let loadedOk = false;

/** Devices that registered before the first successful load. See load(). */
const carriedDevices = new Map();

function markDirty() {
    dirty = true;   // cleared by load(), and reported in stats()
    // ANY identity change can change which numbers are ours (an owner
    // deactivated, a claim resolving, a device reassigned): rebuild lazily.
    // One place, so no parallel path can forget it.
    systemNumbersStale = true;
    if (!loadedOk) {
        console.error('[users] Refusing to persist — identity has not been loaded '
            + 'successfully, so writing now would overwrite stored accounts with an '
            + 'empty set. Fix the Firestore read and restart.');
        return;
    }
    if (typeof persistFn === 'function') {
        try { persistFn(snapshot()); } catch (e) { /* the caller logs */ }
    }
}

// ─── Password hashing ───────────────────────────────────────────
//
// scrypt is in Node's standard library, so this adds no dependency. Format is
// self-describing so the parameters can change later without a migration:
//
//     scrypt$<N>$<salt-hex>$<hash-hex>

const SCRYPT_N = 16384;
const KEY_LEN  = 32;

/**
 * =============================================================================
 * ASYNC, BECAUSE THIS SHARES A THREAD WITH /get
 *
 * scryptSync(N=16384) BLOCKS the event loop. Measured on this machine: 37 ms.
 * /get answers in ~0.005 ms, so one password check stalls on the order of a
 * few thousand OTP fetches — on a system whose entire premise is that
 * milliseconds are the product.
 *
 * Logins are rare, but /api/login has an awaited back-off and no concurrency
 * cap, so a burst of failed logins was a cheap way to add latency to the one
 * path that must never have any. The async form does the work on libuv's
 * threadpool and leaves the main thread free.
 * =============================================================================
 */
function scrypt(password, salt, keylen, N) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(String(password), salt, keylen, { N }, (err, key) =>
            err ? reject(err) : resolve(key));
    });
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(password, salt, KEY_LEN, SCRYPT_N);
    return `scrypt$${SCRYPT_N}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * N is CLAMPED rather than trusted. It is parsed out of the stored string, and
 * a hash with an absurd N would pin a CPU for as long as it liked. The input is
 * admin-controlled today, so this is cheap insurance rather than a live risk —
 * but bounding it costs one line and removes the question.
 */
async function verifyPassword(password, stored) {
    if (typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
    try {
        const N    = Math.min(Math.max(parseInt(parts[1], 10) || SCRYPT_N, 1024), 1 << 17);
        const salt = Buffer.from(parts[2], 'hex');
        const want = Buffer.from(parts[3], 'hex');
        const got  = await scrypt(password, salt, want.length, N);
        return crypto.timingSafeEqual(got, want);
    } catch (e) {
        return false;
    }
}

/**
 * A hash of nothing, used to spend the same time on an unknown user as on a
 * real one. authenticate() returned instantly when the name did not exist and
 * paid ~37 ms when it did, which tells an attacker which usernames are real.
 */
const DUMMY_HASH = `scrypt$${SCRYPT_N}$${'0'.repeat(32)}$${'0'.repeat(64)}`;

// ─── Ids and codes ──────────────────────────────────────────────

/** Lower-case, alphanumeric and dashes. Stable, readable, and URL-safe. */
function slug(name) {
    return String(name || '').trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        // Truncation can make two long names the SAME id, and the second
        // createUser would be refused as "already exists" with no hint why —
        // or worse, a rename could land on someone else's account. Names are
        // people's names; 32 characters is plenty, and the limit is enforced at
        // creation rather than silently applied.
        .slice(0, 32);
}

/**
 * A one-time enrollment code.
 *
 * Without one, an account that has no password yet belongs to whoever reaches
 * it first — the username is not a secret. The code is shown to the admin once,
 * handed to the person out of band, and dies the moment it is used.
 *
 * Deliberately excludes look-alike characters: this gets read off a screen and
 * typed by hand, and "was that a 0 or an O" is a support call.
 */
function newEnrollCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
    return out.slice(0, 4) + '-' + out.slice(4);
}

// ─── Users ──────────────────────────────────────────────────────

/**
 * @returns {{ok:boolean, error?:string, user?:object, enrollCode?:string}}
 */
function createUser(name) {
    const id = slug(name);
    if (!id) return { ok: false, error: 'Name must contain at least one letter or digit' };
    if (String(name).trim().length > 32) {
        return { ok: false, error: 'Name must be 32 characters or fewer — longer names '
                                 + 'are truncated to the same id and would collide' };
    }
    if (id === ADMIN_ID) return { ok: false, error: '"admin" is reserved' };
    if (users.has(id)) return { ok: false, error: `User "${id}" already exists` };

    const enrollCode = newEnrollCode();
    const user = {
        id,
        name: String(name).trim(),
        passwordHash: null,          // set at first login, with the code
        enrollCode,
        role: 'user',
        active: true,
        createdAt: Date.now(),
        // Sending SMS from the dashboard (4.41.0): OFF until the admin turns it
        // on for this user (Riad's choice), with a per-day ceiling.
        sendEnabled: false,
        sendDailyLimit: DEFAULT_SEND_DAILY_LIMIT
    };
    users.set(id, user);
    markDirty();
    return { ok: true, user: publicUser(user), enrollCode };
}

/**
 * Set a password using the one-time code. Also the reset path: the admin
 * reissues a code, which clears the old password.
 */
async function setPassword(id, enrollCode, password) {
    const user = users.get(slug(id));
    if (!user) return { ok: false, error: 'No such user' };
    if (!user.active) return { ok: false, error: 'Account is deactivated' };
    if (!user.enrollCode) return { ok: false, error: 'This account already has a password' };
    if (typeof password !== 'string' || password.length < 8) {
        return { ok: false, error: 'Password must be at least 8 characters' };
    }
    // Compare on the letters and digits only. The dash is there to make the
    // code readable, not to be part of it — "L8SUY5ZQ" is the same code as
    // "L8SU-Y5ZQ", and rejecting it teaches nothing except that the system is
    // fussy. Spaces go for the same reason.
    const norm = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (norm(enrollCode) !== norm(user.enrollCode)) {
        return { ok: false, error: 'Wrong enrollment code' };
    }

    user.passwordHash = await hashPassword(password);
    user.enrollCode = null;          // one-time, and it means it
    markDirty();
    return { ok: true };
}

/** Admin reissues a code. The existing password stops working immediately. */
function reissueCode(id) {
    const user = users.get(slug(id));
    if (!user) return { ok: false, error: 'No such user' };
    user.enrollCode = newEnrollCode();
    user.passwordHash = null;
    markDirty();
    return { ok: true, enrollCode: user.enrollCode };
}

/**
 * Deactivate: the account loses EVERY dashboard control, immediately.
 *
 * Not "cannot log in next time" — sessions are revoked by the caller and every
 * authenticated route re-checks active(), so a deactivated user's buttons stop
 * responding mid-session rather than at token expiry twelve hours later.
 *
 * Their PHONES stop forwarding too: store.forwardingFor() declines every push
 * from a device whose owner is inactive, server-side, so a phone that was
 * force-stopped by a battery manager and never heard about it is still
 * refused. (This comment said the devices kept forwarding to admin; that was
 * reversed in server 4.27.0. Purging the user is what frees their devices.)
 */
function setActive(id, active) {
    const user = users.get(slug(id));
    if (!user) return { ok: false, error: 'No such user' };
    user.active = !!active;
    // A push of this name that has not reached its phone yet must not arrive
    // now: the phone would save a name that unlocks nothing, and the card
    // would then report it "saved".
    if (!user.active) dropPushesFor(user.id, false);
    markDirty();
    return { ok: true, user: publicUser(user) };
}

/**
 * Remove the user record entirely, and unassign their devices.
 *
 * Deliberately separate from deactivate, and deliberately the second step: a
 * hard delete on a live system takes phones off their owner the instant it is
 * clicked, and there is no undo. Deactivate first, purge when you are sure.
 *
 * History is NOT rewritten. A message records what happened at the time it
 * happened; the userId stamped on it stays. Same principle as receivedAt.
 */
function purgeUser(id) {
    const key = slug(id);
    if (!users.has(key)) return { ok: false, error: 'No such user' };
    users.delete(key);
    dropPushesFor(key, true);
    let unassigned = 0;
    for (const d of devices.values()) {
        const claimed = d.claimedUserId && !String(d.claimedUserId).startsWith('?')
            ? d.claimedUserId : null;
        if (d.userId !== key && claimed !== key) continue;

        // BOTH, or the device is silenced permanently. forwardingFor() reads the
        // raw claim as well as the assignment, so clearing only userId left a
        // claim pointing at a user that no longer exists — isActive() says no,
        // and the phone was declined on every push with nothing on screen to
        // explain it. Verified: forwarding went true -> false on purge.
        if (d.userId === key) d.userId = null;
        if (claimed === key) d.claimedUserId = null;
        unassigned++;
    }
    markDirty();
    return { ok: true, unassignedDevices: unassigned };
}

function getUser(id) { return users.get(slug(id)) || null; }

/** True when this id may use the dashboard right now. Admin always may. */
function isActive(id) {
    if (id === ADMIN_ID) return true;
    const u = users.get(slug(id));
    return !!(u && u.active);
}

function listUsers() {
    return Array.from(users.values())
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(publicUser);
}

/** Never leaks the password hash. The enrollment code is admin-only, see below. */
function publicUser(u) {
    return {
        id: u.id, name: u.name, role: u.role, active: u.active,
        hasPassword: !!u.passwordHash,
        enrollCode: u.enrollCode || null,
        createdAt: u.createdAt,
        deviceCount: Array.from(devices.values()).filter(d => d.userId === u.id).length,
        sendEnabled: !!u.sendEnabled,
        sendDailyLimit: sendLimitOf(u)
    };
}

/**
 * Authenticate a dashboard login.
 * @returns {{id:string, role:string}|null}
 */
async function authenticate(name, password) {
    const id = slug(name);
    const user = users.get(id);

    // Verify against a dummy hash for an unknown, inactive or un-enrolled
    // account, so all four outcomes cost the same. Returning early was a
    // username oracle: instant meant "no such user", 37 ms meant "real".
    const usable = user && user.active && user.passwordHash;
    const ok = await verifyPassword(password, usable ? user.passwordHash : DUMMY_HASH);
    if (!usable || !ok) return null;
    return { id: user.id, role: user.role };
}

// ─── Devices ────────────────────────────────────────────────────

/**
 * A phone announcing itself.
 *
 * Idempotent on the deviceId it was given: a re-register keeps the assignment,
 * so RESTARTING the phone or the app does not orphan it.
 *
 * A REINSTALL DOES. The id lives in SharedPreferences and android:allowBackup is
 * false, so a fresh install generates a new id and arrives as a new unassigned
 * device. That is honest behaviour — a wiped phone genuinely is a new device —
 * but the old claim said otherwise and would have had you looking for a bug.
 *
 * A device with no owner is NOT rejected — its messages file to admin and it
 * shows on the dashboard as unassigned, waiting for a click. Rejecting it would
 * mean a new phone silently forwards nothing, which is the worst possible
 * failure for a system whose job is not to lose messages.
 */
function registerDevice(deviceId, info) {
    info = info || {};
    let id = String(deviceId || '').trim();
    if (id === '') {
        // A first registration, with nothing to preserve.
        id = crypto.randomBytes(8).toString('hex');
    } else if (!/^[a-f0-9]{16}$/i.test(id)) {
        // A MALFORMED id used to get a fresh random one on EVERY call, so a
        // non-conforming client created a new device row per registration
        // instead of being told once that its id is wrong.
        return { id: null, error: 'deviceId must be 16 hex characters' };
    }

    // A REMOVED DEVICE STAYS REMOVED UNTIL THE APP IS REINSTALLED (4.39.0).
    // A new install lifts it here and the phone continues as a NEW, unassigned
    // device below. Anything else is refused — there is no username way back.
    liftIfReinstalled(id, info.installId);
    if (revoked.has(id)) {
        return { id: null, revoked: true, needsUsername: false,
                 error: 'This device was removed by the admin. Reinstall the app '
                      + 'to use it again.' };
    }

    const existing = devices.get(id);
    const device = existing || {
        id, name: '', userId: null, claimedUserId: null,
        model: '', simNumber: null, createdAt: Date.now(), lastSeen: 0,
        installId: null, seenAt: 0, sims: null, simLog: [],
        canSendSms: null, appVersion: ''
    };
    // What the snapshot would carry, BEFORE this registration touches anything.
    // Derived from durableDevice() rather than a hand-written field list, so a
    // field added to the snapshot later cannot be silently left out of this
    // comparison and stop being persisted.
    const before = existing ? JSON.stringify(durableDevice(existing)) : null;

    // The phone's optional claim. Recorded SEPARATELY from userId, which is the
    // admin's assignment, so the two never overwrite each other and ownerOf()
    // can apply the precedence rule in one place.
    if (info.claimedUser !== undefined) {
        const claim = slug(info.claimedUser);
        device.claimedUserId = claim && users.has(claim) ? claim : (claim ? '?' + claim : null);
    }
    if (info.model) device.model = String(info.model).slice(0, 64);
    if (info.name && !device.name) device.name = String(info.name).slice(0, 64);
    if (!device.name) device.name = device.model || ('Device ' + id.slice(0, 6));
    // The install this registration came from. A change here on a device that
    // is NOT removed is an ordinary reinstall: same device, same owner and SIM.
    if (validInstall(info.installId)) seeInstall(device, info.installId.toLowerCase());
    const now = Date.now();
    device.lastSeen = now;
    if (!device.seenAt || now - device.seenAt > SEEN_PERSIST_MS) device.seenAt = now;
    // The phone's SIM 1 / SIM 2 (app 4.35.0). Absent from an older app, which
    // keeps whatever is stored. Persisted through durableDevice below, so an
    // unchanged report costs no write.
    // Can this phone send SMS for the dashboard (app 4.36.0: the build has the
    // feature AND Android has granted SEND_SMS)? Absent from an older app,
    // which keeps whatever is stored — null on a new row, "unknown".
    if (typeof info.canSendSms === 'boolean') device.canSendSms = info.canSendSms;
    if (info.appVersion !== undefined) device.appVersion = String(info.appVersion || '').slice(0, 24);
    if (info.sims !== undefined) {
        applySimReport(device, info.sims, now);
        // Heard from the phone IN THIS PROCESS — see the overlay in load().
        device.simsLiveAt = now;
    }

    devices.set(id, device);

    // A username the admin pushed to this phone is CONFIRMED by the phone
    // registering with it — that is the only proof it reached the app's
    // Settings, rather than merely leaving the server. See pushUsername.
    if (device.pendingUsername && info.claimedUser !== undefined
            && slug(info.claimedUser) === device.pendingUsername.userId
            && isActive(device.pendingUsername.userId)
            && device.pendingUsername.userId !== ADMIN_ID) {
        device.usernameAck = { userId: device.pendingUsername.userId,
                               name: device.pendingUsername.name, at: Date.now() };
        device.pendingUsername = null;
    }

    // ═════════════════════════════════════════════════════════════════
    // ONLY PERSIST IF SOMETHING PERSISTABLE CHANGED.
    //
    // This called markDirty() unconditionally, and the app registers on EVERY
    // process start — which an FCM wake, the 4-minute alarm chain or a reboot
    // all cause. So a fleet of phones produced a steady stream of Firestore
    // identity writes, plus a synchronous writeFileSync/renameSync on the event
    // loop that answers /get, to store a snapshot identical to the one already
    // there.
    //
    // The re-registration case is the common one and it changes exactly ONE
    // field: lastSeen. And lastSeen is deliberately excluded from snapshot() —
    // it is never persisted and is re-earned by the next poll — so a write
    // triggered by it could not have changed the stored document at all.
    //
    // Anything the snapshot DOES carry — a claim resolving from "?rahim" to
    // "rahim" once that account exists, a model or name arriving for the first
    // time — is a real change and still persists immediately. A brand-new
    // device always does: `before` is null.
    // ═════════════════════════════════════════════════════════════════
    if (before === null || before !== JSON.stringify(durableDevice(device))) markDirty();
    return device;
}

/**
 * A request from this install reached the server. Records it as the LIVE install
 * (in memory: what a removal records, see removeDevice) and as the durable one.
 *
 * Two phones that report the same ANDROID_ID (some cloned ROMs do) share one
 * device id, and their installIds alternate on every request. That is flagged
 * (`sharedId`, shown on the dashboard) and, once flagged, the alternation is not
 * written to Firestore on every poll.
 *
 * @returns {boolean} true when the durable installId changed and should be saved.
 */
function seeInstall(d, inst) {
    const now = Date.now();
    if (d.liveInstallId && d.liveInstallId !== inst) {
        if (inst === d.prevInstallId && now - (d.installFlipAt || 0) < SEEN_PERSIST_MS) {
            if (!d.sharedId) {
                console.warn(`[users] Device ${d.id} (${d.name}): two installs are `
                    + `alternating on one device id — two phones share an ANDROID_ID`);
            }
            d.sharedId = true;
        }
        d.prevInstallId = d.liveInstallId;
        d.installFlipAt = now;
    }
    d.liveInstallId = inst;
    if (d.installId === inst) return false;
    d.installId = inst;
    return !d.sharedId;
}

/** seenAt moved on some device since the last save; the hourly sweep saves it. */
let seenPending = false;

/**
 * lastSeen, from the poll the app already makes. No new mechanism, no new
 * request, and it is what answers "which phones are alive?" on the dashboard.
 *
 * NOT persisted on every touch — that would be a Firestore write every 30
 * seconds per device. It is in-memory only and refreshed within 30s of any
 * restart, which is what the field is for.
 */
function touchDevice(deviceId) {
    const d = devices.get(String(deviceId || ''));
    if (!d) return null;
    const now = Date.now();
    d.lastSeen = now;
    // Coarse and persisted, so "inactive for 7 / 15 days" survives a restart.
    // NOT saved here: one identity write per phone per hour is a full-snapshot
    // Firestore write per phone. The hourly sweep saves them all at once
    // (review finding). A restart loses at most that hour, against limits
    // measured in days.
    if (!d.seenAt || now - d.seenAt > SEEN_PERSIST_MS) {
        d.seenAt = now;
        seenPending = true;
    }
    return d;
}

/**
 * Every request that carries an installId goes through here first (/sms, the
 * poll, registration). A reinstall of a removed phone lifts the removal; a
 * reinstall of an ordinary phone just records the new install.
 */
function noteInstall(deviceId, installId) {
    const id = String(deviceId || '');
    if (!id || !validInstall(installId)) return;
    if (liftIfReinstalled(id, installId)) return;
    const d = devices.get(id);
    if (d && seeInstall(d, installId.toLowerCase()) && loadedOk) markDirty();
}

/** @returns {boolean} true when a removal was lifted by a new install. */
function liftIfReinstalled(deviceId, installId) {
    const rec = revoked.get(deviceId);
    if (!rec || !validInstall(installId)) return false;
    const inst = installId.toLowerCase();
    if (!rec.installId) {
        // The removal did not know which install it removed: no request from
        // the phone had reached THIS process since the last load (a phone that
        // was offline when it was removed, or one whose row predates 4.39.0).
        //
        // With a stored install to go by (`hint`), a caller with a DIFFERENT
        // one is a reinstall — the overwhelmingly likely reading; the stored
        // value is stale only if a reinstall happened while a previous process
        // ran from the cache and that process died before Firestore loaded.
        //
        // With no hint, the first install to make contact is BOUND to the
        // removal and stays removed; a later, different install lifts it.
        // Without this such a removal could never be lifted, because the stable
        // id survives the reinstall (review finding).
        if (rec.hint && inst !== rec.hint) {
            revoked.delete(deviceId);
            devices.delete(deviceId);
            systemNumbersStale = true;
            console.warn(`[users] Device ${deviceId} was reinstalled — its removal is lifted; `
                + `it continues as a new, unassigned device`);
            if (loadedOk) markDirty();
            return true;
        }
        rec.installId = inst;
        rec.hint = null;
        console.warn(`[users] Removed device ${deviceId}: bound to install ${inst}`);
        if (loadedOk) markDirty();
        return false;
    }
    if (inst === rec.installId) return false;   // same install: still removed
    revoked.delete(deviceId);
    devices.delete(deviceId);          // never resurrect the old row: NEW and unassigned
    systemNumbersStale = true;
    console.warn(`[users] Device ${deviceId} was reinstalled — its removal is lifted; `
        + `it continues as a new, unassigned device`);
    if (loadedOk) markDirty();
    return true;
}

/**
 * Delete devices silent for more than DELETE_AFTER_DAYS. Run hourly by the
 * store. Only with identity loaded — nothing is deleted from a cache we cannot
 * write back, or from an empty map that only looks silent.
 *
 * @returns {number} devices deleted
 */
function sweepInactive(now) {
    if (!loadedOk) return 0;
    now = now || Date.now();
    let n = 0;
    const seen = seenPending;
    seenPending = false;
    for (const [id, d] of Array.from(devices)) {
        const at = lastActive(d) || d.createdAt || 0;
        if (now - at > DELETE_AFTER_DAYS * DAY_MS) {
            devices.delete(id);
            systemNumbersStale = true;
            n++;
            console.warn(`[users] Deleted device ${id} (${d.name}) — no contact for `
                + `${Math.floor((now - at) / DAY_MS)} days`);
        }
    }
    if (n || seen) markDirty();
    return n;
}

/**
 * The newest dashboard Clear Log this phone reports having carried out.
 *
 * In memory only, like lastSeen: it is re-reported on every poll, so a restart
 * costs one poll interval of "unknown", and persisting it would be a write per
 * device per poll.
 */
function noteCleared(deviceId, ts) {
    const d = devices.get(String(deviceId || ''));
    if (!d) return;
    // Reported at all — even 0 — means this app knows how to report. A phone
    // that never sends it (older than 4.33.0, or not polled since a restart)
    // is "unknown" on the dashboard, not "not done".
    d.clearReported = true;
    const n = Number(ts);
    if (!(n > 0)) return;
    if (!d.clearedTs || n > d.clearedTs) d.clearedTs = n;
}

/**
 * Admin pushes a username to one phone (server 4.38.0).
 *
 * =============================================================================
 * ONE ACTION, TWO EFFECTS — by Riad's decision:
 *   1. the device's OWNER is set to that user on the server, durably, now;
 *   2. the phone is told to write the same name into its Settings > Username,
 *      which is what the operator holding the phone sees.
 *
 * Delivery is FCM to the device's own topic AND the 30 s poll (pendingUsername
 * on /api/settings), so a phone without Play Services still gets it. It stays
 * pending until the phone REGISTERS with that name — see registerDevice — so the
 * dashboard can say "saved on phone" rather than "sent".
 *
 * Refused for a REMOVED device: it is gone until the app is reinstalled (4.39.0).
 * A removed id is not in `devices`, so the caller checks isRevoked first to give
 * that reason instead of "no such device".
 *
 * Pending state is in memory. A restart before the phone confirms loses only the
 * "waiting" line; the Owner assignment is already saved, and pushing again is
 * one click.
 * =============================================================================
 *
 * @returns {{ok:boolean, status?:number, error?:string, name?:string, ts?:number, device?:object}}
 */
function pushUsername(deviceId, userId) {
    const d = devices.get(String(deviceId || ''));
    if (!d) return { ok: false, status: 404, error: 'No such device' };
    const key = slug(userId);
    if (!key) return { ok: false, status: 400, error: 'Choose a user to push' };
    if (key === ADMIN_ID) {
        return { ok: false, status: 400, error: '"admin" is not a user account — '
            + 'admin signs in with the dashboard password, so a phone cannot claim it' };
    }
    const user = users.get(key);
    if (!user) return { ok: false, status: 400, error: 'No such user' };
    if (!user.active) return { ok: false, status: 400, error: 'That account is deactivated' };

    const assigned = assignDevice(d.id, key);
    if (!assigned.ok) return { ok: false, status: 400, error: assigned.error };

    const ts = Date.now();
    d.pendingUsername = { userId: key, name: user.name, ts };
    return { ok: true, name: user.name, ts, device: d };
}

/**
 * Withdraw every unconfirmed push of this user's name (deactivated or purged).
 * @param alsoAcks true on purge: a "saved on the phone" line naming an account
 *        that no longer exists would be stale the moment it rendered.
 */
function dropPushesFor(userId, alsoAcks) {
    for (const d of devices.values()) {
        if (d.pendingUsername && d.pendingUsername.userId === userId) d.pendingUsername = null;
        if (alsoAcks && d.usernameAck && d.usernameAck.userId === userId) d.usernameAck = null;
    }
}

/** What the poll should hand this phone, or null. */
function pendingUsernameFor(deviceId) {
    const d = devices.get(String(deviceId || ''));
    return d && d.pendingUsername
        ? { name: d.pendingUsername.name, ts: d.pendingUsername.ts } : null;
}

function assignDevice(deviceId, userId) {
    const d = devices.get(String(deviceId || ''));
    if (!d) return { ok: false, error: 'No such device' };
    if (userId === null || userId === '') {
        d.userId = null; systemNumbersStale = true; markDirty(); return { ok: true, device: d };
    }
    const key = slug(userId);
    if (key !== ADMIN_ID && !users.has(key)) return { ok: false, error: 'No such user' };
    d.userId = key;
    systemNumbersStale = true;
    markDirty();
    return { ok: true, device: d };
}

function renameDevice(deviceId, name) {
    const d = devices.get(String(deviceId || ''));
    if (!d) return { ok: false, error: 'No such device' };
    d.name = String(name || '').trim().slice(0, 64) || d.name;
    markDirty();
    return { ok: true, device: d };
}

/**
 * Remove a device AND remember that it was removed.
 *
 * The remembering is the whole feature — see the `revoked` map above. Without
 * it the same phone re-registers on its next process start and the removal is
 * undone by a reboot. It lasts until the app is reinstalled on that phone.
 */
function removeDevice(deviceId) {
    const id = String(deviceId || '');
    const d  = devices.get(id);
    if (!d) return { ok: false };
    devices.delete(id);
    systemNumbersStale = true;
    // The row is deleted for good (4.39.0): no "Allow back", no username way
    // back. Only the record of the removal is kept, with name and model for the
    // logs.
    // The install that was removed. Only a DIFFERENT install of this device id —
    // a reinstall — lifts it (see liftIfReinstalled). The old row is gone for
    // good: a reinstalled phone comes back as a new, unassigned device.
    //
    // Only an install CONFIRMED by a request to this process is recorded. The
    // stored installId can be stale — a reinstall seen while running from the
    // cache was never saved, and a reload put the old value back — and recording
    // a stale one let the SAME install's next poll lift its own removal (review
    // finding). Unknown is recorded as null and bound on first contact; see
    // liftIfReinstalled.
    // `hint` is the stored install, used only when nothing is confirmed: see
    // liftIfReinstalled.
    revoked.set(id, { at: Date.now(), installId: d.liveInstallId || null,
                      hint: d.liveInstallId ? null : (d.installId || null),
                      name: d.name || '', model: d.model || '' });
    markDirty();
    return { ok: true };
}

/** Is this id under a standing removal? */
function isRevoked(deviceId) {
    return revoked.has(String(deviceId || ''));
}

/**
 * The number this phone's SIM actually is, set by the admin.
 *
 * =============================================================================
 * WHY A HUMAN HAS TO TYPE THIS, AND WHY IT IS THE ONLY FIX AVAILABLE
 *
 * Bangladeshi carriers routinely do not write EF_MSISDN, so the phone cannot
 * read its own number. SmsReceiver then files the message as "Unknown", the
 * store keys it by device to stop two such phones colliding — and the result is
 * a message that is visible on the dashboard and UNFETCHABLE, because every
 * script asks GET /get?number=01XXXXXXXXX and nothing is stored under that key.
 * Worse, it looks exactly like "the SMS never arrived".
 *
 * No amount of server cleverness can map it, because the number is not in the
 * system: not in the SMS, not on the SIM, not in the app's prefs. It exists in
 * exactly one place — the head of the person holding the phone. So this is
 * where they put it, once, and every Unknown message from that device is filed
 * under the real number from then on.
 *
 * ONE NUMBER PER DEVICE, ON PURPOSE. A dual-SIM phone where NEITHER SIM
 * resolves and the broadcast carries no slot is genuinely ambiguous: filing
 * under one of the two would hand SIM 2's OTP to whoever asked for SIM 1, which
 * is the wrong-recipient failure the Unknown key exists to prevent. Refusing to
 * guess is the correct answer there, and leaving this blank is how you say so.
 * =============================================================================
 *
 * @param {string|null} number the SIM's number, or null/'' to clear it.
 */
function setDeviceSim(deviceId, number) {
    const d = devices.get(String(deviceId || ''));
    if (!d) return { ok: false, error: 'No such device' };

    const raw = String(number == null ? '' : number).trim();
    if (raw === '') {
        if (d.simNumber !== null) { d.simNumber = null; systemNumbersStale = true; markDirty(); }
        return { ok: true, device: d };
    }

    // Stored CANONICAL, because that is the key the store files under and the
    // key /get looks up. Accepting "+8801711111111" and storing it verbatim
    // would produce a device whose number is set and whose messages are still
    // unfetchable — the same bug, one layer further in.
    const canon = canonicalizePhone(raw);
    if (!/^01[0-9]{9}$/.test(canon)) {
        return { ok: false, error: 'Enter a Bangladeshi mobile number, e.g. 01711111111' };
    }

    // Two devices claiming one number would collide exactly as two "Unknown"
    // devices did — the thing this is here to stop.
    for (const other of devices.values()) {
        if (other.id !== d.id && other.simNumber === canon) {
            return { ok: false, error: `${canon} is already set on device "${other.name}". `
                + 'Two phones cannot share one number.' };
        }
    }

    if (d.simNumber !== canon) { d.simNumber = canon; systemNumbersStale = true; markDirty(); }
    return { ok: true, device: d };
}

/** @returns {string|null} canonical number, or null when nobody has set one. */
function simFor(deviceId) {
    const d = devices.get(String(deviceId || ''));
    return (d && d.simNumber) ? d.simNumber : null;
}

function getDevice(deviceId) { return devices.get(String(deviceId || '')) || null; }

/**
 * Every number some device holds -> which devices, for the duplicate warning.
 *
 * Both the phone's own report AND the admin's fallback number count: either
 * one on two devices is the "two phones, one number" collision. Built once per
 * listing — O(devices), and only on the admin's dashboard path.
 */
function numberHolders() {
    const now = Date.now();
    const map = new Map();
    const add = (num, d, slot) => {
        if (!num) return;
        if (!map.has(num)) map.set(num, []);
        map.get(num).push({ id: d.id, name: d.name, slot,
            inactive: now - (lastActive(d) || d.createdAt || 0) > HIDE_AFTER_DAYS * DAY_MS });
    };
    for (const d of devices.values()) {
        for (const s of (Array.isArray(d.sims) ? d.sims : [])) add(s.number, d, s.slot);
        add(d.simNumber, d, 0);       // 0 = the admin's fallback number
    }
    return map;
}

/** This device's numbers that some OTHER device also holds. */
function simConflictsFor(d, holders) {
    const out = [];
    const mine = new Set();
    for (const s of (Array.isArray(d.sims) ? d.sims : [])) if (s.number) mine.add(s.number);
    if (d.simNumber) mine.add(d.simNumber);
    for (const num of mine) {
        const others = (holders.get(num) || []).filter(h => h.id !== d.id);
        if (others.length) out.push({ number: num, devices: others });
    }
    return out;
}

function listDevices() {
    const holders = numberHolders();
    return Array.from(devices.values())
        .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
        .map(d => Object.assign({}, d, {
            liveInstallId: undefined, prevInstallId: undefined, installFlipAt: undefined,
            simConflicts: simConflictsFor(d, holders),
            lastActive: lastActive(d),
            inactive: Date.now() - (lastActive(d) || d.createdAt || 0) > HIDE_AFTER_DAYS * DAY_MS,
            effectiveOwner: ownerOf(d.id),
            claimStatus: claimStatus(d.id),
            ownerName: d.userId
                ? (d.userId === ADMIN_ID ? 'admin' : (users.get(d.userId) || {}).name || d.userId)
                : null
        }));
}

/**
 * Which user owns the device that sent this message.
 *
 * Falls back to admin for an unknown or absent device, because I8 says an older
 * app — which sends no deviceId at all — must keep working. Nothing is ever
 * dropped for want of identity.
 */
/**
 * Whose message this is.
 *
 * PRECEDENCE, and the order is the whole rule:
 *   1. the ADMIN'S ASSIGNMENT. Always wins. It is the only side that can be
 *      corrected without touching the phone.
 *   2. the phone's CLAIM, but only if it names a real, active user.
 *   3. admin.
 *
 * Falls through to admin for an unknown device, an absent one (an older app
 * sends no deviceId at all — I8), a claim naming nobody, or a deactivated
 * owner. NOTHING is ever dropped for want of identity: an unowned message still
 * arrives, it just arrives to admin.
 */
function ownerOf(deviceId) {
    const d = devices.get(String(deviceId || ''));
    if (!d) return ADMIN_ID;

    if (d.userId && isActive(d.userId)) return d.userId;

    const claim = d.claimedUserId;
    if (claim && !claim.startsWith('?') && users.has(claim) && isActive(claim)) return claim;

    return ADMIN_ID;
}

/**
 * What to tell the phone about its claim, so a typo is visible in Settings
 * rather than discovered later from messages filed under the wrong owner.
 */
function claimStatus(deviceId) {
    const d = devices.get(String(deviceId || ''));
    if (!d) return '';
    if (d.userId) {
        return d.claimedUserId && !d.claimedUserId.startsWith('?') && d.claimedUserId !== d.userId
            ? 'overridden'     // admin assigned someone else; the dashboard wins
            : 'assigned';
    }
    if (!d.claimedUserId) return 'unassigned';
    if (d.claimedUserId.startsWith('?')) return 'unknown_user';
    return isActive(d.claimedUserId) ? 'claimed' : 'inactive_user';
}

/**
 * A human label for a device, for the dashboard.
 * "Unknown-<hex>" tells you nothing; "Unknown (riad · Galaxy A14)" tells you
 * whose phone had an unresolved SIM.
 */
function deviceLabel(deviceId) {
    const d = devices.get(String(deviceId || ''));
    if (!d) return 'unregistered device';
    const owner = d.userId
        ? (d.userId === ADMIN_ID ? 'admin' : (users.get(d.userId) || {}).name || d.userId)
        : 'unassigned';
    return `${owner} · ${d.name}`;
}

// ─── Allowed hosts ──────────────────────────────────────────────
//
// Served to the app on /api/settings so a new server becomes a dashboard edit
// rather than a reinstall. The app keeps its COMPILED-IN host as a permanent
// anchor that no remote list can remove — so a bad list, or an unreachable
// server, can never strand a phone.

function getAllowedHosts() { return allowedHosts.slice(); }

function setAllowedHosts(list) {
    if (!Array.isArray(list)) return { ok: false, error: 'hosts must be an array' };
    const clean = [];
    for (const h of list) {
        const host = String(h || '').trim().toLowerCase()
            .replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        if (!host) continue;
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) {
            return { ok: false, error: `"${h}" does not look like a host name` };
        }
        if (!clean.includes(host)) clean.push(host);
    }
    allowedHosts = clean;
    markDirty();
    return { ok: true, hosts: getAllowedHosts() };
}

// ─── Persistence ────────────────────────────────────────────────

/**
 * The persisted shape of ONE device — the single definition of "what the
 * snapshot carries about a phone".
 *
 * lastSeen is deliberately absent. It is refreshed by the next poll within 30
 * seconds of any restart, and persisting it would mean a Firestore write per
 * device per poll. registerDevice compares this to decide whether a
 * re-registration is worth a write at all, so anything added here starts being
 * persisted AND starts counting as a change, in one place, automatically.
 */
function durableDevice(d) {
    return {
        id: d.id, name: d.name, userId: d.userId || null,
        claimedUserId: d.claimedUserId || null, model: d.model,
        // The number this phone's SIM actually is, when the phone itself cannot
        // find out. See setDeviceSim.
        simNumber: d.simNumber || null,
        createdAt: d.createdAt,
        // Which install of this device, so a removal can tell a reinstall apart
        // from the same app still running (4.39.0).
        installId: d.installId || null,
        // Coarse last contact, so inactivity survives a restart (4.39.0).
        seenAt: d.seenAt || 0,
        // What the phone reports is in its SIM slots, and the last few changes
        // to that (4.40.0). See applySimReport.
        sims: Array.isArray(d.sims) ? d.sims : null,
        simLog: Array.isArray(d.simLog) ? d.simLog : [],
        // Whether the phone can send for the dashboard, and which app it runs
        // (4.41.0) — so "why can't I pick this SIM?" has an answer after a restart.
        canSendSms: typeof d.canSendSms === 'boolean' ? d.canSendSms : null,
        appVersion: d.appVersion || ''
    };
}

/** Everything that must survive a redeploy. lastSeen deliberately excluded. */
function snapshot() {
    return {
        users: Array.from(users.values()).map(u => ({
            id: u.id, name: u.name, passwordHash: u.passwordHash,
            enrollCode: u.enrollCode, role: u.role, active: u.active,
            createdAt: u.createdAt,
            sendEnabled: !!u.sendEnabled, sendDailyLimit: sendLimitOf(u)
        })),
        devices: Array.from(devices.values()).map(durableDevice),
        // A revocation a redeploy undoes is not a revocation.
        revokedDevices: Array.from(revoked.entries())
            .map(([id, r]) => ({ id, at: r.at, installId: r.installId || null,
                                 hint: r.hint || null,
                                 name: r.name || '', model: r.model || '' })),
        allowedHosts: getAllowedHosts()
    };
}

/**
 * Populate from a LOCAL CACHE without declaring the state authoritative.
 *
 * =============================================================================
 * WHY THIS IS NOT load()
 *
 * The config has had a state-file cache since 4.20.0, so a Firestore outage
 * costs it nothing. Identity had NONE — if the boot read failed, there were
 * simply no users: nobody could log in, the dashboard showed an empty roster,
 * and it looked exactly like the accounts had been deleted. Four times.
 *
 * This loads the cache so the system WORKS, and deliberately leaves loadedOk
 * false so nothing is written back. We can serve from a cache we are not sure
 * is current; we must not overwrite Firestore with it.
 * =============================================================================
 */
function loadCache(data) {
    if (!data || typeof data !== 'object') return { users: 0, devices: 0 };
    // The read-only flag is set INSIDE load now, not after it. It used to be
    // cleared here, one statement later — which was fine while load() did
    // nothing but assign, and would not be once load() could persist: the
    // carried-device write below would have fired with loadedOk still true and
    // pushed the cache straight back over Firestore.
    return load(data, true);
}

/**
 * Replace in-memory state from a stored snapshot. Tolerates partial data.
 *
 * @param {boolean} [fromCache] true when the source is the LOCAL CACHE rather
 *        than Firestore. Leaves the state read-only (loadedOk false) and
 *        suppresses the carried-device write below, so a snapshot we are not
 *        sure is current can be served but never written back. loadCache() is
 *        the only caller that passes it.
 */
/**
 * Per-device state that is deliberately NOT persisted — re-earned from the
 * phone — but must not be thrown away by an in-process reload ("Retry now"),
 * which rebuilds the device rows from storage. Dropping it made a push the
 * phone had not yet received vanish from the dashboard, and blanked every
 * "online" and "log cleared" line until the next poll.
 */
const TRANSIENT_DEVICE_FIELDS = ['lastSeen', 'pendingUsername', 'usernameAck',
                                 'clearedTs', 'clearReported',
                                 // which install is really talking to us (4.39.0)
                                 'liveInstallId', 'prevInstallId', 'installFlipAt',
                                 'sharedId', 'simsLiveAt'];

function load(data, fromCache) {
    if (!data || typeof data !== 'object') return { users: 0, devices: 0 };
    const transient = new Map();
    // ═════════════════════════════════════════════════════════════════
    // SIMS THE PHONE REPORTED TO THIS PROCESS OUTRANK THE STORED COPY (4.40.0)
    //
    // Same shape as installId above. While identity runs from the local cache
    // (Firestore slow at boot), a phone that registers has its report applied
    // in memory and the write correctly REFUSED. The real load then replaces
    // memory with the stored document — older — and the phone, having been
    // told "OK", does not send it again until something changes. The dashboard
    // would show the old SIM until then. So the live report is carried across
    // and saved.
    // ═════════════════════════════════════════════════════════════════
    const liveSims = new Map();
    for (const d of devices.values()) {
        const t = {};
        for (const k of TRANSIENT_DEVICE_FIELDS) if (d[k] !== undefined) t[k] = d[k];
        transient.set(d.id, t);
        if (d.simsLiveAt && Array.isArray(d.sims)) {
            // Everything the same registration reported travels together
            // (review #4): carrying the SIMs but not canSendSms/appVersion left
            // a phone looking "too old to send" until its next restart.
            liveSims.set(d.id, { sims: d.sims, simLog: Array.isArray(d.simLog) ? d.simLog : [],
                                 canSendSms: d.canSendSms, appVersion: d.appVersion });
        }
    }
    // Snapshot before clearing — see registeredMeanwhile below.
    for (const d of devices.values()) carriedDevices.set(d.id, d);
    users.clear();
    devices.clear();
    revoked.clear();
    systemNumbersStale = true;

    for (const r of (Array.isArray(data.revokedDevices) ? data.revokedDevices : [])) {
        if (!r || !r.id) continue;
        // Older snapshots carry `device:{...}` (4.36–4.38) or name/model (4.35);
        // all are read, so an upgrade never loses a standing removal. A record
        // with no installId is never lifted by a reinstall — see the header.
        const dv = r.device || {};
        revoked.set(String(r.id), {
            at: r.at || Date.now(),
            installId: validInstall(r.installId) ? r.installId.toLowerCase() : null,
            hint: validInstall(r.hint) ? r.hint.toLowerCase() : null,
            name: r.name || dv.name || '', model: r.model || dv.model || ''
        });
    }

    for (const u of (Array.isArray(data.users) ? data.users : [])) {
        if (!u || !u.id) continue;
        users.set(u.id, {
            id: u.id,
            name: u.name || u.id,
            passwordHash: u.passwordHash || null,
            enrollCode: u.enrollCode || null,
            role: u.role === 'admin' ? 'user' : (u.role || 'user'),   // admin is env-only
            active: u.active !== false,
            createdAt: u.createdAt || Date.now(),
            // Absent before 4.41.0: sending stays OFF for every existing user.
            sendEnabled: u.sendEnabled === true,
            sendDailyLimit: clampSendLimit(u.sendDailyLimit)
        });
    }
    // Devices that registered WHILE the identity load was in flight would be
    // erased by this clear() with nothing to bring them back — the phone had
    // already been told its id, so it never registers again until a restart.
    // Carry them over; the stored copy wins wherever both exist.
    const registeredMeanwhile = Array.from(carriedDevices.values());

    for (const d of (Array.isArray(data.devices) ? data.devices : [])) {
        if (!d || !d.id) continue;
        devices.set(d.id, {
            id: d.id,
            name: d.name || ('Device ' + String(d.id).slice(0, 6)),
            userId: d.userId || null,
            claimedUserId: d.claimedUserId || null,
            model: d.model || '',
            simNumber: d.simNumber || null,
            createdAt: d.createdAt || Date.now(),
            lastSeen: 0,                         // never restored; earned by a poll
            installId: validInstall(d.installId) ? d.installId.toLowerCase() : null,
            // Upgrading from before 4.39.0 there is no seenAt: start the clock
            // NOW rather than at zero, or every device would be deleted on the
            // first sweep after the upgrade.
            seenAt: d.seenAt || Date.now(),
            // Before 4.40.0 there is no report: null, "this phone has not said",
            // which the dashboard shows differently from two empty slots.
            sims: Array.isArray(d.sims) ? normalizeSimReport(d.sims, Date.now()) : null,
            simLog: cleanSimLog(d.simLog),
            canSendSms: typeof d.canSendSms === 'boolean' ? d.canSendSms : null,
            appVersion: typeof d.appVersion === 'string' ? d.appVersion.slice(0, 24) : ''
        });
    }
    let carriedOver = 0;
    for (const d of registeredMeanwhile) {
        // A device revoked in the stored copy must not be carried back in by a
        // registration that raced the load — UNLESS that registration came from
        // a different install than the one removed: a reinstall lifted the
        // removal while we ran from the cache, and the lift was never saved.
        if (revoked.has(d.id)) {
            const rec = revoked.get(d.id);
            if (!(rec.installId && validInstall(d.liveInstallId)
                    && d.liveInstallId !== rec.installId)) continue;
            revoked.delete(d.id);
            devices.delete(d.id);
            console.warn(`[users] Kept the reinstall of ${d.id} that lifted its removal during the load`);
        }
        if (!devices.has(d.id)) {
            devices.set(d.id, d);
            carriedOver++;
            console.warn(`[users] Kept device ${d.id} that registered during the load`);
        }
    }
    carriedDevices.clear();
    let installFixed = 0;
    let simsFixed = 0;
    for (const [id, t] of transient) {
        const d = devices.get(id);
        if (!d) continue;
        Object.assign(d, t);
        // The install that is actually talking to us outranks a stored one that
        // a refused write left behind (review finding).
        if (validInstall(d.liveInstallId) && d.installId !== d.liveInstallId && !d.sharedId) {
            d.installId = d.liveInstallId;
            installFixed++;
        }
        const live = liveSims.get(id);
        if (live && JSON.stringify(live.sims) !== JSON.stringify(d.sims)) {
            d.sims = live.sims;
            d.simLog = live.simLog;
            systemNumbersStale = true;
            simsFixed++;
        }
        if (live && typeof live.canSendSms === 'boolean'
                && (live.canSendSms !== d.canSendSms || (live.appVersion || '') !== (d.appVersion || ''))) {
            d.canSendSms = live.canSendSms;
            d.appVersion = live.appVersion || '';
            simsFixed++;
        }
    }

    allowedHosts = Array.isArray(data.allowedHosts) ? data.allowedHosts.slice() : [];
    // Only a SUCCESSFUL load reaches here, so writes are safe from now on. A
    // genuinely empty store is fine — we know it is empty rather than unknown.
    loadedOk = !fromCache;

    // ═════════════════════════════════════════════════════════════════
    // A CARRIED DEVICE HAS NEVER BEEN PERSISTED. PERSIST IT NOW.
    //
    // It registered while the load was in flight, so markDirty() was correctly
    // refused (loadedOk was false) and the stored document knows nothing about
    // it. It used to be picked up by luck: registerDevice marked dirty on every
    // call, so the phone's next process start wrote it. Now that a
    // re-registration with nothing new to say does NOT write, that luck is gone
    // and the row would live in memory until the next restart erased it.
    //
    // Skipped for a CACHE load, which must stay read-only — pushing a snapshot
    // we are not sure is current back over Firestore is the whole thing
    // loadCache exists to avoid.
    // ═════════════════════════════════════════════════════════════════
    if (!fromCache && (carriedOver > 0 || installFixed > 0 || simsFixed > 0)) markDirty();

    return { users: users.size, devices: devices.size };
}

function stats() {
    const now = Date.now();
    return {
        // The dashboard's target dropdown needs actual names to offer. It read
        // `userList` and nothing ever sent it, so "Test / Get latest for one
        // user" was implemented on the server and invisible in the UI — the
        // control offered "All users" and nothing else.
        //
        // Only ACTIVE users: aiming a command at a deactivated account would
        // reach phones that are filing to admin anyway.
        userList: Array.from(users.values())
            .filter(u => u.active)
            .sort((a, b) => a.id.localeCompare(b.id))
            .map(u => ({ id: u.id, name: u.name })),
        users: users.size,
        activeUsers: Array.from(users.values()).filter(u => u.active).length,
        devices: devices.size,
        devicesSeenRecently: Array.from(devices.values())
            .filter(d => d.lastSeen && now - d.lastSeen < 120_000).length,
        unassignedDevices: Array.from(devices.values()).filter(d => !d.userId).length,
        allowedHosts: allowedHosts.length,
        dirty
    };
}

module.exports = {
    ADMIN_ID, setPersister, load, loadCache, snapshot, stats,
    isLoaded: () => loadedOk,
    createUser, setPassword, reissueCode, setActive, purgeUser,
    getUser, isActive, listUsers, authenticate, slug,
    registerDevice, touchDevice, assignDevice, renameDevice, removeDevice,
    noteCleared, pushUsername, pendingUsernameFor,
    setDeviceSim, simFor, isRevoked, noteInstall, sweepInactive,
    HIDE_AFTER_DAYS, DELETE_AFTER_DAYS,
    /** Changes whenever any device's reported SIMs change (4.40.0). */
    simsVersion: () => simsVersion,
    SIM_LOG_MAX, normalizeSimReport,
    setSendPermission, sendPolicy, isSystemNumber,
    DEFAULT_SEND_DAILY_LIMIT, MAX_SEND_DAILY_LIMIT,
    /** Every device as stored, for the outbox's sender/recipient checks. */
    allDevices: () => Array.from(devices.values()),
    getDevice, listDevices, ownerOf, deviceLabel, claimStatus,
    getAllowedHosts, setAllowedHosts,
    // exported for tests
    hashPassword, verifyPassword, newEnrollCode
};
