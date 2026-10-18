/**
 * test/wake.test.js — server 4.41.3: Test also wakes the phones, and the
 * dashboard shows which answered.
 *
 * What must hold:
 *   1. A Test lists exactly the phones it reaches: every listed phone for
 *      "all", only the owner's for a user — never a removed or long-gone one.
 *   2. A phone answers by reporting THIS Test's timestamp on its poll (app
 *      4.37.0) or by its test message (any app) — an older timestamp is not an
 *      answer, and nothing counts after the window.
 *   3. Each person sees only their own run; live updates go to the presser.
 *   4. /get and the OTP path are untouched (the test message is still stored).
 *
 * Run: node test/wake.test.js
 */
const assert = require('assert');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

process.env.DASHBOARD_PASSWORD = 'admin-pw';
process.env.API_KEY            = 'test-key';
process.env.USERS_ENABLED      = 'true';
process.env.STATE_FILE         = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-wake-')), 's.json');
process.env.PORT               = '3995';

const fcm = require('../lib/fcm');
const pushes = [];
fcm.send = async (action, ts, topic) => { pushes.push({ action, ts, topic }); };

const users = require('../lib/users');
const wake  = require('../lib/wake');
require('../server.js');
const events = [];
wake.setBroadcast((ev, data, aud) => events.push({ ev, data, aud }));

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
const KEY = 'test-key';
const register = (deviceId, appVersion) => req('POST', '/api/register', { apiKey: KEY,
    body: { deviceId, model: 'Phone ' + deviceId.slice(0, 2), installId: deviceId, appVersion } });

