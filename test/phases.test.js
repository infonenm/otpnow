/**
 * test/phases.test.js — per-user override, admin targeting, and the archive.
 *
 * The three things worth pinning here:
 *
 *   1. THE OVERRIDE IS ENFORCED SERVER-SIDE. A device that never hears about
 *      the window still cannot deliver outside it, and the answer /sms enforces
 *      is the same one /api/settings hands the app — those two disagreeing is
 *      what produced the old "off switch that undoes itself".
 *
 *   2. TARGETING NEEDED NO APP CHANGE. The one-shot timestamps are served per
 *      device as max(broadcast, owner's), and RemoteCommands already
 *      de-duplicates by timestamp. A targeted command must not cancel a
 *      broadcast one, or vice versa.
 *
 *   3. THE ARCHIVE NEVER RUNS WHILE A MESSAGE IS ALIVE, and the outcome is
 *      recorded correctly — that field is the whole point of the feature.
 *
 * Run: node test/phases.test.js
 */

const assert = require('assert');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

process.env.DASHBOARD_PASSWORD   = 'admin-pw';
process.env.API_KEY              = 'test-key';
process.env.USERS_ENABLED        = 'true';
process.env.HISTORY_ENABLED      = 'true';
process.env.FIRESTORE_ENABLED    = 'true';
process.env.FIREBASE_SERVICE_ACCOUNT = '{"stub":true}';
process.env.OVERRIDE_MAX_MINUTES = '30';
process.env.OTP_PATTERNS         = '(\\d{4,8})';
process.env.AUTO_DELETE_MINUTES  = '1';
process.env.STATE_FILE           = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-ph-')), 'state.json');
process.env.PORT                 = '3991';

// Stub Firestore BEFORE the server initialises it, so nothing touches a network.
const firestore = require('../lib/firestore');
const archived = [];
firestore.init = function () {
    // A stub shaped like the parts of the client this server actually uses:
    // batched writes, a chainable query, and single-document get/set. Anything
    // it does not implement would throw rather than silently pass, which is the
    // point — a stub that swallows unknown calls proves nothing.
    const query = () => {
        const q = {
            where: () => q,
            orderBy: () => q,
            limit: () => q,
            get: async () => ({
                empty: archived.length === 0,
                size: archived.length,
                forEach: (fn) => archived.forEach(r => fn({ data: () => r, ref: {} }))
            })
        };
        return q;
    };
    firestore._setDbForTests({
        batch: () => ({ set: (ref, v) => archived.push(v), delete: () => {}, commit: async () => {} }),
        collection: () => Object.assign(query(), {
            doc: () => ({ get: async () => ({ exists: false }), set: async () => {} })
        })
    });
};

const history = require('../lib/history');
const store   = require('../lib/store');
require('../server.js');

const BASE = 'http://127.0.0.1:3991';

function req(method, urlPath, { body, token, apiKey } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json';
                    headers['Content-Length'] = Buffer.byteLength(data); }
        if (token)  headers['Authorization'] = 'Bearer ' + token;
        if (apiKey) headers['X-Api-Key'] = apiKey;
        const r = http.request(BASE + urlPath, { method, headers }, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch (e) {}
                resolve({ status: res.statusCode, body: parsed, raw });
            });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}

