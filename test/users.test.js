/**
 * test/users.test.js — Phase 2: identity.
 *
 * Two things this file is really about:
 *
 *   1. THE "Unknown" COLLISION. PhoneUtils files a message under the literal
 *      string "Unknown" when the SIM cannot be resolved — routine on the
 *      Bangladeshi carriers that never write EF_MSISDN. With one phone that is
 *      a display quirk. With two, BOTH write to the same key, so one person's
 *      SMS supersedes another's live OTP and whoever fetches first gets a code
 *      that was never theirs. That is a correctness bug the moment a second
 *      device exists, and it is what this phase actually fixes.
 *
 *   2. SCOPING IS SERVER-SIDE. A user must not receive another user's messages
 *      and have the browser hide them. Checked per endpoint, not via the UI.
 *
 * Run: node test/users.test.js
 */

const assert = require('assert');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

process.env.DASHBOARD_PASSWORD  = 'admin-pw';
process.env.API_KEY             = 'test-key';
process.env.USERS_ENABLED       = 'true';
process.env.OTP_PATTERNS        = '(\\d{4,8})';
process.env.STATE_FILE          = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-u-')), 'state.json');
process.env.PORT                = '3941';

const users = require('../lib/users');
const store = require('../lib/store');
require('../server.js');

const BASE = 'http://127.0.0.1:3941';

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
                try { parsed = JSON.parse(raw); } catch (e) { /* non-JSON is a failure below */ }
                resolve({ status: res.statusCode, body: parsed, raw });
            });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}

