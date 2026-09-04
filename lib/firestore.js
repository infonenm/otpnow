/**
 * lib/firestore.js — durable config storage.
 *
 * =============================================================================
 * WHY FIREBASE IS BACK, AND WHY THIS IS NOT THE OLD MISTAKE
 *
 * This project deliberately removed Firebase RTDB. The reason was that RTDB
 * listeners sat on the MESSAGE path — every SMS touched the network twice, and
 * that is what made the old system slow.
 *
 * This is the opposite shape:
 *
 *   READ   once, at boot, asynchronously, never blocking anything
 *   WRITE  only when the operator changes a setting, debounced, never awaited
 *   NEVER  on POST /sms, on GET /get, on the long-poll path, or on any request
 *
 * The in-memory `settings` object remains the single source of truth for
 * everything the server actually does. Firestore is where that object is
 * SAVED, nothing more. If Firestore vanished mid-flight, the server would keep
 * serving OTPs at exactly today's speed and you would find out from a log line.
 *
 * test/firestore.test.js asserts the "never" line above by counting calls
 * across a full /sms -> /get cycle. That count must be zero.
 * =============================================================================
 *
 * CREDENTIAL: the same FIREBASE_SERVICE_ACCOUNT already used for FCM. A service
 * account grants the whole project, so Firestore needs no new secret, no new
 * signup and no new bill.
 */

const DOC_COLLECTION = 'getotp';
const DOC_ID         = 'config';

/**
 * Ceiling on a Firestore call.
 *
 * =============================================================================
 * THIS WAS 3 SECONDS AND IT COST THREE ROUNDS OF DATA "LOSS".
 *
 * A cold Render container's FIRST Firestore call is not one round trip: it
 * fetches an OAuth token, opens a gRPC channel and completes a TLS handshake,
 * and only then queries. Several seconds is ordinary. Three seconds was not a
 * safety margin, it was a coin flip — and losing it meant the config and the
 * user table never loaded, so the dashboard showed env defaults and no users
 * while Firestore still held everything.
 *
 * NOTHING WAITS ON THIS. The server is already listening, forwarding and
 * serving OTPs before the first Firestore call is made. A longer ceiling costs
 * nothing at all; a short one costs the entire feature.
 *
 * The one thing that IS bounded tightly is extraction during the cold-start
 * window — MAX_DEFERRAL_MS in store.js, still 3s — because that one really does
 * hold something up.
 * =============================================================================
 */
const READ_TIMEOUT_MS = 20000;

/** Coalesce a burst of saves (adding three patterns in a row) into one write. */
const WRITE_DEBOUNCE_MS = 2000;

let db      = null;
let enabled = false;

const status = {
    enabled:     false,
    configured:  false,
    lastReadAt:  0,
    lastReadOk:  null,
    lastWriteAt: 0,
    lastWriteOk: null,
    lastError:   null,
    /**
     * TWO FLAGS, NOT ONE.
     *
     * pendingWrite was shared between config and identity, so a successful
     * identity write cleared the indicator for a config write that had failed —
     * and the dashboard then reported everything saved while a filter set was
     * still only in memory.
     */
    pendingConfig:   false,
    pendingIdentity: false,
    get pendingWrite() { return this.pendingConfig || this.pendingIdentity; }
};

/**
 * Retry a failed durable write, with backoff.
 *
 * =============================================================================
 * A FAILED WRITE USED TO BE THROWN AWAY
 *
 * flushWrite() nulled the pending value BEFORE awaiting the network call, so a
 * single timeout discarded the data outright. One slow moment while creating a
 * user and that account existed only in memory — until the next restart, which
 * removed it. Exactly the shape of failure that cost three evenings on the read
 * side, sitting unnoticed on the write side.
 *
 * The value is now kept until a write actually succeeds, and retried.
 * =============================================================================
 */
const WRITE_RETRY_MS = [2000, 5000, 15000, 30000];

/**
 * Enable only when explicitly switched on AND a credential exists.
 *
 * Off by default so this whole phase is inert until you flip one env var, and
 * so rollback is that env var rather than a redeploy.
 */
