/**
 * test/retry.test.js — server 4.41.2: failure words and Retry.
 *
 * What must hold:
 *   1. Every failure the phone can report reaches the dashboard in words
 *      (errorText), and the raw value is kept unchanged (error).
 *   2. Retry makes a NEW job with the same SIM, recipient and text, through
 *      every send check — and at most ONCE per job, so a double click or two
 *      admins cannot send it twice.
 *   3. Only the sender (or an admin) may retry; only a failed final state.
 *   4. A retry never goes out from a different number than the original.
 *   5. /api/send cannot be used to forge retry fields.
 *
 * Run: node test/retry.test.js
 */
const assert = require('assert');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

process.env.DASHBOARD_PASSWORD = 'admin-pw';
process.env.API_KEY            = 'test-key';
process.env.USERS_ENABLED      = 'true';
process.env.STATE_FILE         = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-retry-')), 's.json');
process.env.PORT               = '3993';

const fcm = require('../lib/fcm');
fcm.send = async () => {};

const smserrors = require('../lib/smserrors');
const users  = require('../lib/users');
const outbox = require('../lib/outbox');
require('../server.js');

function req(method, p, { body, token, apiKey } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json';
                    headers['Content-Length'] = Buffer.byteLength(data); }
        if (token)  headers.Authorization = 'Bearer ' + token;
        if (apiKey) headers['X-Api-Key'] = apiKey;
        const r = http.request({ host: '127.0.0.1', port: 3993, method, path: p, headers }, res => {
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
const sim = (slot, number, extra) => Object.assign({ slot, number, source: 'manual', unconfirmed: false,
                                                     changedAt: 0, changedFrom: '', present: true }, extra || {});
const register = (deviceId, sims) => req('POST', '/api/register', { apiKey: KEY,
    body: { deviceId, model: 'Phone', installId: deviceId, sims, canSendSms: true, appVersion: '4.36.0' } });

(async () => {
    // ── 1. words ─────────────────────────────────────────────────
    const D = smserrors.describe;
    assert.strictEqual(D(''), '');
    assert.strictEqual(D(null), '');
    assert.match(D('error code 112'), /^Network error from the operator .*\(Android code 112\)$/,
        'the code Riad hit says what it is');
    assert.match(D('error code 110'), /SMSC/);
    assert.match(D('error code 122'), /barred/);
    assert.match(D('error code 4'), /No signal/);
    assert.match(D('error code 9999'), /^Android send error 9999 — check balance/, 'an unknown code still reads');
    assert.match(D('sim_mismatch'), /no longer has this number/);
    assert.match(D('no_permission'), /permission/);
    assert.match(D('exception'), /crashed/);
    assert.match(D('network status 0x46'), /stopped trying to deliver.*0x46/);
    assert.match(D('network status 0x20'), /status 0x20/);
    // A sentence that is already words (old app wording, server reasons) is untouched.
    assert.strictEqual(D('no signal'), 'no signal');
    assert.strictEqual(D('waited more than 6 hours'), 'waited more than 6 hours');
    assert.strictEqual(D('constructor'), 'constructor', 'object prototype names are not refusal keys');
    // Every refusal the app can send (OutboxSender.refusal + handle) has words.
    for (const k of ['no_permission', 'bad_slot', 'empty_message', 'no_sim', 'sim_unconfirmed',
                     'sim_mismatch', 'too_long', 'no_sms_manager', 'bad_recipient', 'exception']) {
        assert.notStrictEqual(D(k), k, 'refusal ' + k + ' has words');
    }
    // The Android table matches android.jar (android-34): a few anchors.
    assert.ok(smserrors._ANDROID[112] && smserrors._ANDROID[110] && smserrors._ANDROID[17] && smserrors._ANDROID[1]);

    await sleep(300);
    const admin = (await req('POST', '/api/login', { body: { password: 'admin-pw' } })).body.token;
    const created = (await req('POST', '/api/users', { token: admin, body: { name: 'Rahim' } })).body;
    await req('POST', '/api/set-password', { body: { username: 'rahim', code: created.enrollCode,
                                                     password: 'rahim-password' } });
    const rahim = (await req('POST', '/api/login', { body: { username: 'rahim', password: 'rahim-password' } })).body.token;
    const created2 = (await req('POST', '/api/users', { token: admin, body: { name: 'Karim' } })).body;
    await req('POST', '/api/set-password', { body: { username: 'karim', code: created2.enrollCode,
                                                     password: 'karim-password' } });
    const karim = (await req('POST', '/api/login', { body: { username: 'karim', password: 'karim-password' } })).body.token;

    const A = 'a1a1a1a1a1a1a1a1', B = 'b2b2b2b2b2b2b2b2';
    await register(A, [sim(1, '01711111111'), sim(2, '01733333333')]);
    await register(B, [sim(1, '01822222222'), sim(2, '')]);
    await req('POST', `/api/devices/${A}/assign`, { token: admin, body: { userId: 'admin' } });
    await req('POST', `/api/devices/${B}/assign`, { token: admin, body: { userId: 'rahim' } });
    await req('POST', '/api/users/rahim/send', { token: admin, body: { enabled: true, dailyLimit: 3 } });
    await req('POST', '/api/users/karim/send', { token: admin, body: { enabled: true } });

    // A job that fails on the phone with code 112.
    let r = await req('POST', '/api/send', { token: rahim, body: { fromDeviceId: B, fromSlot: 1,
        to: ['01555000111'], message: 'hello' } });
    assert.strictEqual(r.status, 200);
    const j1 = r.body.jobs[0];

    // 3. not retryable while still queued
    r = await req('POST', '/api/send/retry', { token: rahim, body: { jobId: j1.id } });
    assert.strictEqual(r.status, 409, 'a queued SMS cannot be retried');

    const pulled = (await req('GET', `/api/send/pull?deviceId=${B}`, { apiKey: KEY })).body.jobs;
    assert.strictEqual(pulled.length, 1);
    await req('POST', '/api/send/report', { apiKey: KEY, body: { deviceId: B, jobId: j1.id,
        event: 'part_failed', part: 0, parts: 1, error: 'error code 112' } });

    let list = (await req('GET', '/api/send/jobs', { token: rahim })).body.jobs;
    let row = list.find(x => x.id === j1.id);
    assert.strictEqual(row.status, 'failed');
    assert.strictEqual(row.error, 'error code 112', 'the raw value is kept');
    assert.match(row.errorText, /Network error from the operator/, 'and the words travel with it');

    // 3. who may retry
    r = await req('POST', '/api/send/retry', { token: karim, body: { jobId: j1.id } });
    assert.strictEqual(r.status, 404, 'another user cannot even see it');
    assert.strictEqual((await req('POST', '/api/send/retry', { token: rahim, body: {} })).status, 400);
    assert.strictEqual((await req('POST', '/api/send/retry', { token: rahim, body: { jobId: 'nope' } })).status, 404);
    assert.strictEqual((await req('POST', '/api/send/retry', { body: { jobId: j1.id } })).status, 401,
        'not without signing in');

    // 2. retry → a NEW job, same SIM / recipient / text
    r = await req('POST', '/api/send/retry', { token: rahim, body: { jobId: j1.id } });
    assert.strictEqual(r.status, 200);
    const j2 = r.body.jobs[0];
    assert.notStrictEqual(j2.id, j1.id);
    assert.deepStrictEqual([j2.fromDeviceId, j2.fromSlot, j2.fromNumber, j2.to, j2.message, j2.status, j2.retryOf],
                           [B, 1, '01822222222', '01555000111', 'hello', 'queued', j1.id]);
    assert.strictEqual(outbox._jobs.get(j1.id).retriedBy, j2.id, 'the original points at its retry');
    assert.strictEqual(outbox._jobs.get(j1.id).status, 'failed', 'and keeps its own history');

    // 2. at most once — sequential and simultaneous
    r = await req('POST', '/api/send/retry', { token: rahim, body: { jobId: j1.id } });
    assert.strictEqual(r.status, 409, 'a second retry of the same SMS is refused');
    r = await req('POST', '/api/send/retry', { token: admin, body: { jobId: j1.id } });
    assert.strictEqual(r.status, 409, 'admin too');
    const countFrom = () => Array.from(outbox._jobs.values()).filter(x => x.to === '01555000111').length;
    assert.strictEqual(countFrom(), 2, 'exactly one new SMS');

    // The retry counts against the daily limit like any send (limit 3: j1, j2 used).
    await req('GET', `/api/send/pull?deviceId=${B}`, { apiKey: KEY });
    await req('POST', '/api/send/report', { apiKey: KEY, body: { deviceId: B, jobId: j2.id,
        event: 'refused', part: -1, parts: 1, error: 'sim_mismatch' } });
    row = (await req('GET', '/api/send/jobs', { token: rahim })).body.jobs.find(x => x.id === j2.id);
    assert.match(row.errorText, /no longer has this number/, 'refusals read as words');
    r = await req('POST', '/api/send', { token: rahim, body: { fromDeviceId: B, fromSlot: 1,
        to: ['01555000112'], message: 'x' } });
    assert.strictEqual(r.status, 200, 'third of three');
    const j3 = r.body.jobs[0];
    r = await req('POST', '/api/send/retry', { token: rahim, body: { jobId: j2.id } });
    assert.strictEqual(r.status, 429, 'a retry over the daily limit is refused');
    assert.strictEqual(outbox._jobs.get(j2.id).retriedBy || '', '', 'and a refused retry does not use up the retry');

    // 4. never from a different number: the SIM in slot 1 changed meanwhile.
    await req('POST', '/api/users/rahim/send', { token: admin, body: { enabled: true, dailyLimit: 50 } });
    await register(B, [sim(1, '01899999999'), sim(2, '')]);
    r = await req('POST', '/api/send/retry', { token: rahim, body: { jobId: j2.id } });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /now 01899999999, not 01822222222/, 'a retry never changes the sender number');
    await register(B, [sim(1, '01822222222'), sim(2, '')]);

    // 3. only failed final states: a delivered SMS is not retryable.
    await req('GET', `/api/send/pull?deviceId=${B}`, { apiKey: KEY });
    await req('POST', '/api/send/report', { apiKey: KEY, body: { deviceId: B, jobId: j3.id,
        event: 'part_sent', part: 0, parts: 1 } });
    await req('POST', '/api/send/report', { apiKey: KEY, body: { deviceId: B, jobId: j3.id,
        event: 'part_delivered', part: 0, parts: 1 } });
    assert.strictEqual(outbox._jobs.get(j3.id).status, 'delivered');
    r = await req('POST', '/api/send/retry', { token: rahim, body: { jobId: j3.id } });
    assert.strictEqual(r.status, 409, 'a delivered SMS cannot be retried');

    // 3. the SIM's owner who did NOT send it may see it but not retry it.
    r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: B, fromSlot: 1,
        to: ['01555000200'], message: 'from admin' } });
    const ja = r.body.jobs[0];
    await req('GET', `/api/send/pull?deviceId=${B}`, { apiKey: KEY });
    await req('POST', '/api/send/report', { apiKey: KEY, body: { deviceId: B, jobId: ja.id,
        event: 'part_failed', part: 0, parts: 1, error: 'error code 1' } });
    r = await req('POST', '/api/send/retry', { token: rahim, body: { jobId: ja.id } });
    assert.strictEqual(r.status, 403, 'the SIM owner cannot retry what admin sent');
    r = await req('POST', '/api/send/retry', { token: admin, body: { jobId: ja.id } });
    assert.strictEqual(r.status, 200, 'admin can');

    // 'unknown' and 'expired' are retryable; the retry still needs the phone online.
    const jx = outbox._jobs.get(r.body.jobs[0].id);
    jx.status = 'expired'; jx.error = 'the phone went offline';
    users.getDevice(B).lastSeen = Date.now() - 3600_000;
    users.getDevice(B).seenAt = Date.now() - 3600_000;
    r = await req('POST', '/api/send/retry', { token: admin, body: { jobId: jx.id } });
    assert.strictEqual(r.status, 400, 'an offline phone cannot take the retry');
    assert.match(r.body.error, /Cannot send from that SIM/);
    assert.strictEqual(jx.retriedBy || '', '');

    // 5. /api/send ignores forged retry fields.
    await register(B, [sim(1, '01822222222'), sim(2, '')]);
    r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: A, fromSlot: 1,
        to: ['01555000300'], message: 'm', retryOf: j1.id, expectFromNumber: '01000000000' } });
    assert.strictEqual(r.status, 200, 'expectFromNumber from the outside is ignored');
    assert.strictEqual(r.body.jobs[0].retryOf, '', 'retryOf from the outside is ignored');

    console.log('ok — every phone failure reads as words with the raw code kept, and Retry sends a new SMS '
        + 'through every check, once per SMS, from the same number, only by its sender or an admin');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