(async () => {
    await new Promise(r => setTimeout(r, 300));   // let the server bind

    // ── Admin still logs in exactly as before ────────────────────────────────
    let res = await req('POST', '/api/login', { body: { password: 'admin-pw' } });
    assert.strictEqual(res.status, 200, 'admin login with no username must still work');
    assert.strictEqual(res.body.role, 'admin');
    const adminToken = res.body.token;

    // ── Create two users ─────────────────────────────────────────────────────
    res = await req('POST', '/api/users', { token: adminToken, body: { name: 'Rahim' } });
    assert.strictEqual(res.status, 200, 'admin can create a user');
    const rahimCode = res.body.enrollCode;
    assert.ok(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(rahimCode),
        'an enrollment code is issued once, and is readable off a screen: ' + rahimCode);

    res = await req('POST', '/api/users', { token: adminToken, body: { name: 'Karim' } });
    const karimCode = res.body.enrollCode;

    // A passwordless account must not be usable without the code.
    res = await req('POST', '/api/login', { body: { username: 'rahim', password: 'anything' } });
    assert.strictEqual(res.status, 401,
        'an account with no password yet must not be claimable by whoever knows the username');

    // Wrong code is refused.
    res = await req('POST', '/api/set-password',
        { body: { username: 'rahim', code: 'WXYZ-2345', password: 'rahim-password' } });
    assert.strictEqual(res.status, 400, 'a wrong enrollment code is refused');

    // Right code enrolls.
    res = await req('POST', '/api/set-password',
        { body: { username: 'rahim', code: rahimCode, password: 'rahim-password' } });
    assert.strictEqual(res.status, 200, 'the right code sets the password');

    // And the code is spent.
    res = await req('POST', '/api/set-password',
        { body: { username: 'rahim', code: rahimCode, password: 'someone-elses' } });
    assert.strictEqual(res.status, 400, 'the enrollment code is ONE-TIME');

    await req('POST', '/api/set-password',
        { body: { username: 'karim', code: karimCode, password: 'karim-password' } });

    res = await req('POST', '/api/login', { body: { username: 'rahim', password: 'rahim-password' } });
    assert.strictEqual(res.status, 200, 'a user can now log in');
    assert.strictEqual(res.body.role, 'user', 'and is not an admin');
    const rahimToken = res.body.token;

    res = await req('POST', '/api/login', { body: { username: 'karim', password: 'karim-password' } });
    const karimToken = res.body.token;

    // A user may not touch admin surface.
    res = await req('GET', '/api/users', { token: rahimToken });
    assert.strictEqual(res.status, 403, 'user management is admin only');
    res = await req('POST', '/api/users', { token: rahimToken, body: { name: 'Sneaky' } });
    assert.strictEqual(res.status, 403, 'a user cannot create users');
    res = await req('GET', '/api/devices', { token: rahimToken });
    assert.strictEqual(res.status, 403, 'a user cannot list the fleet');

    // ── Register two devices and assign one each ─────────────────────────────
    res = await req('POST', '/api/register',
        { apiKey: 'test-key', body: { model: 'Galaxy A14' } });
    assert.strictEqual(res.status, 200);
    const devA = res.body.deviceId;
    assert.strictEqual(res.body.assigned, false,
        'a new device arrives UNASSIGNED rather than being rejected — a phone that '
        + 'silently forwards nothing is the worst possible failure here');

    res = await req('POST', '/api/register',
        { apiKey: 'test-key', body: { model: 'Redmi 12' } });
    const devB = res.body.deviceId;
    assert.notStrictEqual(devA, devB, 'each device gets its own id');

    // Re-registering keeps the id and the assignment — reinstalling the app or
    // restarting the phone must not orphan it.
    res = await req('POST', '/api/register',
        { apiKey: 'test-key', body: { deviceId: devA, model: 'Galaxy A14' } });
    assert.strictEqual(res.body.deviceId, devA, 're-registration is idempotent');

    await req('POST', `/api/devices/${devA}/assign`, { token: adminToken, body: { userId: 'rahim' } });
    await req('POST', `/api/devices/${devB}/assign`, { token: adminToken, body: { userId: 'karim' } });

    // ─────────────────────────────────────────────────────────────────────────
    // THE COLLISION. Both phones report an unresolved SIM.
    // ─────────────────────────────────────────────────────────────────────────
    await req('POST', '/sms', { apiKey: 'test-key', body: {
        sender: 'IVAC', recipient: 'Unknown', message: 'Your OTP is 111111',
        arrivedAt: Date.now(), deviceId: devA } });
    await req('POST', '/sms', { apiKey: 'test-key', body: {
        sender: 'IVAC', recipient: 'Unknown', message: 'Your OTP is 222222',
        arrivedAt: Date.now(), deviceId: devB } });

    const all = store.getSmsFor(users.ADMIN_ID);
    const unknowns = all.filter(m => String(m.recipient).startsWith('Unknown'));
    assert.strictEqual(unknowns.length, 2, 'both messages are stored');
    assert.notStrictEqual(unknowns[0].recipient, unknowns[1].recipient,
        'TWO DEVICES WITH AN UNRESOLVED SIM MUST NOT SHARE A KEY. Sharing one is '
        + "how one person's SMS supersedes another's live OTP.");

    const stillPending = unknowns.filter(m => m.status === 'pending');
    assert.strictEqual(stillPending.length, 2,
        'neither message may have superseded the other — they belong to different phones');

    assert.strictEqual(store.getOtp('Unknown-' + devA), '111111',
        "rahim's phone keeps its own code");
    assert.strictEqual(store.getOtp('Unknown-' + devB), '222222',
        "karim's phone keeps its own code");

    // ── Scoping is server-side ───────────────────────────────────────────────
    await req('POST', '/sms', { apiKey: 'test-key', body: {
        sender: 'bKash', recipient: '01711111111', message: 'Your OTP is 333333',
        arrivedAt: Date.now(), deviceId: devA } });

    res = await req('GET', '/api/messages', { token: rahimToken });
    assert.ok(res.body.messages.every(m => m.userId === 'rahim'),
        'a user receives ONLY their own messages — scoped by the API, not by the browser');
    assert.ok(res.body.messages.some(m => m.message.includes('333333')),
        'and does receive their own');

    res = await req('GET', '/api/messages', { token: karimToken });
    assert.ok(!res.body.messages.some(m => m.message.includes('333333')),
        "karim must not see rahim's message");
    assert.ok(res.body.messages.some(m => m.message.includes('222222')),
        'but does see his own');

    res = await req('GET', '/api/messages', { token: adminToken });
    assert.ok(res.body.messages.length >= 3, 'admin sees everything');

    // ── Deactivation takes effect MID-SESSION ────────────────────────────────
    res = await req('GET', '/api/messages', { token: rahimToken });
    assert.strictEqual(res.status, 200, 'rahim is working normally before deactivation');

    res = await req('POST', '/api/users/rahim/active',
        { token: adminToken, body: { active: false } });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.sessionsRevoked >= 1, 'live sessions are revoked on the spot');

    for (const p of ['/api/messages', '/api/full-settings']) {
        res = await req('GET', p, { token: rahimToken });
        assert.strictEqual(res.status, 401,
            `a deactivated user loses ${p} IMMEDIATELY, not at token expiry`);
    }
    for (const p of ['/api/toggle', '/api/clear-log', '/api/test', '/api/fetch-latest',
                     '/api/clear-all', '/api/filters', '/api/auto-delete']) {
        res = await req('POST', p, { token: rahimToken, body: { enabled: true, filters: [], minutes: 30 } });
        assert.strictEqual(res.status, 401, `and loses ${p} too — EVERY control, not just login`);
    }

    res = await req('POST', '/api/login', { body: { username: 'rahim', password: 'rahim-password' } });
    assert.strictEqual(res.status, 401, 'and cannot log back in');

    // Their DEVICE keeps forwarding, to admin.
    res = await req('POST', '/sms', { apiKey: 'test-key', body: {
        sender: 'IVAC', recipient: '01722222222', message: 'Your OTP is 444444',
        arrivedAt: Date.now(), deviceId: devA } });
    assert.strictEqual(res.status, 200, "a deactivated user's phone keeps forwarding");
    const filed = store.getSmsFor(users.ADMIN_ID).find(m => m.message.includes('444444'));
    assert.ok(filed, 'and the message is stored');
    assert.strictEqual(filed.userId, users.ADMIN_ID,
        'filed to admin, so nothing stops arriving while you sort out the phone');

    // Reactivation restores access.
    await req('POST', '/api/users/rahim/active', { token: adminToken, body: { active: true } });
    res = await req('POST', '/api/login', { body: { username: 'rahim', password: 'rahim-password' } });
    assert.strictEqual(res.status, 200, 'reactivation is reversible — that is the point of it');

    // ── Purge unassigns devices but does not rewrite history ─────────────────
    const before = store.getSmsFor(users.ADMIN_ID).filter(m => m.userId === 'karim').length;
    assert.ok(before > 0, 'karim has messages on record');
    res = await req('POST', '/api/users/karim/purge', { token: adminToken });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.unassignedDevices, 1, 'their devices are unassigned');
    const after = store.getSmsFor(users.ADMIN_ID).filter(m => m.userId === 'karim').length;
    assert.strictEqual(after, before,
        'history is NOT rewritten — a message records what happened when it happened');

    // ── Allowed hosts ────────────────────────────────────────────────────────
    res = await req('POST', '/api/allowed-hosts',
        { token: adminToken, body: { hosts: ['https://otpnow.onrender.com/', 'spare.onrender.com'] } });
    assert.deepStrictEqual(res.body.hosts, ['otpnow.onrender.com', 'spare.onrender.com'],
        'a pasted URL is reduced to its host');
    res = await req('POST', '/api/allowed-hosts', { token: adminToken, body: { hosts: ['not a host'] } });
    assert.strictEqual(res.status, 400, 'nonsense is refused when you save it, not later');

    res = await req('GET', '/api/settings?deviceId=' + devA, { apiKey: 'test-key' });
    assert.ok(Array.isArray(res.body.allowedHosts) && res.body.allowedHosts.length === 2,
        'the app receives the list on the poll it already makes');

    // Presence comes from that same poll.
    const dev = users.getDevice(devA);
    assert.ok(dev.lastSeen > 0, 'lastSeen is earned by the existing poll — no new mechanism');

    // ── I8: an older app, sending no deviceId, still works ───────────────────
    res = await req('POST', '/sms', { apiKey: 'test-key', body: {
        sender: 'IVAC', recipient: '01799999999', message: 'Your OTP is 555555',
        arrivedAt: Date.now() } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.code, '555555', 'extraction is unaffected by identity');
    const legacy = store.getSmsFor(users.ADMIN_ID).find(m => m.message.includes('555555'));
    assert.strictEqual(legacy.userId, users.ADMIN_ID,
        'an app that sends no deviceId files to admin — nothing is dropped for want of identity');

    // ── I9: /get is untouched ────────────────────────────────────────────────
    assert.strictEqual(store.getOtp('01799999999'), '555555',
        '/get resolves by number alone, exactly as before');

    // ── Passwords are hashed, never stored or returned ───────────────────────
    const hash = users.hashPassword('correct horse battery staple');
    assert.ok(hash.startsWith('scrypt$'), 'scrypt, from the standard library — no new dependency');
    assert.ok(users.verifyPassword('correct horse battery staple', hash));
    assert.ok(!users.verifyPassword('wrong', hash));
    res = await req('GET', '/api/users', { token: adminToken });
    assert.ok(!res.raw.includes('scrypt$'), 'a password hash must never leave the server');

    console.log('ok — identity: enrollment codes are one-time, scoping is server-side, '
        + 'deactivation takes every control mid-session, two unresolved SIMs no longer '
        + 'collide, and an older app still works');
    process.exit(0);
})().catch(e => {
    console.error(e);
    process.exit(1);
});
