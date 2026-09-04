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

/** Hard ceiling on the boot read. Past this we stop waiting and use what we have. */
const READ_TIMEOUT_MS = 3000;

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
    /** True when a local save has not yet reached Firestore. Surfaced on the dashboard. */
    pendingWrite: false
};

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
async function readConfig() {
    if (!enabled) return null;
    status.lastReadAt = Date.now();

    try {
        const snapshot = await withTimeout(
            db.collection(DOC_COLLECTION).doc(DOC_ID).get(), READ_TIMEOUT_MS, 'read');

        if (!snapshot || !snapshot.exists) {
            status.lastReadOk = true;
            return null;                       // first run — migration will write it
        }
        status.lastReadOk = true;
        status.lastError  = null;
        return snapshot.data() || null;
    } catch (e) {
        status.lastReadOk = false;
        status.lastError  = explain(e.message);
        console.error(`[firestore] Config read failed (${e.message}) — using local state`);
        return null;
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
    status.pendingWrite = true;

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

async function flushWrite() {
    if (!enabled || !pendingValue) return false;
    const { config, updatedBy } = pendingValue;
    pendingValue = null;
    status.lastWriteAt = Date.now();

    try {
        await withTimeout(db.collection(DOC_COLLECTION).doc(DOC_ID).set({
            filters:           config.filters,
            globalForwarding:  config.globalForwarding,
            autoDeleteMinutes: config.autoDeleteMinutes,
            updatedAt:         Date.now(),
            updatedBy
        }), READ_TIMEOUT_MS, 'write');

        status.lastWriteOk  = true;
        status.pendingWrite = false;
        status.lastError    = null;
        console.log(`[firestore] Config saved (${updatedBy})`);
        return true;
    } catch (e) {
        status.lastWriteOk  = false;
        status.lastError    = explain(e.message);
        // pendingWrite STAYS true: the local save succeeded, the durable one did
        // not, and the dashboard must be able to say so.
        console.error(`[firestore] Config write FAILED — saved locally only\n  ${explain(e.message)}`);
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

async function readIdentity() {
    if (!enabled) return null;
    try {
        const snap = await withTimeout(
            db.collection(DOC_COLLECTION).doc(IDENTITY_ID).get(), READ_TIMEOUT_MS, 'identity read');
        if (!snap || !snap.exists) return null;
        return snap.data() || null;
    } catch (e) {
        status.lastError = explain(e.message);
        console.error(`[firestore] Identity read failed (${e.message}) — starting with none`);
        return null;
    }
}

/** Debounced and unawaited, exactly like the config write. */
function writeIdentity(data) {
    if (!enabled) return;
    identityPending = data;
    status.pendingWrite = true;
    if (identityTimer) clearTimeout(identityTimer);
    identityTimer = setTimeout(flushIdentity, WRITE_DEBOUNCE_MS);
    if (typeof identityTimer.unref === 'function') identityTimer.unref();
}

async function flushIdentity() {
    if (!enabled || !identityPending) return false;
    const data = identityPending;
    identityPending = null;
    try {
        await withTimeout(db.collection(DOC_COLLECTION).doc(IDENTITY_ID).set(
            Object.assign({}, data, { updatedAt: Date.now() })), READ_TIMEOUT_MS, 'identity write');
        status.lastWriteAt = Date.now();
        status.lastWriteOk = true;
        status.pendingWrite = false;
        console.log(`[firestore] Identity saved (${(data.users || []).length} user(s), `
            + `${(data.devices || []).length} device(s))`);
        return true;
    } catch (e) {
        status.lastWriteOk = false;
        status.lastError = explain(e.message);
        // pendingWrite stays true — the dashboard must be able to say so.
        console.error(`[firestore] Identity write FAILED — held in memory only\n  ${explain(e.message)}`);
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

function getStatus() { return Object.assign({}, status); }

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
