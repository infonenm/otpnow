/**
 * test/keeponline.test.js — server 4.41.3: the "Keep online" switch.
 *
 * What must hold:
 *   1. Admin only. ON for all phones or one user's; OFF for everyone.
 *   2. Each phone's poll is told { on, ts } for ITSELF — a phone outside the
 *      target is told off — and nothing at all until the switch is used, so an
 *      older app and an unused switch see exactly what they saw before.
 *   3. ts only grows, so a phone can always tell the newer command.
 *   4. The push goes where the change applies (ON: the target; OFF: where the
 *      last ON went), as a signal only.
 *   5. What each phone reports (holding / battery exempt) shows in the status,
 *      and a report from before this ON does not count as holding for it.
 *   6. /get and the rest of the poll are untouched.
 *
 * Run: node test/keeponline.test.js
 */
const assert = require('assert');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

process.env.DASHBOARD_PASSWORD = 'admin-pw';
process.env.API_KEY            = 'test-key';
process.env.USERS_ENABLED      = 'true';
process.env.STATE_FILE         = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-ko-')), 's.json');
process.env.PORT               = '3996';

const fcm = require('../lib/fcm');
const pushes = [];
fcm.send = async (action, ts, topic) => { pushes.push({ action, ts, topic }); };

const users      = require('../lib/users');
const keepOnline = require('../lib/keeponline');
require('../server.js');
const events = [];
keepOnline.setBroadcast((ev, data, aud) => events.push({ ev, data, aud }));

