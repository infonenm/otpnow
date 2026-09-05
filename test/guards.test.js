/**
 * test/guards.test.js — the four review items, each with the failure it allows.
 *
 * None of these is a crash. All four are the shape this project keeps being bitten
 * by: something that looks like it worked, and did not.
 *
 *   1. /api/set-password had no identity-loaded guard, so during a Firestore
 *      outage it accepted a password, spent the one-time enrollment code, and
 *      persisted neither.
 *   2. registerDevice marked dirty unconditionally, so every phone's every
 *      process start wrote a snapshot identical to the stored one.
 *   3. MAX_WAITERS was global only, so one number could take all 200 long-poll
 *      slots and every other number got `busy`.
 *   4. fcm.init() called initializeApp() without the guard firestore.init() has,
 *      so FCM worked only because of the call order in server.js.
 *
 * Run: node test/guards.test.js
 */

const assert = require('assert');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { spawnSync } = require('child_process');

const LIB = path.join(__dirname, '..', 'lib');

function tmpState(tag) {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-g-' + tag + '-')), 'state.json');
}

/** Run a snippet in a fresh process — module load order is the subject here. */
function child(env, code, label) {
    const r = spawnSync(process.execPath, ['-e', code], {
        encoding: 'utf8', env: Object.assign({}, process.env, env)
    });
    if (r.status !== 0) {
        console.error(r.stdout); console.error(r.stderr);
        assert.fail(label + ' exited ' + r.status);
    }
    return r.stdout;
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. FCM INIT MUST NOT DEPEND ON RUNNING FIRST
//
// A second admin.initializeApp() throws. firestore.init() has always checked
// admin.apps.length; fcm.init() did not, and the throw landed in its own catch —
// so FCM was silently disabled for the whole process and the symptom was "the
// dashboard toggle takes 30 seconds", which is the poller doing FCM's job.
//
// Reversing the call order is the whole test: it must not matter.
// ═════════════════════════════════════════════════════════════════════════════
{
    const FAKE_ADMIN = `
const fake = {
    apps: [],
    initializeApp() {
        if (fake.apps.length) {
            const e = new Error('The default Firebase app already exists.');
            e.code = 'app/duplicate-app';
            throw e;
        }
        fake.apps.push({ name: '[DEFAULT]' });
        return fake.apps[0];
    },
    credential: { cert: () => ({}) },
    firestore: () => ({ collection: () => ({ doc: () => ({}) }) }),
    messaging: () => ({ send: async () => 'projects/x/messages/1' })
};
const p = require.resolve('firebase-admin');
require.cache[p] = { id: p, filename: p, loaded: true, exports: fake, children: [], paths: [] };
`;
    const ENV = {
        FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'p', client_email: 'e', private_key: 'k' }),
        FIRESTORE_ENABLED: 'true'
    };

    // The order server.js actually uses today.
    let out = child(ENV, FAKE_ADMIN + `
const fcm = require(${JSON.stringify(path.join(LIB, 'fcm.js'))});
const firestore = require(${JSON.stringify(path.join(LIB, 'firestore.js'))});
fcm.init(); firestore.init();
console.log(JSON.stringify({ fcm: fcm.getStatus().configured, fs: firestore.isEnabled() }));
`, 'fcm-then-firestore');
    let r = JSON.parse(out.trim().split('\n').pop());
    assert.strictEqual(r.fcm, true, 'FCM enabled when it initialises first');
    assert.strictEqual(r.fs, true, 'Firestore enabled when it initialises second');

    // The order it does NOT use — which is the only reason the bug was dormant.
    out = child(ENV, FAKE_ADMIN + `
const fcm = require(${JSON.stringify(path.join(LIB, 'fcm.js'))});
const firestore = require(${JSON.stringify(path.join(LIB, 'firestore.js'))});
firestore.init(); fcm.init();
console.log(JSON.stringify({ fcm: fcm.getStatus().configured, fs: firestore.isEnabled() }));
`, 'firestore-then-fcm');
    r = JSON.parse(out.trim().split('\n').pop());
    assert.strictEqual(r.fs, true, 'Firestore still enabled when it initialises first');
    assert.strictEqual(r.fcm, true,
        'FCM must still be enabled when it initialises SECOND — it threw on the '
        + 'duplicate app, caught its own exception, and disabled push for the process');
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. A REGISTRATION THAT CHANGES NOTHING PERSISTABLE MUST NOT PERSIST
//
// The app registers on every process start — an FCM wake, the 4-minute alarm
// chain, a reboot. The only field that changes on a re-register is lastSeen,
// which snapshot() deliberately excludes, so the write could not have altered
// the stored document at all. It still cost a Firestore write plus a synchronous
// state-file write on the event loop that answers /get.
// ═════════════════════════════════════════════════════════════════════════════
{
    const users = require('../lib/users');
    let writes = 0;
    users.load({ users: [], devices: [], allowedHosts: [] });
    users.setPersister(() => { writes++; });

    const ID = 'aabbccddeeff0011';

    users.registerDevice(ID, { model: 'Galaxy A14' });
    assert.strictEqual(writes, 1, 'a brand-new device must always be persisted');

    // The common case: the same phone starting up again, saying the same things.
    users.registerDevice(ID, { model: 'Galaxy A14' });
    users.registerDevice(ID, { model: 'Galaxy A14' });
    users.registerDevice(ID, {});
    assert.strictEqual(writes, 1,
        're-registering with nothing new must not write — lastSeen is the only '
        + 'field that moved and it is not in the snapshot');

    // ...but lastSeen must still be updated in memory: it is what answers
    // "which phones are alive?" on the dashboard.
    const seenBefore = users.getDevice(ID).lastSeen;
    assert.ok(seenBefore > 0, 'presence is still tracked without persisting it');

    // A real change still persists immediately.
    users.registerDevice(ID, { model: 'Pixel 8' });
    assert.strictEqual(writes, 2, 'a changed model is a real change and must persist');

    users.createUser('Rahim');
    assert.strictEqual(writes, 3, 'creating a user persists');

    // The claim resolving from unknown to real once the account exists is a
    // change to a persisted field, so it must be written even though the phone
    // sent exactly what it sent last time.
    users.registerDevice(ID, { model: 'Pixel 8', claimedUser: 'nobody' });
    const w = writes;
    assert.strictEqual(users.getDevice(ID).claimedUserId, '?nobody');
    users.registerDevice(ID, { model: 'Pixel 8', claimedUser: 'Rahim' });
    assert.strictEqual(users.getDevice(ID).claimedUserId, 'rahim');
    assert.strictEqual(writes, w + 1, 'a claim that now resolves is a persisted change');
}