function init() {
    const flag = String(process.env.FIRESTORE_ENABLED || '').trim().toLowerCase();
    if (flag !== 'true' && flag !== '1' && flag !== 'yes') {
        console.log('[firestore] FIRESTORE_ENABLED not set — config stays in the state file');
        return;
    }
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
        console.error('[firestore] FIRESTORE_ENABLED is on but FIREBASE_SERVICE_ACCOUNT is '
            + 'unset — cannot store config durably. Falling back to the state file.');
        return;
    }

    try {
        const admin = require('firebase-admin');
        // fcm.init() may already have done this with the same credential. Two
        // initializeApp() calls throw, so reuse whatever is there.
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(
                    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
            });
        }
        db = admin.firestore();
        enabled = true;
        status.enabled = true;
        status.configured = true;
        console.log('[firestore] Enabled — config will persist across redeploys');
    } catch (e) {
        console.error(`[firestore] Init failed — config stays in the state file: ${e.message}`);
        status.lastError = e.message;
    }
}

function isEnabled() { return enabled; }

/**
 * Read the config document.
 *
 * Never throws and never hangs: a timeout resolves null rather than rejecting,
 * because every caller's correct response to "no answer" is identical to its
 * response to "no document" — carry on with what it already has.
 *
 * @returns {Promise<object|null>}
 */
/**
 * @returns {Promise<{ok:boolean, data:object|null}>}
 *
 * =============================================================================
 * ok AND data ARE SEPARATE ANSWERS, AND CONFLATING THEM DESTROYED REAL CONFIG
 *
 * This used to return null for BOTH "the document does not exist" and "the read
 * failed". The caller then could not tell them apart — and its response to
 * "does not exist" is to MIGRATE, writing whatever config it currently holds up
 * to Firestore.
 *
 * On a fresh container that config is the env default: the catch-all. So a
 * single slow or failed read at boot — a cold Render instance meeting a cold
 * Firestore connection, which is exactly when it is most likely — caused the
 * server to overwrite a saved filter set with `(\d{4,8})`. Silently, and
 * permanently, because the good copy was the thing being replaced.
 *
 * Observed in production on the first cold start after enabling Firestore.
 *
 *   ok:true,  data:{...}  the config, use it
 *   ok:true,  data:null   the document genuinely is not there — safe to migrate
 *   ok:false, data:null   we do not know. TOUCH NOTHING.
 * =============================================================================
 */
async function readConfig() {
    if (!enabled) return { ok: false, data: null };
    status.lastReadAt = Date.now();

    try {
        const snapshot = await withTimeout(
            db.collection(DOC_COLLECTION).doc(DOC_ID).get(), READ_TIMEOUT_MS, 'read');

        status.lastReadOk = true;
        status.lastError  = null;
        if (!snapshot || !snapshot.exists) return { ok: true, data: null };
        return { ok: true, data: snapshot.data() || null };
    } catch (e) {
        status.lastReadOk = false;
        status.lastError  = explain(e.message);
        console.error(`[firestore] Config read failed (${e.message}) — using local state, `
            + `and NOT migrating: a failed read must never be mistaken for an empty one`);
        return { ok: false, data: null };
    }
}

// ── Writes ──────────────────────────────────────────────────────
//
// Debounced and fire-and-forget. The dashboard's response must never wait on
// Google: a save that is durable one second later is fine, a save that makes
// the UI hang is not.
//
// pendingWrite is what stops this repeating the saveConfig() mistake of 4.26.0 —
// reporting a save that did not happen. It is exposed on /api/full-settings so
// the dashboard can say "saved locally, not yet in the cloud" truthfully.

let writeTimer   = null;
let pendingValue = null;

function writeConfig(config, updatedBy) {
    if (!enabled) return;
    pendingValue = { config, updatedBy: updatedBy || 'dashboard' };
    status.pendingConfig = true;

    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(flushWrite, WRITE_DEBOUNCE_MS);
    if (typeof writeTimer.unref === 'function') writeTimer.unref();
}

/** Write immediately, bypassing the debounce. Used by the boot migration. */
async function writeConfigNow(config, updatedBy) {
    if (!enabled) return false;
    pendingValue = { config, updatedBy: updatedBy || 'migration' };
    return flushWrite();
}

let configRetries = 0;

