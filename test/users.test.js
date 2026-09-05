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

    // THE KEY MUST SURVIVE canonicalizePhone. It strips non-digits from the
    // whole string, so a raw "Unknown-<hex>" key collapses into something that
    // looks like a phone number 3.87% of the time — and "01488819719" is a
    // valid BD mobile number, so it can COLLIDE with a real recipient. Exactly
    // the bug the disambiguation exists to prevent. Found by a test that failed
    // roughly one run in twenty-five.
    const { canonicalizePhone } = require('../lib/phone');
    for (const m of unknowns) {
        assert.strictEqual(canonicalizePhone(m.recipient), m.recipient,
            'an Unknown key must be canonicalize-stable, or the OTP becomes '
            + 'unfetchable and the key can collide with a real number: ' + m.recipient);
        assert.ok(!/\d/.test(m.recipient.slice('Unknown-'.length)),
            'which is why the device id is encoded to letters only');
    }

    const stillPending = unknowns.filter(m => m.status === 'pending');
    assert.strictEqual(stillPending.length, 2,
        'neither message may have superseded the other — they belong to different phones');

    assert.strictEqual(store.getOtp(store.unknownKey(devA)), '111111',
        "rahim's phone keeps its own code");
    assert.strictEqual(store.getOtp(store.unknownKey(devB)), '222222',
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

    // THEIR PHONES STOP FORWARDING.
    //
    // This reverses the earlier behaviour, on the owner's instruction:
    // "if an user is not active ... his message will not be forwarded".
    // Deactivating is how you take someone out of the system, and leaving their
    // phones pushing SMS into the admin's view is not what that means to the
    // person doing it.
    res = await req('POST', '/sms', { apiKey: 'test-key', body: {
        sender: 'IVAC', recipient: '01722222222', message: 'Your OTP is 444444',
        arrivedAt: Date.now(), deviceId: devA } });
    assert.strictEqual(res.status, 200,
        'declined with 200, not an error — a 4xx would put it in the app retry queue');
    assert.strictEqual(res.body.ignored, true,
        "a deactivated user's phones must stop forwarding");
    let filed = store.getSmsFor(users.ADMIN_ID).find(m => m.message.includes('444444'));
    assert.ok(!filed, 'and nothing is stored for them at all');

    // An UNASSIGNED device is unaffected — a new phone must work from the moment
    // it is installed, before anyone has had the chance to assign it.
    const devFree = (await req('POST', '/api/register',
        { apiKey: 'test-key', body: { model: 'Nokia G21' } })).body.deviceId;
    res = await req('POST', '/sms', { apiKey: 'test-key', body: {
        sender: 'IVAC', recipient: '01766660000', message: 'Your OTP is 666000',
        deviceId: devFree } });
    assert.ok(!res.body.ignored, 'an unassigned device still forwards');

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
    // ASYNC since 4.30.2 — scryptSync blocks the event loop for ~37ms, and that
    // loop also serves /get. Awaiting here is the point, not an inconvenience.
    const hash = await users.hashPassword('correct horse battery staple');
    assert.ok(hash.startsWith('scrypt$'), 'scrypt, from the standard library — no new dependency');
    assert.ok(await users.verifyPassword('correct horse battery staple', hash));
    assert.ok(!await users.verifyPassword('wrong', hash));

    // An unknown user must cost the same as a real one, or the timing tells an
    // attacker which usernames exist.
    const t0 = Date.now(); await users.authenticate('definitely-not-a-user', 'x');
    const unknownMs = Date.now() - t0;
    const t1 = Date.now(); await users.authenticate('rahim', 'wrong-password');
    const knownMs = Date.now() - t1;
    // Nothing on the OTP path may call the SYNCHRONOUS form. This is a source
    // check because the cost only shows up under concurrency, and a future edit
    // that reaches for scryptSync would look harmless in review.
    const fsMod = require('fs');
    const usersSrc = fsMod.readFileSync(__dirname + '/../lib/users.js', 'utf8');
    const codeOnly = usersSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/scryptSync/.test(codeOnly),
        'scryptSync blocks the event loop for ~37ms and that loop also serves /get — '
        + 'use the async crypto.scrypt');

    assert.ok(unknownMs > 5,
        'an unknown user must still pay the hashing cost — returning instantly is a '
        + `username oracle (unknown ${unknownMs}ms vs known ${knownMs}ms)`);
    res = await req('GET', '/api/users', { token: adminToken });
    assert.ok(!res.raw.includes('scrypt$'), 'a password hash must never leave the server');

    // ─────────────────────────────────────────────────────────────────────────
    // THE OPTIONAL USERNAME CLAIM, AND WHO WINS
    //
    // Rules, in the owner's words: only the admin creates users; typing a name
    // on a phone grants nothing; a blank or unknown name still forwards
    // perfectly; and the dashboard assignment always wins.
    // ─────────────────────────────────────────────────────────────────────────
    await req('POST', '/api/users', { token: adminToken, body: { name: 'Sabbir' } });

    // A phone claiming a real user is linked without any dashboard action.
    let r = await req('POST', '/api/register', { apiKey: 'test-key',
        body: { model: 'Vivo Y21', claimedUser: 'sabbir' } });
    const devC = r.body.deviceId;
    assert.strictEqual(r.body.claimStatus, 'claimed', 'a valid claim links the phone');
    assert.strictEqual(r.body.userId, 'sabbir', 'and the effective owner is that user');

    await req('POST', '/sms', { apiKey: 'test-key', body: {
        sender: 'IVAC', recipient: '01788888888', message: 'Your OTP is 888888', deviceId: devC } });
    filed = store.getSmsFor(users.ADMIN_ID).find(m => m.message.includes('888888'));
    assert.strictEqual(filed.userId, 'sabbir', 'and its messages file to them');

    // THE DASHBOARD WINS. An admin assignment outranks whatever was typed.
    await req('POST', `/api/devices/${devC}/assign`, { token: adminToken, body: { userId: 'rahim' } });
    r = await req('POST', '/api/register', { apiKey: 'test-key',
        body: { deviceId: devC, claimedUser: 'sabbir' } });
    assert.strictEqual(r.body.userId, 'rahim',
        'THE DASHBOARD ASSIGNMENT WINS — a typed name can be mistyped or go stale, and '
        + 'the dashboard is the only side fixable without touching the phone');
    assert.strictEqual(r.body.claimStatus, 'overridden',
        'and the phone is told so, rather than the field looking ignored');

    // An unknown name is NOT an error — forwarding must never depend on a typo
    // in an optional field.
    r = await req('POST', '/api/register', { apiKey: 'test-key',
        body: { model: 'Oppo A17', claimedUser: 'nosuchperson' } });
    const devU = r.body.deviceId;
    assert.strictEqual(r.body.claimStatus, 'unknown_user', 'the typo is reported');
    assert.strictEqual(r.body.userId, '', 'and no owner is invented');

    res = await req('POST', '/sms', { apiKey: 'test-key', body: {
        sender: 'IVAC', recipient: '01799991111', message: 'Your OTP is 999111', deviceId: devU } });
    assert.strictEqual(res.status, 200, 'A PHONE WITH A BAD USERNAME STILL FORWARDS');
    assert.strictEqual(res.body.code, '999111', 'and extraction is entirely unaffected');
    filed = store.getSmsFor(users.ADMIN_ID).find(m => m.message.includes('999111'));
    assert.strictEqual(filed.userId, users.ADMIN_ID, 'its messages go to admin');

    // A claim on a DEACTIVATED account also falls back to admin.
    await req('POST', '/api/users/sabbir/active', { token: adminToken, body: { active: false } });
    r = await req('POST', '/api/register', { apiKey: 'test-key',
        body: { model: 'Realme C55', claimedUser: 'sabbir' } });
    assert.strictEqual(r.body.claimStatus, 'inactive_user', 'a deactivated account is reported');
    assert.strictEqual(r.body.userId, '', 'and does not become an owner');

    // ─────────────────────────────────────────────────────────────────────────
    // REVIEW FINDINGS — each of these was a real bug, so each gets an assertion.
    // ─────────────────────────────────────────────────────────────────────────

    // #11 The code is read off a screen and typed by hand; the dash is
    // formatting, not part of the secret.
    await req('POST', '/api/users', { token: adminToken, body: { name: 'Dashless' } });
    const dashCode = (await req('POST', '/api/users/dashless/reissue',
        { token: adminToken })).body.enrollCode;
    res = await req('POST', '/api/set-password', { body: {
        username: 'dashless', code: dashCode.replace('-', '').toLowerCase(),
        password: 'password-1234' } });
    assert.strictEqual(res.status, 200,
        'the enrollment code must accept no dash and any case — rejecting "L8SUY5ZQ" '
        + 'teaches only that the system is fussy');

    // #3 Purging must clear the CLAIM as well as the assignment, or the device
    // is silenced permanently by a claim pointing at a user that is gone.
    await req('POST', '/api/users', { token: adminToken, body: { name: 'Doomed' } });
    const devDoom = (await req('POST', '/api/register', { apiKey: 'test-key',
        body: { model: 'Vivo Y21', claimedUser: 'doomed' } })).body.deviceId;
    res = await req('POST', '/sms', { apiKey: 'test-key', body: {
        sender: 'IVAC', recipient: '01712121212', message: 'Your OTP is 121212',
        deviceId: devDoom } });
    assert.ok(!res.body.ignored, 'the claimed device forwards before the purge');

    await req('POST', '/api/users/doomed/purge', { token: adminToken });
    res = await req('POST', '/sms', { apiKey: 'test-key', body: {
        sender: 'IVAC', recipient: '01713131313', message: 'Your OTP is 131313',
        deviceId: devDoom } });
    assert.ok(!res.body.ignored,
        'AND AFTER IT. Purging left claimedUserId pointing at a deleted user, so '
        + 'forwardingFor() declined every push with nothing on screen to explain it');
    assert.strictEqual(users.getDevice(devDoom).claimedUserId, null,
        'the stale claim is cleared, not merely the assignment');

    // #6 The roster is admin business. This endpoint returned every user id,
    // name and override to any signed-in caller while /api/users was admin-only.
    const rahim3 = (await req('POST', '/api/login',
        { body: { username: 'rahim', password: 'rahim-password' } })).body.token;
    res = await req('GET', '/api/full-settings', { token: rahim3 });
    assert.strictEqual(res.status, 200, 'a user may still read their own settings');
    assert.ok(!(res.body.identity && res.body.identity.userList),
        'but must NOT receive the list of every other user');
    assert.ok(!res.body.filters, 'nor the OTP filters, which only admin may change');
    res = await req('GET', '/api/full-settings', { token: adminToken });
    assert.ok(res.body.identity.userList.length > 0, 'admin still gets everything');

    console.log('ok — identity: enrollment codes are one-time, scoping is server-side, '
        + 'deactivation takes every control mid-session, two unresolved SIMs no longer '
        + 'collide, an unknown username still forwards, the dashboard always wins, '
        + 'and an older app still works');
    process.exit(0);
})().catch(e => {
    console.error(e);
    process.exit(1);
});