function req(method, p, { body, token, apiKey } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json';
                    headers['Content-Length'] = Buffer.byteLength(data); }
        if (token)  headers.Authorization = 'Bearer ' + token;
        if (apiKey) headers['X-Api-Key'] = apiKey;
        const r = http.request({ host: '127.0.0.1', port: 3996, method, path: p, headers }, res => {
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
const KEY = 'test-key';
const register = (deviceId, appVersion) => req('POST', '/api/register', { apiKey: KEY,
    body: { deviceId, model: 'Phone ' + deviceId.slice(0, 2), installId: deviceId, appVersion } });
const poll = (id, q) => req('GET', `/api/settings?deviceId=${id}${q || ''}`, { apiKey: KEY });

(async () => {
    await sleep(300);
    const admin = (await req('POST', '/api/login', { body: { password: 'admin-pw' } })).body.token;
    const created = (await req('POST', '/api/users', { token: admin, body: { name: 'Rahim' } })).body;
    await req('POST', '/api/set-password', { body: { username: 'rahim', code: created.enrollCode,
                                                     password: 'rahim-password' } });
    const rahim = (await req('POST', '/api/login', { body: { username: 'rahim', password: 'rahim-password' } })).body.token;

    const A = 'a1a1a1a1a1a1a1a1', B = 'b2b2b2b2b2b2b2b2';
    await register(A, '4.37.0');
    await register(B, '4.37.0');
    await req('POST', `/api/devices/${A}/assign`, { token: admin, body: { userId: 'admin' } });
    await req('POST', `/api/devices/${B}/assign`, { token: admin, body: { userId: 'rahim' } });

    // ── 2. unused switch: the poll is exactly as before ──────────
    let p = await poll(A);
    assert.strictEqual(p.status, 200);
    assert.ok(!('keepOnline' in p.body), 'nothing is sent until the switch is used');
    const keysBefore = Object.keys(p.body).sort();

    // ── 1. admin only ────────────────────────────────────────────
    assert.strictEqual((await req('POST', '/api/keep-online', { token: rahim, body: { on: true } })).status, 403);
    assert.strictEqual((await req('GET', '/api/keep-online', { token: rahim })).status, 403);
    assert.strictEqual((await req('POST', '/api/keep-online', { body: { on: true } })).status, 401);
    assert.strictEqual((await req('POST', '/api/keep-online', { token: admin,
        body: { on: true, target: 'nobody' } })).status, 400, 'an unknown target is refused, not broadened');

    // ── ON for all ───────────────────────────────────────────────
    let r = await req('POST', '/api/keep-online', { token: admin, body: { on: true, target: 'all' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.status.on, true);
    assert.strictEqual(r.body.status.target, null);
    const ts1 = r.body.status.ts;
    const push1 = pushes[pushes.length - 1];
    assert.deepStrictEqual([push1.action, push1.ts, push1.topic], ['keep_online', ts1, undefined],
        'ON for all is pushed to every phone');
    assert.ok(events.some(e => e.ev === 'keep_online' && e.aud.adminOnly), 'admins are told live');
    assert.deepStrictEqual((await poll(A)).body.keepOnline, { on: true, ts: ts1 });
    assert.deepStrictEqual((await poll(B)).body.keepOnline, { on: true, ts: ts1 });
    assert.deepStrictEqual(r.body.status.devices.map(d => d.id).sort(), [A, B].sort());

    // ── 5. reports ───────────────────────────────────────────────
    await poll(A, '&keepOnline=1&battExempt=1');
    await poll(B, '&keepOnline=1&battExempt=0');
    let st = (await req('GET', '/api/keep-online', { token: admin })).body.status;
    const a = st.devices.find(d => d.id === A), b = st.devices.find(d => d.id === B);
    assert.deepStrictEqual([a.holding, a.exempt], [true, true]);
    assert.deepStrictEqual([b.holding, b.exempt], [true, false], 'a phone Android may put to sleep is named');

    // ── ON for one user: others are told OFF; ts grows ───────────
    let pushMark = pushes.length;
    r = await req('POST', '/api/keep-online', { token: admin, body: { on: true, target: 'rahim' } });
    const ts2 = r.body.status.ts;
    assert.ok(ts2 > ts1, 'ts only grows');
    // Narrowing from ALL: the phones that drop out must hear it at once too,
    // so it goes to every phone (each fetches its own on/off).
    assert.deepStrictEqual(pushes.slice(pushMark).map(p => p.topic), [undefined],
        'a target change while on reaches the old group as well as the new');
    assert.deepStrictEqual((await poll(A)).body.keepOnline, { on: false, ts: ts2 }, 'outside the target: off');
    assert.deepStrictEqual((await poll(B)).body.keepOnline, { on: true, ts: ts2 });
    st = (await req('GET', '/api/keep-online', { token: admin })).body.status;
    assert.deepStrictEqual(st.devices.map(d => d.id), [B], 'the panel lists only the covered phones');
    assert.strictEqual(st.devices[0].holding, false, 'a report from before this ON does not count');
    events.length = 0;
    await poll(B, '&keepOnline=1&battExempt=0');            // exactly what it said before
    assert.ok(events.some(e => e.ev === 'keep_online'),
        'the first report for this ON goes out live, even if it says the same as before');
    st = (await req('GET', '/api/keep-online', { token: admin })).body.status;
    assert.strictEqual(st.devices[0].holding, true);
    assert.strictEqual(st.listed, true);

    // ── OFF: everyone, pushed where the last ON went ─────────────
    r = await req('POST', '/api/keep-online', { token: admin, body: { on: false } });
    const ts3 = r.body.status.ts;
    assert.ok(ts3 > ts2);
    assert.strictEqual(r.body.status.on, false);
    assert.strictEqual(pushes[pushes.length - 1].topic, 'user_rahim', 'OFF reaches the phones the ON reached');
    assert.deepStrictEqual((await poll(A)).body.keepOnline, { on: false, ts: ts3 });
    assert.deepStrictEqual((await poll(B)).body.keepOnline, { on: false, ts: ts3 });
    assert.deepStrictEqual(r.body.status.devices, [], 'nothing listed while off');
    // From OFF, ON for one user goes to that user's phones only.
    pushMark = pushes.length;
    await req('POST', '/api/keep-online', { token: admin, body: { on: true, target: 'rahim' } });
    assert.deepStrictEqual(pushes.slice(pushMark).map(p => p.topic), ['user_rahim']);
    await req('POST', '/api/keep-online', { token: admin, body: { on: false } });
    // An OFF after an ON-for-all goes to every phone.
    await req('POST', '/api/keep-online', { token: admin, body: { on: true } });
    await req('POST', '/api/keep-online', { token: admin, body: { on: false } });
    assert.strictEqual(pushes[pushes.length - 1].topic, undefined);

    // Reports from ids the server does not know are not kept (no growth).
    await poll('9999999999999999', '&keepOnline=1&battExempt=1');
    st = (await req('GET', '/api/keep-online', { token: admin })).body.status;
    assert.ok(!st.devices.some(d => d.id === '9999999999999999'));

    // A removed phone is never covered.
    await req('POST', '/api/keep-online', { token: admin, body: { on: true } });
    await req('POST', `/api/devices/${A}/remove`, { token: admin, body: {} });
    st = (await req('GET', '/api/keep-online', { token: admin })).body.status;
    assert.ok(!st.devices.some(d => d.id === A));
    assert.strictEqual(keepOnline.forDevice(A).on, false, 'and a removed phone is told OFF');

    // ── 3. ts grows even within the same millisecond ─────────────
    const sess = { userId: 'admin', role: 'admin' };
    const t0 = keepOnline.status().ts + 10;
    const x1 = keepOnline.set(true, null, sess, t0).status.ts;
    const x2 = keepOnline.set(false, null, sess, t0).status.ts;
    const x3 = keepOnline.set(true, null, sess, t0 - 5000).status.ts;   // a clock step back
    assert.ok(x2 > x1 && x3 > x2, 'every change gets a larger ts, whatever the clock does');
    keepOnline.set(false, null, sess);

    // ── 6. the rest of the poll is untouched ─────────────────────
    p = await poll(B);
    assert.deepStrictEqual(Object.keys(p.body).filter(k => k !== 'keepOnline').sort(), keysBefore,
        'the poll gains one key and loses none');
    await req('POST', '/sms', { apiKey: KEY, body: { sender: 'IVAC_BD', recipient: '01700000000',
        message: 'Your OTP is 445566', deviceId: B } });
    assert.strictEqual((await req('GET', '/get?number=01700000000')).body.otp, '445566', '/get is unchanged');

    console.log('ok — Keep online is admin only, tells each phone on/off for itself with a growing ts, '
        + 'pushes where the change applies, shows who is holding and who Android will put to sleep, '
        + 'and leaves the poll and /get as they were');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
