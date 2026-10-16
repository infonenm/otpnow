/**
 * test/devicepush.test.js — server 4.38.0 (removal text 4.39.0): push a username to one phone, and
 * see per device whether the last Clear Log has been carried out.
 *
 * What must hold:
 *   1. Push sets the OWNER on the server and addresses ONLY that phone (its own
 *      FCM topic), and the poll carries the same push for a phone FCM misses.
 *   2. It is "saved on phone" only when the PHONE confirms — by registering
 *      with that name — never merely because the server sent it.
 *   3. A removed device is refused with a reason (reinstall to come back); admin and
 *      deactivated accounts cannot be pushed; users cannot push at all.
 *   4. Clear Log status comes from the phone's own report, per device, and a
 *      device that has not reported is shown as not done.
 *
 * Run: node test/devicepush.test.js
 */
const assert = require('assert');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

process.env.DASHBOARD_PASSWORD = 'admin-pw';
process.env.API_KEY            = 'test-key';
process.env.USERS_ENABLED      = 'true';
process.env.OTP_PATTERNS       = '(\\d{4,8})';
process.env.STATE_FILE         = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-dp-')), 's.json');
process.env.PORT               = '3995';

// Capture every push instead of sending it.
const fcm = require('../lib/fcm');
const sent = [];
fcm.send = async (action, ts, topic, extra) => { sent.push({ action, ts, topic, extra }); };

require('../server.js');