(async () => {
    await new Promise(r => setTimeout(r, 300));

    const admin = (await req('POST', '/api/login', { body: { password: 'admin-pw' } })).body.token;

    // Two users, one device each.
    const rc = (await req('POST', '/api/users', { token: admin, body: { name: 'Rahim' } })).body.enrollCode;
    const kc = (await req('POST', '/api/users', { token: admin, body: { name: 'Karim' } })).body.enrollCode;
    await req('POST', '/api/set-password', { body: { username: 'rahim', code: rc, password: 'rahim-password' } });
    await req('POST', '/api/set-password', { body: { username: 'karim', code: kc, password: 'karim-password' } });
    const rahim = (await req('POST', '/api/login', { body: { username: 'rahim', password: 'rahim-password' } })).body.token;

    const devR = (await req('POST', '/api/register', { apiKey: 'test-key', body: { model: 'Galaxy A14' } })).body.deviceId;
    const devK = (await req('POST', '/api/register', { apiKey: 'test-key', body: { model: 'Redmi 12' } })).body.deviceId;
    await req('POST', `/api/devices/${devR}/assign`, { token: admin, body: { userId: 'rahim' } });
    await req('POST', `/api/devices/${devK}/assign`, { token: admin, body: { userId: 'karim' } });

    // ─────────────────────────────────────────────────────────────────────────
    // 1. PER-USER OVERRIDE
    // ─────────────────────────────────────────────────────────────────────────
    await req('POST', '/api/toggle', { token: admin, body: { enabled: false } });

    let res = await req('POST', '/sms', { apiKey: 'test-key', body: {
        sender: 'IVAC', recipient: '01711111111', message: 'Your OTP is 111111', deviceId: devR } });
    assert.strictEqual(res.body.ignored, true, 'global OFF declines every device');

    // Rahim turns his own phones back on.
    res = await req('POST', '/api/override', { token: rahim, body: {} });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.minutes, 30, 'defaults to the admin ceiling');

    res = await req('POST', '/sms', { apiKey: 'test-key', body: {
        sender: 'IVAC', recipient: '01711111111', message: 'Your OTP is 222222', deviceId: devR } });
    assert.ok(!res.body.ignored, "rahim's phone forwards again");

    res = await req('POST', '/sms', { apiKey: 'test-key', body: {
        sender: 'IVAC', recipient: '01733333333', message: 'Your OTP is 333333', deviceId: devK } });
    assert.strictEqual(res.body.ignored, true,
        "karim's phone must be UNAFFECTED — an override is per user, not a back door "
        + 'to the global switch');

    // The instruction the app is given must match the enforcement.
    const rSettings = (await req('GET', '/api/settings?deviceId=' + devR, { apiKey: 'test-key' })).body;
    const kSettings = (await req('GET', '/api/settings?deviceId=' + devK, { apiKey: 'test-key' })).body;
    assert.strictEqual(rSettings.globalForwarding, true,
        'the app is TOLD to forward — enforcement and instruction must not disagree');
    assert.strictEqual(kSettings.globalForwarding, false, "and karim's is told not to");

    // The ceiling is a clamp, not a refusal.
    res = await req('POST', '/api/override', { token: rahim, body: { minutes: 600 } });
    assert.strictEqual(res.body.minutes, 30, 'an over-long request is clamped');
    assert.strictEqual(res.body.clamped, true, 'and says so');

    // Re-enabling globally does NOT cancel it — it runs out its own clock.
    await req('POST', '/api/toggle', { token: admin, body: { enabled: true } });
    assert.ok(store.overrideRemaining('rahim') > 0,
        'an active override survives the admin re-enabling global forwarding — '
        + 'Riad\'s decision: a thing you turned on for 30 minutes stays on for 30 minutes');

    // Deactivation is a deliberate revocation and ends it now.
    await req('POST', '/api/toggle', { token: admin, body: { enabled: false } });
    await req('POST', '/api/users/rahim/active', { token: admin, body: { active: false } });
    res = await req('POST', '/sms', { apiKey: 'test-key', body: {
        sender: 'IVAC', recipient: '01711111111', message: 'Your OTP is 444444', deviceId: devR } });
    assert.strictEqual(res.body.ignored, true,
        'a deactivated owner cannot keep forwarding through an override');
    await req('POST', '/api/users/rahim/active', { token: admin, body: { active: true } });
    await req('POST', '/api/toggle', { token: admin, body: { enabled: true } });

    // Admin has the global switch and does not get a personal override.
    res = await req('POST', '/api/override', { token: admin, body: {} });
    assert.strictEqual(res.status, 400, 'admin uses the global switch — two switches drift apart');

    // ─────────────────────────────────────────────────────────────────────────
    // 2. TARGETING — no app change was needed for this
    // ─────────────────────────────────────────────────────────────────────────
    const before = (await req('GET', '/api/settings?deviceId=' + devK, { apiKey: 'test-key' })).body;

    await req('POST', '/api/test', { token: admin, body: { target: 'rahim' } });
    const rAfter = (await req('GET', '/api/settings?deviceId=' + devR, { apiKey: 'test-key' })).body;
    const kAfter = (await req('GET', '/api/settings?deviceId=' + devK, { apiKey: 'test-key' })).body;

    assert.ok(rAfter.testMessageTs > 0, "the targeted user's device sees the command");
    assert.strictEqual(kAfter.testMessageTs, before.testMessageTs,
        'a device belonging to someone else must not see it');

    // A broadcast afterwards must still reach the targeted user.
    await new Promise(r => setTimeout(r, 5));
    await req('POST', '/api/test', { token: admin, body: { target: 'all' } });
    const rBroadcast = (await req('GET', '/api/settings?deviceId=' + devR, { apiKey: 'test-key' })).body;
    assert.ok(rBroadcast.testMessageTs > rAfter.testMessageTs,
        'a later broadcast must still reach a user who was targeted before it — '
        + 'the two layers are independent, which is why this is max() not a replacement');

    // A user can only ever command their own phones.
    await new Promise(r => setTimeout(r, 5));
    const kBefore2 = (await req('GET', '/api/settings?deviceId=' + devK, { apiKey: 'test-key' })).body;
    await req('POST', '/api/test', { token: rahim, body: { target: 'karim' } });
    const kAfter2 = (await req('GET', '/api/settings?deviceId=' + devK, { apiKey: 'test-key' })).body;
    assert.strictEqual(kAfter2.testMessageTs, kBefore2.testMessageTs,
        "a user naming someone else's id must not reach their phones — the target is "
        + 'taken from the SESSION, never from the body');

    // ─────────────────────────────────────────────────────────────────────────
    // 3. ARCHIVE — deferred, and the outcome is right
    // ─────────────────────────────────────────────────────────────────────────
    archived.length = 0;
    const qBefore = history.stats().queued;

    await req('POST', '/sms', { apiKey: 'test-key', body: {
        sender: 'bKash', recipient: '01755555555', message: 'Your OTP is 555555', deviceId: devR } });
    assert.strictEqual(history.stats().queued, qBefore,
        'ARRIVAL MUST QUEUE NOTHING. The archive only sees finished messages, which is '
        + 'what removes it from the live path entirely');
    assert.strictEqual(archived.length, 0, 'and certainly must not write');

    // Fetched.
    assert.strictEqual(store.getOtp('01755555555'), '555555');
    assert.strictEqual(history.stats().queued, qBefore + 1, 'a fetch finishes it');

    // Superseded.
    await req('POST', '/sms', { apiKey: 'test-key', body: {
        sender: 'bKash', recipient: '01766666666', message: 'Your OTP is 666666', deviceId: devR } });
    await req('POST', '/sms', { apiKey: 'test-key', body: {
        sender: 'bKash', recipient: '01766666666', message: 'Your OTP is 777777', deviceId: devR } });

    await history.flush();
    const outcomes = archived.reduce((a, r) => { a[r.outcome] = (a[r.outcome] || 0) + 1; return a; }, {});
    assert.ok(outcomes.fetched >= 1, 'a consumed code is archived as fetched: '
        + JSON.stringify(outcomes));
    assert.ok(outcomes.superseded >= 1, 'a replaced one as superseded');

    const fetched = archived.find(r => r.outcome === 'fetched');
    assert.strictEqual(fetched.userId, 'rahim', 'the owner is recorded');
    assert.strictEqual(fetched.code, '555555', 'and the extracted code');
    assert.ok(fetched.deviceLabel && fetched.deviceLabel.includes('Galaxy'),
        'and a label a human can read, not a hex id: ' + fetched.deviceLabel);
    assert.ok(fetched.expireAt instanceof Date,
        'with a TTL field so the collection cannot grow without bound');

    // History is admin-only.
    //
    // Fresh token: deactivating rahim earlier revoked his sessions, which is the
    // behaviour we want — but it means the old token now answers 401, and a 401
    // would not prove anything about ROLE.
    const rahim2 = (await req('POST', '/api/login',
        { body: { username: 'rahim', password: 'rahim-password' } })).body.token;
    assert.ok(rahim2, 'rahim can sign in again after reactivation');

    res = await req('GET', '/api/history', { token: rahim2 });
    assert.strictEqual(res.status, 403, 'the archive holds full SMS text — admin only');
    res = await req('GET', '/api/history/summary', { token: admin });
    assert.strictEqual(res.status, 200, 'admin can read it');

    console.log('ok — override is per user and server-enforced, targeting needed no app '
        + 'change, and the archive only ever sees finished messages');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