(async () => {
    await sleep(300);
    const admin = (await req('POST', '/api/login', { body: { password: 'admin-pw' } })).body.token;
    const created = (await req('POST', '/api/users', { token: admin, body: { name: 'Rahim' } })).body;
    await req('POST', '/api/set-password', { body: { username: 'rahim', code: created.enrollCode,
                                                     password: 'rahim-password' } });
    const rahim = (await req('POST', '/api/login', { body: { username: 'rahim', password: 'rahim-password' } })).body.token;

    const A = 'a1a1a1a1a1a1a1a1', B = 'b2b2b2b2b2b2b2b2', C = 'c3c3c3c3c3c3c3c3', D = 'd4d4d4d4d4d4d4d4';
    await register(A, '4.37.0');
    await register(B, '4.36.0');
    await register(C, '4.36.0');
    await register(D, '4.36.0');
    await req('POST', `/api/devices/${A}/assign`, { token: admin, body: { userId: 'admin' } });
    await req('POST', `/api/devices/${B}/assign`, { token: admin, body: { userId: 'rahim' } });
    // C: silent for 9 days (hidden as gone). D: removed by the admin.
    const c = users.getDevice(C); c.lastSeen = c.seenAt = c.createdAt = Date.now() - 9 * 86_400_000;
    await req('POST', `/api/devices/${D}/remove`, { token: admin, body: {} });

    // ── 1. who a Test reaches ────────────────────────────────────
    let r = await req('POST', '/api/test', { token: admin, body: { target: 'all' } });
    assert.strictEqual(r.status, 200);
    let run = r.body.run;
    assert.deepStrictEqual(run.devices.map(x => x.id).sort(), [A, B].sort(),
        'all listed phones — not one gone for a week, not a removed one');
    assert.ok(run.devices.every(x => !x.answeredAt), 'nobody has answered yet');
    assert.strictEqual(run.ts, pushes[pushes.length - 1].ts, 'the run is the Test that was pushed');
    const adminTs = run.ts;

    r = await req('POST', '/api/test', { token: rahim, body: { target: 'all' } });
    const rRun = r.body.run;
    assert.deepStrictEqual(rRun.devices.map(x => x.id), [B], 'a user\'s Test reaches only their phones');

    // ── 3. runs are per person ───────────────────────────────────
    assert.strictEqual((await req('GET', '/api/test/status', { token: admin })).body.run.ts, adminTs);
    assert.strictEqual((await req('GET', '/api/test/status', { token: rahim })).body.run.ts, rRun.ts);
    assert.strictEqual((await req('GET', '/api/test/status')).status, 401);

    // ── 2. answers ───────────────────────────────────────────────
    // An OLD wake (a previous Test) is not an answer to this one.
    await req('GET', `/api/settings?deviceId=${A}&wokeTs=${adminTs - 60_000}`, { apiKey: KEY });
    run = (await req('GET', '/api/test/status', { token: admin })).body.run;
    assert.ok(!run.devices.find(x => x.id === A).answeredAt, 'an older wake does not count');
    // This Test's timestamp on the poll: answered, by waking.
    events.length = 0;
    await req('GET', `/api/settings?deviceId=${A}&wokeTs=${adminTs}`, { apiKey: KEY });
    run = (await req('GET', '/api/test/status', { token: admin })).body.run;
    const a = run.devices.find(x => x.id === A);
    assert.ok(a.answeredAt > 0 && a.via === 'woke', 'answered by waking');
    assert.ok(events.some(e => e.ev === 'wake_update' && e.aud.userId === 'admin'),
        'the presser is told live');
    assert.ok(!events.some(e => e.aud.userId === 'rahim'), 'and nobody else\'s run is touched');
    const firstAt = a.answeredAt;
    await req('GET', `/api/settings?deviceId=${A}&wokeTs=${adminTs}`, { apiKey: KEY });
    run = (await req('GET', '/api/test/status', { token: admin })).body.run;
    assert.strictEqual(run.devices.find(x => x.id === A).answeredAt, firstAt, 'answering twice changes nothing');

    // B runs an older app: its TEST MESSAGE is the answer — for both runs that reach it.
    r = await req('POST', '/sms', { apiKey: KEY, body: { sender: 'GetOTP-Test', recipient: 'Unknown',
        message: 'Test OTP: 123456 — enter SIM numbers in Settings', deviceId: B } });
    assert.strictEqual(r.status, 200);
    run = (await req('GET', '/api/test/status', { token: admin })).body.run;
    assert.strictEqual(run.devices.find(x => x.id === B).via, 'test', 'answered by its test message');
    const rr = (await req('GET', '/api/test/status', { token: rahim })).body.run;
    assert.strictEqual(rr.devices[0].via, 'test', 'Rahim\'s own run sees it too');
    // An ordinary SMS is not an answer.
    wake._reset();
    r = await req('POST', '/api/test', { token: admin, body: { target: 'all' } });
    await req('POST', '/sms', { apiKey: KEY, body: { sender: 'IVAC_BD', recipient: '01700000000',
        message: 'Your OTP is 445566', deviceId: B } });
    run = (await req('GET', '/api/test/status', { token: admin })).body.run;
    assert.ok(!run.devices.find(x => x.id === B).answeredAt, 'a real SMS is not a Test answer');
    // ── 4. and the OTP path is untouched
    const g = await req('GET', '/get?number=01700000000');
    assert.strictEqual(g.body.otp, '445566', '/get is unchanged');

    // Nothing counts after the window.
    const late = run.startedAt + wake.ANSWER_WINDOW_MS + 61_000;
    assert.strictEqual(wake.noteAnswer(B, 'test', 0, late), 0, 'no answer is recorded after the window');
    assert.strictEqual(wake.noteAnswer(B, 'woke', run.ts, run.startedAt + 1000), 1, 'inside it, yes');
    assert.strictEqual(wake.noteAnswer(B, 'woke', 0, run.startedAt + 1000), 0, 'a woke report needs a timestamp');

    // A user target that names one user, from the admin.
    r = await req('POST', '/api/test', { token: admin, body: { target: 'rahim' } });
    assert.deepStrictEqual(r.body.run.devices.map(x => x.id), [B]);
    assert.strictEqual(r.body.run.target, 'rahim');

    console.log('ok — a Test lists exactly the phones it reaches, a phone answers only by waking for THIS '
        + 'Test or by its test message, inside the window, each person sees only their own check, and /get is unchanged');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