function req(method, p, { body, token, apiKey } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json';
                    headers['Content-Length'] = Buffer.byteLength(data); }
        if (token)  headers.Authorization = 'Bearer ' + token;
        if (apiKey) headers['X-Api-Key'] = apiKey;
        const r = http.request({ host: '127.0.0.1', port: 3995, method, path: p, headers }, res => {
            let raw = ''; res.on('data', c => raw += c);
            res.on('end', () => { let b = null; try { b = JSON.parse(raw); } catch (e) { /* */ }
                                  resolve({ status: res.statusCode, body: b }); });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    await sleep(300);
    const admin = (await req('POST', '/api/login', { body: { password: 'admin-pw' } })).body.token;

    // Two users; one enrolled so a user session exists.
    const rahimCode = (await req('POST', '/api/users', { token: admin, body: { name: 'Rahim' } })).body.enrollCode;
    await req('POST', '/api/users', { token: admin, body: { name: 'Karim' } });
    await req('POST', '/api/set-password', { body: { username: 'rahim', code: rahimCode, password: 'rahim-password' } });
    const rahim = (await req('POST', '/api/login', { body: { username: 'rahim', password: 'rahim-password' } })).body.token;

    const devA = (await req('POST', '/api/register', { apiKey: 'test-key', body: { model: 'Galaxy A14' } })).body.deviceId;
    const devB = (await req('POST', '/api/register', { apiKey: 'test-key', body: { model: 'Redmi 12' } })).body.deviceId;

    // ── 1. Push: owner set, one phone addressed, poll carries it ─────────────
    let res = await req('POST', `/api/devices/${devA}/push-username`, { token: admin, body: { userId: 'karim' } });
    assert.strictEqual(res.status, 200, 'admin can push a username');
    assert.strictEqual(res.body.username, 'Karim');
    const push = sent.find(s => s.action === 'set_username');
    assert.ok(push, 'an FCM push was sent');
    assert.strictEqual(push.topic, 'device_' + devA, 'to THAT phone\'s own topic, not a broadcast');
    assert.strictEqual(push.extra.username, 'Karim');

    let devs = (await req('GET', '/api/devices', { token: admin })).body.devices;
    let a = devs.find(d => d.id === devA);
    assert.strictEqual(a.userId, 'karim', 'Push also sets the OWNER (one action, by decision)');
    assert.ok(a.pendingUsername && a.pendingUsername.name === 'Karim', 'and is waiting for the phone');
    assert.ok(!a.usernameAck, 'not yet confirmed');

    res = await req('GET', `/api/settings?deviceId=${devA}`, { apiKey: 'test-key' });
    assert.deepStrictEqual(res.body.pushUsername, { name: 'Karim', ts: push.ts },
        'the poll carries the same push, with the same ts the app de-duplicates on');
    res = await req('GET', `/api/settings?deviceId=${devB}`, { apiKey: 'test-key' });
    assert.strictEqual(res.body.pushUsername, undefined, 'and ONLY to that phone');

    // ── 2. Confirmed only when the phone registers with the name ─────────────
    await req('POST', '/api/register', { apiKey: 'test-key', body: { deviceId: devA, model: 'Galaxy A14' } });
    a = (await req('GET', '/api/devices', { token: admin })).body.devices.find(d => d.id === devA);
    assert.ok(a.pendingUsername, 'a registration WITHOUT the name does not confirm it');

    await req('POST', '/api/register', { apiKey: 'test-key',
        body: { deviceId: devA, model: 'Galaxy A14', claimedUser: 'Karim' } });
    a = (await req('GET', '/api/devices', { token: admin })).body.devices.find(d => d.id === devA);
    assert.strictEqual(a.pendingUsername, null, 'the phone registering with the name confirms it');
    assert.ok(a.usernameAck && a.usernameAck.name === 'Karim' && a.usernameAck.at > 0,
        'and the dashboard can say "saved on the phone" with a time');
    res = await req('GET', `/api/settings?deviceId=${devA}`, { apiKey: 'test-key' });
    assert.strictEqual(res.body.pushUsername, undefined, 'once confirmed, the poll stops offering it');

    // ── 3. Refusals ──────────────────────────────────────────────────────────
    res = await req('POST', `/api/devices/${devB}/push-username`, { token: admin, body: { userId: 'admin' } });
    assert.strictEqual(res.status, 400, 'admin is not a user a phone can claim');
    res = await req('POST', `/api/devices/${devB}/push-username`, { token: admin, body: { userId: '' } });
    assert.strictEqual(res.status, 400, 'no user chosen');
    res = await req('POST', `/api/devices/${devB}/push-username`, { token: admin, body: { userId: 'nobody' } });
    assert.strictEqual(res.status, 400, 'unknown user');
    await req('POST', '/api/users/karim/active', { token: admin, body: { active: false } });
    res = await req('POST', `/api/devices/${devB}/push-username`, { token: admin, body: { userId: 'karim' } });
    assert.strictEqual(res.status, 400, 'a deactivated account cannot be pushed');
    await req('POST', '/api/users/karim/active', { token: admin, body: { active: true } });
    res = await req('POST', `/api/devices/${devB}/push-username`, { token: rahim, body: { userId: 'rahim' } });
    assert.strictEqual(res.status, 403, 'a user cannot push usernames');
    res = await req('POST', '/api/devices/ffffffffffffffff/push-username', { token: admin, body: { userId: 'rahim' } });
    assert.strictEqual(res.status, 404, 'unknown device');

    await req('POST', `/api/devices/${devB}/remove`, { token: admin });
    const before = sent.length;
    res = await req('POST', `/api/devices/${devB}/push-username`, { token: admin, body: { userId: 'rahim' } });
    assert.strictEqual(res.status, 409, 'a REMOVED device is refused');
    assert.ok(/reinstall/i.test(res.body.error), 'with the way forward in the message: ' + res.body.error);
    assert.strictEqual(sent.length, before, 'and nothing is pushed to it');

    // ── 3b. A pending push is withdrawn when its account is deactivated ──────
    const devD = (await req('POST', '/api/register', { apiKey: 'test-key', body: { model: 'Nokia G21' } })).body.deviceId;
    await req('POST', `/api/devices/${devD}/push-username`, { token: admin, body: { userId: 'rahim' } });
    assert.ok((await req('GET', `/api/settings?deviceId=${devD}`, { apiKey: 'test-key' })).body.pushUsername);
    await req('POST', '/api/users/rahim/active', { token: admin, body: { active: false } });
    res = await req('GET', `/api/settings?deviceId=${devD}`, { apiKey: 'test-key' });
    assert.strictEqual(res.body.pushUsername, undefined,
        'deactivating the account withdraws its unconfirmed push (review finding)');
    await req('POST', '/api/register', { apiKey: 'test-key',
        body: { deviceId: devD, model: 'Nokia G21', claimedUser: 'rahim' } });
    let dd = (await req('GET', '/api/devices', { token: admin })).body.devices.find(d => d.id === devD);
    assert.ok(!dd.usernameAck, 'and a phone registering with that name is not reported "saved"');
    await req('POST', '/api/users/rahim/active', { token: admin, body: { active: true } });

    // ── 3c. "Retry now" keeps the state the phones reported ─────────────────
    await req('POST', `/api/devices/${devD}/push-username`, { token: admin, body: { userId: 'karim' } });
    res = await req('POST', '/api/reload', { token: admin, body: {} });
    assert.strictEqual(res.status, 200);
    dd = (await req('GET', '/api/devices', { token: admin })).body.devices.find(d => d.id === devD);
    assert.ok(dd.pendingUsername && dd.pendingUsername.name === 'Karim',
        'a reload must not silently drop an unconfirmed push (review finding)');
    assert.ok(dd.lastSeen > 0, 'nor "last seen"');
    const usersAfter = (await req('GET', '/api/users', { token: admin })).body.users.map(u => u.id).sort();
    assert.deepStrictEqual(usersAfter, ['karim', 'rahim'],
        'and with Firestore off, a reload must not wipe the accounts held in memory');

    // ── 4. Clear Log status, reported by each phone ─────────────────────────
    const devC = (await req('POST', '/api/register', { apiKey: 'test-key', body: { model: 'Pixel 6' } })).body.deviceId;
    devs = (await req('GET', '/api/devices', { token: admin })).body.devices;
    assert.strictEqual(devs.find(d => d.id === devC).clearTarget, 0, 'no Clear Log yet: nothing to show');

    res = await req('POST', '/api/clear-log', { token: admin, body: {} });
    assert.strictEqual(res.status, 200);
    const target = (await req('GET', `/api/settings?deviceId=${devC}`, { apiKey: 'test-key' })).body.clearLogTs;
    devs = (await req('GET', '/api/devices', { token: admin })).body.devices;
    let c = devs.find(d => d.id === devC);
    assert.strictEqual(c.clearTarget, target, 'each device carries the Clear Log it should have done');
    assert.ok(!(c.clearedTs >= c.clearTarget), 'and until the phone reports it, it is not done');
    assert.ok(!c.clearReported,
        'a phone that has never reported is UNKNOWN, not "not done" — an older app cannot report');
    await req('GET', `/api/settings?deviceId=${devC}&clearedTs=0`, { apiKey: 'test-key' });
    c = (await req('GET', '/api/devices', { token: admin })).body.devices.find(d => d.id === devC);
    assert.ok(c.clearReported && !(c.clearedTs >= c.clearTarget),
        'a 4.33.0 phone reporting an older clear IS "not done yet"');

    await req('GET', `/api/settings?deviceId=${devC}&clearedTs=${target}`, { apiKey: 'test-key' });
    c = (await req('GET', '/api/devices', { token: admin })).body.devices.find(d => d.id === devC);
    assert.ok(c.clearedTs >= c.clearTarget, 'the phone\'s report marks it done');
    await req('GET', `/api/settings?deviceId=${devC}&clearedTs=1`, { apiKey: 'test-key' });
    c = (await req('GET', '/api/devices', { token: admin })).body.devices.find(d => d.id === devC);
    assert.ok(c.clearedTs >= c.clearTarget, 'an older report never moves it backwards');
    await req('GET', `/api/settings?deviceId=${devC}&clearedTs=junk`, { apiKey: 'test-key' });
    c = (await req('GET', '/api/devices', { token: admin })).body.devices.find(d => d.id === devC);
    assert.ok(c.clearedTs >= c.clearTarget, 'and junk is ignored');

    // ── 5. Over HTTP: removed until reinstalled (4.39.0) ────────────────────
    const devE = (await req('POST', '/api/register', { apiKey: 'test-key',
        body: { deviceId: 'abababababababab', model: 'Redmi 12', installId: '0000000000000001' } })).body.deviceId;
    assert.strictEqual(devE, 'abababababababab', 'the phone keeps the id it derived');
    res = await req('GET', '/api/devices', { token: admin });
    assert.strictEqual(res.body.hideAfterDays, 7, 'the dashboard is told the hide limit');
    assert.strictEqual(res.body.deleteAfterDays, 15, 'and the delete limit');
    assert.strictEqual(res.body.revoked, undefined, 'and there is no "Removed devices" list any more');
    assert.strictEqual((await req('POST', `/api/devices/${devE}/restore`, { token: admin })).status, 404,
        '"Allow back" is gone');

    await req('POST', `/api/devices/${devE}/remove`, { token: admin });
    const sms = (inst) => req('POST', '/sms', { apiKey: 'test-key', body: {
        sender: 'IVAC', message: 'Your OTP is 551234', recipient: '01711111111',
        deviceId: devE, installId: inst, arrivedAt: Date.now() } });
    res = await sms('0000000000000001');
    assert.ok(res.body && res.body.revoked === true, 'the same install is still removed on /sms: '
        + JSON.stringify(res.body));
    res = await req('GET', `/api/settings?deviceId=${devE}&installId=0000000000000001`, { apiKey: 'test-key' });
    assert.strictEqual(res.body.revoked, true, 'and on the poll');
    res = await req('POST', '/api/register', { apiKey: 'test-key',
        body: { deviceId: devE, installId: '0000000000000001', claimedUser: 'rahim' } });
    assert.strictEqual(res.body.revoked, true, 'a username does not bring it back');

    res = await sms('0000000000000002');           // reinstalled; its first contact is an SMS
    assert.ok(res.body && !res.body.revoked, 'a reinstall lifts it before the forwarding decision: '
        + JSON.stringify(res.body));
    res = await req('POST', '/api/register', { apiKey: 'test-key',
        body: { deviceId: devE, model: 'Redmi 12', installId: '0000000000000002' } });
    assert.strictEqual(res.body.deviceId, devE, 'and it registers');
    const e = (await req('GET', '/api/devices', { token: admin })).body.devices.find(d => d.id === devE);
    assert.ok(e && !e.userId && !e.simNumber, 'as a new, unassigned device');

    console.log('ok — push reaches one phone, sets its owner, is confirmed by the phone; '
        + 'removed devices stay removed until a reinstall; Clear Log status comes from each phone');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
