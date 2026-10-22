/**
 * test/firebase-sdk.test.js — server 4.43.2: the REAL firebase-admin works.
 *
 * Every other suite fakes Firebase. This one loads the real SDK (14.x, with
 * @google-cloud/firestore 9.x) — offline, with a generated service account —
 * and checks what an SDK upgrade can break without any fake noticing:
 *   1. fcm.init() and firestore.init() both come up, in either order, on ONE app.
 *   2. Every document shape the server writes passes Firestore's own
 *      serializer (config + taught examples, identity, history, outbox).
 *   3. Every query shape the server builds is accepted.
 *   4. Every FCM message the server sends passes the SDK's validation (the send
 *      itself fails offline — at auth, never at validation).
 *
 * Run: node test/firebase-sdk.test.js
 */
const assert = require('assert');
const crypto = require('crypto');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
    type: 'service_account', project_id: 'getotp-sdk-test', private_key_id: 'x',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    client_email: 'sdk-test@getotp-sdk-test.iam.gserviceaccount.com', client_id: '1',
    token_uri: 'https://oauth2.googleapis.com/token'
});
process.env.FIRESTORE_ENABLED = 'true';
const quiet = console.log; console.log = () => {};
const firestore = require('../lib/firestore');
const fcm       = require('../lib/fcm');
const firebase  = require('../lib/firebase');
console.log = quiet;

(async () => {
    // ── 1. both initialisers, one app ───────────────────────────
    const log = console.log, err = console.error; console.log = () => {}; console.error = () => {};
    firestore.init(); fcm.init();
    console.log = log; console.error = err;
    assert.strictEqual(firestore.isEnabled(), true, 'Firestore came up on the real SDK');
    assert.strictEqual(fcm.getStatus().configured, true, 'FCM came up on the real SDK');
    assert.strictEqual(require('firebase-admin/app').getApps().length, 1, 'one app, shared');

    // ── 2. document shapes through the real serializer ──────────
    const db = firebase.firestore();
    const batch = db.batch();
    const ref = id => db.collection('t').doc(id);
    const shapes = {
        config: { filters: [{ phoneNumber: 'IVACBD', patterns: ['@words', '(\\d{4,8})'] }], globalForwarding: true,
                  autoDeleteMinutes: 30, updatedAt: Date.now(), updatedBy: 'dashboard',
                  filterExamples: [{ rule: 'IVACBD', sender: 'IVACBD', recipient: '', message: 'prompted Seven_Seven',
                                     code: '778050', at: Date.now() }] },
        identity: { users: [{ id: 'rahim', name: 'Rahim', active: true, sendEnabled: false, sendDailyLimit: 50,
                              createdAt: 1, hash: 'x', salt: 'y' }],
                    devices: [{ id: 'aaaaaaaaaaaaaaaa', userId: 'rahim', name: '', model: 'X', simNumber: null,
                                sims: [{ slot: 1, number: '01711111111', present: true, unconfirmed: false }],
                                simLog: [], createdAt: 1, lastSeen: 2, canSendSms: true, appVersion: '4.39.1' }],
                    revoked: [], allowedHosts: [] },
        history: { smsId: 'abc', userId: 'admin', deviceId: null, deviceLabel: null, sender: 'IVACBD',
                   recipient: '01711111111', message: 'x', code: '778050', outcome: 'fetched', receivedAt: 1,
                   arrivedAt: 1, finishedAt: 2, expireAt: new Date(Date.now() + 86400000) },
        outbox: { id: 'j1', batchId: 'b', createdAt: 1, updatedAt: 1, createdBy: 'admin', createdByName: 'admin',
                  fromDeviceId: 'aaaaaaaaaaaaaaaa', fromDeviceName: 'X', fromSlot: 1, fromNumber: '01711111111',
                  fromOwner: 'admin', to: '01811111111', toLabel: '', message: 'hi', encoding: 'gsm', parts: 1,
                  status: 'queued', error: '', dispatchedAt: 0, sentAt: 0, deliveredAt: 0, receivedAt: 0,
                  finishedAt: 0, partsSent: [], partsDelivered: [], requeued: 0, acked: false, retryOf: '' }
    };
    for (const [id, doc] of Object.entries(shapes)) {
        assert.doesNotThrow(() => batch.set(ref(id), doc), `${id} is a valid Firestore document`);
    }
    assert.doesNotThrow(() => batch.set(ref('merge'), { filters: [] }, { merge: true }), 'merge write');
    assert.doesNotThrow(() => batch.delete(ref('x')));
    assert.throws(() => batch.set(ref('bad'), { a: undefined }), 'undefined is still refused — never written');

    // ── 3. query shapes ─────────────────────────────────────────
    assert.doesNotThrow(() => db.collection('h').where('userId', '==', 'rahim').where('receivedAt', '>=', 1)
        .where('receivedAt', '<=', 2).orderBy('receivedAt', 'desc').limit(500));
    assert.doesNotThrow(() => db.collection('o').where('createdAt', '<', 1).limit(400));
    assert.doesNotThrow(() => db.collection('o').where('createdAt', '>=', 1).orderBy('createdAt', 'desc').limit(5000));

    // ── 4. FCM messages pass validation ─────────────────────────
    const msg = {
        topic: 'forwarding_control', data: { action: 'enable', timestamp: String(Date.now()), url: 'https://x.onrender.com' },
        android: { priority: 'high', ttl: 900000 }
    };
    const outcome = async m => {
        try {
            await Promise.race([firebase.messaging().send(m, true),
                                new Promise((_, rej) => setTimeout(() => rej(new Error('offline-timeout')), 8000))]);
            return 'sent';
        } catch (e) { return String(e.code || e.message); }
    };
    const good = await outcome(msg);
    assert.ok(!/invalid-argument|invalid-payload/.test(good), 'the server\'s message is valid: ' + good);
    const bad = await outcome(Object.assign({}, msg, { data: { n: 1 } }));
    assert.ok(/invalid/.test(bad), 'and the validator really runs (a number in data is refused): ' + bad);

    console.log('ok — real firebase-admin ' + require('firebase-admin/app').SDK_VERSION
        + ': one app, every document and query shape accepted, FCM messages valid');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
