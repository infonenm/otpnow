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
 *   devices[id]  = { id, name, userId, model, lastSeen, createdAt }
 *   allowedHosts = [ "otpnow.onrender.com", ... ]
 *
 * ADMIN IS NOT A RECORD. The admin authenticates with DASHBOARD_PASSWORD from
 * the environment, exactly as today. Making admin an ordinary row would mean a
 * Firestore outage, or one bad write, could lock you out of your own dashboard —
 * and the recovery would be an env var anyway. So the env var IS the recovery
 * path, permanently. Admin cannot be deactivated, deleted, or demoted.
 */

const crypto = require('crypto');

const ADMIN_ID = 'admin';

// ─── In-memory state ────────────────────────────────────────────
const users   = new Map();   // id -> user
const devices = new Map();   // id -> device
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
        createdAt: Date.now()
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
 * Their DEVICES keep forwarding, and their messages file to admin. Nothing stops
 * arriving while you work out who should own that phone, and a phone that has
 * been force-stopped by a battery manager could not have been told anyway —
 * which is exactly why this is enforced server-side.
 */
function setActive(id, active) {
    const user = users.get(slug(id));
    if (!user) return { ok: false, error: 'No such user' };
    user.active = !!active;
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
        deviceCount: Array.from(devices.values()).filter(d => d.userId === u.id).length
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

    const existing = devices.get(id);
    const device = existing || {
        id, name: '', userId: null, claimedUserId: null,
        model: '', createdAt: Date.now(), lastSeen: 0
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
    device.lastSeen = Date.now();

    devices.set(id, device);

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
 * lastSeen, from the poll the app already makes. No new mechanism, no new
 * request, and it is what answers "which phones are alive?" on the dashboard.
 *
 * NOT persisted on every touch — that would be a Firestore write every 30
 * seconds per device. It is in-memory only and refreshed within 30s of any
 * restart, which is what the field is for.
 */
function touchDevice(deviceId) {
    const d = devices.get(String(deviceId || ''));
    if (d) d.lastSeen = Date.now();
    return d || null;
}

function assignDevice(deviceId, userId) {
    const d = devices.get(String(deviceId || ''));
    if (!d) return { ok: false, error: 'No such device' };
    if (userId === null || userId === '') {
        d.userId = null; markDirty(); return { ok: true, device: d };
    }
    const key = slug(userId);
    if (key !== ADMIN_ID && !users.has(key)) return { ok: false, error: 'No such user' };
    d.userId = key;
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

function removeDevice(deviceId) {
    const ok = devices.delete(String(deviceId || ''));
    if (ok) markDirty();
    return { ok };
}

function getDevice(deviceId) { return devices.get(String(deviceId || '')) || null; }

function listDevices() {
    return Array.from(devices.values())
        .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
        .map(d => Object.assign({}, d, {
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
        createdAt: d.createdAt
    };
}

/** Everything that must survive a redeploy. lastSeen deliberately excluded. */
function snapshot() {
    return {
        users: Array.from(users.values()).map(u => ({
            id: u.id, name: u.name, passwordHash: u.passwordHash,
            enrollCode: u.enrollCode, role: u.role, active: u.active,
            createdAt: u.createdAt
        })),
        devices: Array.from(devices.values()).map(durableDevice),
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
function load(data, fromCache) {
    if (!data || typeof data !== 'object') return { users: 0, devices: 0 };
    // Snapshot before clearing — see registeredMeanwhile below.
    for (const d of devices.values()) carriedDevices.set(d.id, d);
    users.clear();
    devices.clear();

    for (const u of (Array.isArray(data.users) ? data.users : [])) {
        if (!u || !u.id) continue;
        users.set(u.id, {
            id: u.id,
            name: u.name || u.id,
            passwordHash: u.passwordHash || null,
            enrollCode: u.enrollCode || null,
            role: u.role === 'admin' ? 'user' : (u.role || 'user'),   // admin is env-only
            active: u.active !== false,
            createdAt: u.createdAt || Date.now()
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
            createdAt: d.createdAt || Date.now(),
            lastSeen: 0                          // never restored; earned by a poll
        });
    }
    let carriedOver = 0;
    for (const d of registeredMeanwhile) {
        if (!devices.has(d.id)) {
            devices.set(d.id, d);
            carriedOver++;
            console.warn(`[users] Kept device ${d.id} that registered during the load`);
        }
    }
    carriedDevices.clear();

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
    if (!fromCache && carriedOver > 0) markDirty();

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
    getDevice, listDevices, ownerOf, deviceLabel, claimStatus,
    getAllowedHosts, setAllowedHosts,
    // exported for tests
    hashPassword, verifyPassword, newEnrollCode
};