// ═════════════════════════════════════════════════════════════════════════════
// 2b. A DEVICE CARRIED ACROSS A LOAD MUST BE PERSISTED BY THE LOAD
//
// It registered while the identity read was in flight, so markDirty() was
// correctly refused and the stored document knows nothing about it. It used to
// be written by luck — the phone's next registration marked dirty regardless.
// Now that a quiet re-registration writes nothing, the load has to do it, or the
// row lives in memory until the next restart erases it.
// ═════════════════════════════════════════════════════════════════════════════
{
    const users = require('../lib/users');
    users.load({ users: [], devices: [], allowedHosts: [] });

    // Simulate the window: pretend the load has not happened, register, then load.
    users.loadCache({ users: [], devices: [], allowedHosts: [] });   // leaves read-only
    let refused = 0;
    users.setPersister(() => { refused++; });
    users.registerDevice('1122334455667788', { model: 'A14' });
    assert.strictEqual(refused, 0,
        'precondition: nothing is persisted while identity has not loaded');

    let writes = 0;
    users.setPersister(() => { writes++; });
    users.load({ users: [], devices: [], allowedHosts: [] });
    assert.ok(users.getDevice('1122334455667788'), 'the device is carried across the load');
    assert.strictEqual(writes, 1,
        'and the load must persist it — otherwise it exists only in memory and '
        + 'the next restart erases a phone that is actively forwarding');

    // The cache path must stay read-only even with a device to carry.
    users.loadCache({ users: [], devices: [], allowedHosts: [] });
    users.registerDevice('99aabbccddeeff00', { model: 'A14' });
    writes = 0;
    users.loadCache({ users: [], devices: [], allowedHosts: [] });
    assert.strictEqual(writes, 0,
        'a CACHE load must never write back — it is a snapshot we are not sure is current');
    assert.strictEqual(users.isLoaded(), false, 'and it stays read-only');
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. ONE NUMBER MUST NOT BE ABLE TO TAKE EVERY LONG-POLL SLOT
// ═════════════════════════════════════════════════════════════════════════════
process.env.MAX_WAITERS_PER_NUMBER = '3';
process.env.STATE_FILE = tmpState('w');
process.env.OTP_PATTERNS = '(\\d{4,8})';

const store = require('../lib/store');

const MINE  = '01711111111';
const OTHER = '01722222222';

async function waiterSection() {
    const limits = store.waiterLimits();
    assert.strictEqual(limits.perNumber, 3, 'the per-number cap is configurable');

    // Fill one number's quota. These are left parked on purpose.
    const parked = [];
    for (let i = 0; i < 3; i++) parked.push(store.waitForOtp(MINE, 4000, null));
    await new Promise(r => setTimeout(r, 20));

    assert.strictEqual(store.waitersFull(MINE), true,
        'the number that filled its own quota is full');
    assert.strictEqual(store.waitersFull(OTHER), false,
        'and every OTHER number is unaffected — that is the entire point');
    assert.strictEqual(store.waitersFull(), false,
        'the global cap is nowhere near reached');

    // The fourth request for the same number is refused rather than parked.
    const refused = await store.waitForOtp(MINE, 4000, null);
    assert.strictEqual(refused, null, 'over-quota requests do not park');

    // +880 and 01 are the same number, so the cap cannot be walked around by
    // changing the format — the map is keyed on the canonical form.
    assert.strictEqual(store.waitersFull('+8801711111111'), true,
        'the cap is per canonical number, not per string');

    // A different number still gets the fast path it was promised.
    const t0 = Date.now();
    const other = store.waitForOtp(OTHER, 4000, null);
    await new Promise(r => setTimeout(r, 20));
    store.addSms('IVAC', OTHER, 'Your OTP is 445566', Date.now(), null);
    assert.strictEqual(await other, '445566',
        'a different number must still be served while one number is saturated');
    assert.ok(Date.now() - t0 < 1000, 'and served immediately, not after a timeout');

    // Serving the saturated number still works for the ones already parked.
    store.addSms('IVAC', MINE, 'Your OTP is 778899', Date.now(), null);
    assert.strictEqual(await parked[0], '778899',
        'the first waiter on the saturated number still wins the code');
    assert.strictEqual(await parked[1], null,
        'and consume-on-read still means only one of them gets it');
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. /api/set-password MUST REFUSE WHILE IDENTITY HAS NOT LOADED
//
// Accepting it spends the one-time enrollment code and persists nothing, so the
// account comes back after a restart with no password and the OLD code live —
// while the person has been told they are enrolled.
// ═════════════════════════════════════════════════════════════════════════════
process.env.DASHBOARD_PASSWORD = 'admin-pw';
process.env.API_KEY            = 'test-key';
process.env.USERS_ENABLED      = 'true';
process.env.PORT               = '3947';

const users = require('../lib/users');
require('../server.js');
const BASE = 'http://127.0.0.1:3947';

function req(method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json';
                    headers['Content-Length'] = Buffer.byteLength(data); }
        const r = http.request(BASE + urlPath, { method, headers }, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch (e) { /* asserted below */ }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}

async function enrollSection() {
    // A real account with a real code, then force the store back into
    // "identity never loaded" — which is what a failed boot read leaves.
    users.load({ users: [], devices: [], allowedHosts: [] });
    users.setPersister(() => {});
    const created = users.createUser('Karim');
    assert.ok(created.ok, 'precondition: the account exists');
    const code = created.enrollCode;

    users.loadCache({ users: [{ id: 'karim', name: 'Karim', active: true, enrollCode: code }],
                      devices: [], allowedHosts: [] });
    assert.strictEqual(users.isLoaded(), false, 'precondition: identity is not loaded');

    let res = await req('POST', '/api/set-password',
        { username: 'karim', code, password: 'a-real-password' });
    assert.strictEqual(res.status, 503,
        'enrolling must be REFUSED while the password could not be saved — it used '
        + 'to succeed, spend the code, and persist nothing');
    assert.ok(!/Settings|Retry now/i.test(res.body.error),
        'and must not tell a user to open an admin screen they cannot reach');

    // Nothing was consumed: the code still works once the load succeeds.
    assert.strictEqual(users.getUser('karim').enrollCode, code,
        'the one-time code must be untouched by a refused attempt');
    assert.strictEqual(users.getUser('karim').passwordHash, null,
        'and no password may have been half-set');

    users.load({ users: [{ id: 'karim', name: 'Karim', active: true, enrollCode: code }],
                 devices: [], allowedHosts: [] });
    res = await req('POST', '/api/set-password',
        { username: 'karim', code, password: 'a-real-password' });
    assert.strictEqual(res.status, 200,
        'and the SAME code must still enroll once identity has loaded');
    assert.ok(await users.authenticate('karim', 'a-real-password'),
        'the password actually took effect');

    // The flag question is settled before the readiness one: with users off,
    // this is 404 "not enabled", not 503 "still loading".
    const off = spawnSync(process.execPath, ['-e', `
        const http = require('http');
        require(${JSON.stringify(path.join(__dirname, '..', 'server.js'))});
        setTimeout(() => {
            const body = JSON.stringify({ username: 'x', code: 'y', password: 'zzzzzzzz' });
            const r = http.request('http://127.0.0.1:3948/api/set-password',
                { method: 'POST', headers: { 'Content-Type': 'application/json',
                                             'Content-Length': Buffer.byteLength(body) } },
                res => { console.log('STATUS=' + res.statusCode); process.exit(0); });
            r.on('error', e => { console.log('ERR=' + e.message); process.exit(1); });
            r.write(body); r.end();
        }, 400);
    `], { encoding: 'utf8', env: Object.assign({}, process.env, {
        USERS_ENABLED: 'false', PORT: '3948', STATE_FILE: tmpState('off')
    }) });
    assert.ok(/STATUS=404/.test(off.stdout),
        'with USERS_ENABLED off this must stay 404 "not enabled", not 503 "still '
        + 'loading" — the feature is switched off and will never load. Got: '
        + off.stdout.trim());
}

(async () => {
    await new Promise(r => setTimeout(r, 300));   // let the server bind
    await waiterSection();
    await enrollSection();
    console.log('ok — enrolling is refused when it could not be saved, a quiet '
        + 're-registration writes nothing (and a carried device is written by the '
        + 'load), one number cannot take every long-poll slot, and FCM no longer '
        + 'depends on initialising before Firestore');
    process.exit(0);
})().catch(e => {
    // Required, not optional: server.js installs an unhandledRejection handler
    // that logs and keeps running, so without this a failed assertion in here
    // would hang npm test instead of reporting. Every other suite that boots the
    // server does the same.
    console.error(e);
    process.exit(1);
});