async function flushWrite() {
    if (!enabled || !pendingValue) return false;
    // NOT cleared here. Only a successful write may drop it.
    const { config, updatedBy } = pendingValue;
    status.lastWriteAt = Date.now();

    try {
        await withTimeout(db.collection(DOC_COLLECTION).doc(DOC_ID).set({
            filters:           config.filters,
            globalForwarding:  config.globalForwarding,
            autoDeleteMinutes: config.autoDeleteMinutes,
            updatedAt:         Date.now(),
            updatedBy
        }), READ_TIMEOUT_MS, 'write');

        status.lastWriteOk    = true;
        status.pendingConfig  = false;
        status.lastError      = null;
        pendingValue = null;          // only now
        configRetries = 0;
        console.log(`[firestore] Config saved (${updatedBy})`);
        return true;
    } catch (e) {
        status.lastWriteOk   = false;
        status.lastError     = explain(e.message);
        // pendingConfig stays true AND the value is kept, so the next attempt
        // has something to write. Retry with backoff rather than dropping it.
        const wait = WRITE_RETRY_MS[Math.min(configRetries++, WRITE_RETRY_MS.length - 1)];
        console.error(`[firestore] Config write FAILED — retrying in ${wait / 1000}s\n  `
            + explain(e.message));
        const t = setTimeout(flushWrite, wait);
        if (typeof t.unref === 'function') t.unref();
        return false;
    }
}

/**
 * Turn a Firestore error into something you can act on.
 *
 * The raw text is a gRPC status — "5 NOT_FOUND:", often with nothing after the
 * colon. That is not a diagnosis, it is a code, and the operator reading it on
 * the dashboard has no way to know that the cure is "create the database in the
 * Firebase console". Each of these was hit for real or is one step away from it.
 */
function explain(message) {
    const m = String(message || '');
    if (/NOT_FOUND/i.test(m)) {
        return 'Firestore database does not exist. Enabling FCM does NOT create one — '
             + 'go to the Firebase console, Build > Firestore Database > Create database, '
             + 'and pick asia-southeast1 (Singapore). If it already exists, check it is '
             + 'in Firestore mode, not Datastore mode. (' + m + ')';
    }
    if (/PERMISSION_DENIED/i.test(m)) {
        return 'The service account is not allowed to use Firestore. Give it the '
             + '"Cloud Datastore User" role in the Google Cloud console. (' + m + ')';
    }
    if (/UNAUTHENTICATED/i.test(m)) {
        return 'FIREBASE_SERVICE_ACCOUNT was rejected. It may be for a different '
             + 'project, or the key may have been revoked. (' + m + ')';
    }
    if (/timed out/i.test(m)) {
        return 'Firestore did not answer in time. Config is running from the local '
             + 'state file; nothing about OTP delivery is affected. (' + m + ')';
    }
    return m;
}

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Firestore ${label} timed out after ${ms}ms`)), ms))
    ]);
}

// ─── Identity document ──────────────────────────────────────────
//
// A SECOND document, not a bigger first one. Config and identity change for
// different reasons and at different times; one document would mean every
// filter edit rewrites the user table and vice versa, and a bad write would
// take both down together.

const IDENTITY_ID = 'identity';
let identityTimer = null;
let identityPending = null;

/**
 * @returns {Promise<{ok:boolean, data:object|null}>}
 *
 * Same contract as readConfig, and for a worse reason. This used to return null
 * for both "no document" and "read failed", and the caller's response was
 * `users.load(data || {})` — which CLEARS the user and device maps. Any change
 * afterwards (a device registering, which happens by itself) then wrote the
 * empty set back to Firestore.
 *
 * So a single failed read at boot did not merely start empty: it PERMANENTLY
 * DELETED every user account. Observed in production.
 */
async function readIdentity() {
    if (!enabled) return { ok: false, data: null };
    try {
        const snap = await withTimeout(
            db.collection(DOC_COLLECTION).doc(IDENTITY_ID).get(), READ_TIMEOUT_MS, 'identity read');
        if (!snap || !snap.exists) return { ok: true, data: null };
        return { ok: true, data: snap.data() || null };
    } catch (e) {
        status.lastError = explain(e.message);
        console.error(`[firestore] Identity read failed (${e.message}) — keeping whatever is `
            + `in memory and REFUSING to write, so nothing can be overwritten`);
        return { ok: false, data: null };
    }
}

/** Debounced and unawaited, exactly like the config write. */
function writeIdentity(data) {
    if (!enabled) return;
    identityPending = data;
    status.pendingIdentity = true;
    if (identityTimer) clearTimeout(identityTimer);
    identityTimer = setTimeout(flushIdentity, WRITE_DEBOUNCE_MS);
    if (typeof identityTimer.unref === 'function') identityTimer.unref();
}

let identityRetries = 0;

async function flushIdentity() {
    if (!enabled || !identityPending) return false;
    const data = identityPending;      // kept until the write succeeds
    try {
        await withTimeout(db.collection(DOC_COLLECTION).doc(IDENTITY_ID).set(
            Object.assign({}, data, { updatedAt: Date.now() })), READ_TIMEOUT_MS, 'identity write');
        status.lastWriteAt      = Date.now();
        status.lastWriteOk      = true;
        status.pendingIdentity  = false;
        identityPending = null;        // only now
        identityRetries = 0;
        console.log(`[firestore] Identity saved (${(data.users || []).length} user(s), `
            + `${(data.devices || []).length} device(s))`);
        return true;
    } catch (e) {
        status.lastWriteOk = false;
        status.lastError = explain(e.message);
        const wait = WRITE_RETRY_MS[Math.min(identityRetries++, WRITE_RETRY_MS.length - 1)];
        console.error(`[firestore] Identity write FAILED — retrying in ${wait / 1000}s. `
            + `The account exists in memory only until this succeeds.\n  ` + explain(e.message));
        const t = setTimeout(flushIdentity, wait);
        if (typeof t.unref === 'function') t.unref();
        return false;
    }
}

// ─── History (batched writes, on-demand reads) ──────────────────
//
// A COLLECTION, unlike config and identity, because entries are many and are
// queried by range. Written in batches from the deferred flush; read only when
// the admin opens the History tab. Nothing here is on a request path that an
// OTP travels.

async function writeHistory(collection, entries) {
    if (!enabled) throw new Error('Firestore is not enabled');
    const batch = db.batch();
    for (const e of entries) {
        batch.set(db.collection(collection).doc(e.smsId), e);
    }
    await withTimeout(batch.commit(), READ_TIMEOUT_MS * 2, 'history write');
    status.lastWriteAt = Date.now();
    status.lastWriteOk = true;
}

/**
 * @param {object} q  { userId, from, to, limit }
 *
 * Ordered by receivedAt descending. With a userId this needs the composite
 * index (userId + receivedAt) — Firestore refuses the query without it and the
 * error names the index, so it is not a silent failure.
 */
async function queryHistory(collection, q) {
    if (!enabled) return [];
    let ref = db.collection(collection);
    if (q.userId) ref = ref.where('userId', '==', q.userId);
    if (q.from)   ref = ref.where('receivedAt', '>=', Number(q.from));
    if (q.to)     ref = ref.where('receivedAt', '<=', Number(q.to));
    ref = ref.orderBy('receivedAt', 'desc').limit(Math.min(Number(q.limit) || 200, 500));

    const snap = await withTimeout(ref.get(), READ_TIMEOUT_MS * 2, 'history read');
    const out = [];
    snap.forEach(d => out.push(d.data()));
    return out;
}

async function deleteHistory(collection, ids) {
    if (!enabled) return 0;
    let n = 0;
    for (let i = 0; i < ids.length; i += 400) {
        const batch = db.batch();
        for (const id of ids.slice(i, i + 400)) {
            batch.delete(db.collection(collection).doc(id));
            n++;
        }
        await withTimeout(batch.commit(), READ_TIMEOUT_MS * 2, 'history delete');
    }
    return n;
}

/** Everything older than a cutoff. Used by "delete older than N days". */
async function deleteHistoryBefore(collection, cutoffMs) {
    if (!enabled) return 0;
    let total = 0;
    for (;;) {
        const snap = await withTimeout(
            db.collection(collection).where('receivedAt', '<', Number(cutoffMs)).limit(400).get(),
            READ_TIMEOUT_MS * 2, 'history sweep');
        if (snap.empty) break;
        const batch = db.batch();
        snap.forEach(d => batch.delete(d.ref));
        await withTimeout(batch.commit(), READ_TIMEOUT_MS * 2, 'history sweep delete');
        total += snap.size;
        if (snap.size < 400) break;
    }
    return total;
}

function getStatus() {
    // Object.assign flattens the getter, so pendingWrite is computed here.
    return Object.assign({}, status, { pendingWrite: status.pendingWrite });
}

/** Test seam — lets the suite inject a fake db without a network or a credential. */
function _setDbForTests(fakeDb) {
    db = fakeDb;
    enabled = !!fakeDb;
    status.enabled = enabled;
    status.configured = enabled;
}

module.exports = {
    explain,
    init, isEnabled, readConfig, writeConfig, writeConfigNow, getStatus,
    readIdentity, writeIdentity,
    writeHistory, queryHistory, deleteHistory, deleteHistoryBefore,
    _setDbForTests,
    READ_TIMEOUT_MS, WRITE_DEBOUNCE_MS
};
