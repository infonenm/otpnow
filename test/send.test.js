/**
 * test/send.test.js — server 4.41.0: sending real SMS from the dashboard.
 *
 * What must hold — each is a way a live system could hurt someone:
 *   1. An SMS from one of our own SIMs NEVER becomes or replaces an OTP
 *      (the collision guard), and /get keeps serving the real code.
 *   2. Users cannot send until the admin enables them; the daily limit holds;
 *      a user sends only from their own phones and sees only their own SIMs.
 *   3. Only an online phone, with a confirmed number, a SIM in the slot and
 *      SMS permission, can be chosen — the same check offered and enforced.
 *   4. A job is handed to a phone ONCE; a pull never repeats it; a phone that
 *      goes quiet makes it 'unknown', never re-queued (no double SMS).
 *   5. Phones are paced (DEVICE_WINDOW_MAX per window), one phone never
 *      holding up another.
 *   6. Reports are per part, idempotent, and only from the right phone.
 *   7. Length is counted exactly as the network does (GSM-7 / UCS-2, 3 parts).
 *   8. The queue survives a restart (Firestore), and a failed read never
 *      looks like an empty queue.
 *
 * Run: node test/send.test.js
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
process.env.STATE_FILE         = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-send-')), 's.json');
process.env.PORT               = '3992';

const fcm = require('../lib/fcm');
const pushes = [];
fcm.send = async (action, ts, topic) => { pushes.push({ action, topic }); };

const users  = require('../lib/users');
const store  = require('../lib/store');
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
        const r = http.request({ host: '127.0.0.1', port: 3992, method, path: p, headers }, res => {
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
const register = (deviceId, sims, extra) => req('POST', '/api/register', { apiKey: KEY,
    body: Object.assign({ deviceId, model: 'Phone', installId: deviceId, sims,
                          canSendSms: true, appVersion: '4.36.0' }, extra || {}) });

(async () => {
    // ── 7. length, first: it decides what is accepted at all ─────
    const P = outbox.smsParts;
    assert.strictEqual(P('').parts, 0);
    assert.deepStrictEqual([P('a'.repeat(160)).parts, P('a'.repeat(161)).parts,
                            P('a'.repeat(459)).parts, P('a'.repeat(460)).parts], [1, 2, 3, 4]);
    assert.strictEqual(P('a'.repeat(160)).encoding, 'gsm');
    assert.deepStrictEqual([P('€'.repeat(80)).parts, P('€'.repeat(81)).parts], [1, 2],
        'GSM extension characters cost two units');
    const bn = 'আ';
    assert.strictEqual(P(bn).encoding, 'ucs2');
    assert.deepStrictEqual([P(bn.repeat(70)).parts, P(bn.repeat(71)).parts,
                            P(bn.repeat(201)).parts, P(bn.repeat(202)).parts], [1, 2, 3, 4]);
    assert.strictEqual(P('Hello আমি').encoding, 'ucs2', 'one Bangla letter makes the whole SMS UCS-2');

    await sleep(300);
    const admin = (await req('POST', '/api/login', { body: { password: 'admin-pw' } })).body.token;

    // A user, enrolled and signed in.
    const created = (await req('POST', '/api/users', { token: admin, body: { name: 'Rahim' } })).body;
    await req('POST', '/api/set-password', { body: { username: 'rahim', code: created.enrollCode,
                                                     password: 'rahim-password' } });
    const rahim = (await req('POST', '/api/login', { body: { username: 'rahim', password: 'rahim-password' } })).body.token;
    assert.ok(rahim, 'user can sign in');

    const A = 'a1a1a1a1a1a1a1a1', B = 'b2b2b2b2b2b2b2b2', C = 'c3c3c3c3c3c3c3c3';
    await register(A, [sim(1, '01711111111'), sim(2, '01733333333')]);
    await register(B, [sim(1, '01822222222'), sim(2, '')]);
    await register(C, [sim(1, '01911111111', { unconfirmed: true, changedAt: Date.now() }), sim(2, '01922222222')],
                   { canSendSms: false });
    await req('POST', `/api/devices/${A}/assign`, { token: admin, body: { userId: 'admin' } });
    await req('POST', `/api/devices/${B}/assign`, { token: admin, body: { userId: 'rahim' } });
    await req('POST', `/api/devices/${C}/assign`, { token: admin, body: { userId: 'rahim' } });

    // ── 1. THE COLLISION GUARD ────────────────────────────────────
    // A real OTP is live on 01822222222. Then our own SIM 01711111111 texts
    // that number something full of digits. The OTP must survive.
    await req('POST', '/sms', { apiKey: KEY, body: { sender: 'IVAC_BD', recipient: '01822222222',
        message: 'Your OTP is 445566', deviceId: B } });
    await req('POST', '/sms', { apiKey: KEY, body: { sender: '+8801711111111', recipient: '01822222222',
        message: 'Payment 778899 received, ref 123456', deviceId: B } });
    const internalMsg = store.getAllSms().find(m => m.sender === '+8801711111111');
    assert.strictEqual(internalMsg.status, 'internal', 'stored as internal');
    assert.strictEqual(internalMsg.code, '', 'and no code is extracted from it');
    let g = await req('GET', '/get?number=01822222222');
    assert.strictEqual(g.body.otp, '445566', 'the live OTP was NOT superseded by our own SMS');

    // Internal with nothing else live: still never served.
    await req('POST', '/sms', { apiKey: KEY, body: { sender: '01733333333', recipient: '01922222222',
        message: 'Code 112233', deviceId: C } });
    g = await req('GET', '/get?number=01922222222');
    assert.strictEqual(g.body.otp, '', 'an internal SMS is never served as an OTP');
    // The sweep leaves it alone (only 'pending' is finished).
    store._finalizeExpired(Date.now() + 10 * 60_000);
    assert.strictEqual(store.getAllSms().find(m => m.sender === '01733333333').status, 'internal');
    // An ordinary number is untouched by the guard.
    await req('POST', '/sms', { apiKey: KEY, body: { sender: '+8801555000111', recipient: '01922222222',
        message: 'Your code is 654321', deviceId: C } });
    g = await req('GET', '/get?number=01922222222');
    assert.strictEqual(g.body.otp, '654321', 'a stranger\'s number still yields an OTP');

    // ── 2./3. options are scoped and the checks are the real ones ─
    let o = (await req('GET', '/api/send/options', { token: admin })).body;
    const pick = (list, dev, slot) => list.find(s => s.deviceId === dev && s.slot === slot);
    assert.strictEqual(pick(o.senders, A, 1).ok, true);
    assert.strictEqual(pick(o.senders, B, 2).ok, false);
    assert.match(pick(o.senders, B, 2).reason, /No number/);
    assert.match(pick(o.senders, C, 1).reason, /SIM card changed/);
    assert.match(pick(o.senders, C, 2).reason, /permission/);
    assert.strictEqual(o.quota.dailyLimit, null, 'admin has no daily limit');
    assert.ok(o.directory.some(u => u.userId === 'rahim'), 'admin sees every user in the directory');

    let ro = (await req('GET', '/api/send/options', { token: rahim })).body;
    assert.ok(ro.senders.every(s => s.deviceId !== A), 'a user is offered only their own phones');
    assert.deepStrictEqual(ro.directory.map(u => u.userId), ['rahim'], 'and sees only their own SIMs');
    assert.strictEqual(ro.quota.canSend, false, 'sending is OFF for a user by default');

    // ── 2. permission and limit ───────────────────────────────────
    let r = await req('POST', '/api/send', { token: rahim, body: { fromDeviceId: B, fromSlot: 1,
        to: ['01555000111'], message: 'hi' } });
    assert.strictEqual(r.status, 403, 'a user cannot send until enabled');
    assert.strictEqual((await req('POST', '/api/users/rahim/send', { token: rahim,
        body: { enabled: true } })).status, 403, 'only admin can enable');
    r = await req('POST', '/api/users/rahim/send', { token: admin, body: { enabled: true, dailyLimit: 2 } });
    assert.strictEqual(r.body.user.sendEnabled, true);
    assert.strictEqual(r.body.user.sendDailyLimit, 2);
    assert.strictEqual((await req('POST', '/api/users/rahim/send', { token: admin,
        body: { dailyLimit: 0 } })).status, 400, 'a zero limit is refused, not stored');

    r = await req('POST', '/api/send', { token: rahim, body: { fromDeviceId: A, fromSlot: 1,
        to: ['01555000111'], message: 'hi' } });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /Not your phone/, 'a user cannot send from someone else\'s SIM');

    r = await req('POST', '/api/send', { token: rahim, body: { fromDeviceId: B, fromSlot: 1,
        to: ['01555000111', '01555000112', '01555000113'], message: 'hi' } });
    assert.strictEqual(r.status, 429, 'over the daily limit');
    r = await req('POST', '/api/send', { token: rahim, body: { fromDeviceId: B, fromSlot: 1,
        to: ['01555000111', '+8801555000112'], message: 'hi' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.jobs.length, 2);
    const rahimBatch = r.body.batchId;
    assert.ok(pushes.some(p => p.action === 'send_sms' && p.topic === 'device_' + B),
        'exactly that phone is signalled');
    r = await req('POST', '/api/send', { token: rahim, body: { fromDeviceId: B, fromSlot: 1,
        to: ['01555000114'], message: 'hi' } });
    assert.strictEqual(r.status, 429, 'the limit counts what was already sent today');
    // Cancelling a queued one refunds it.
    r = await req('POST', '/api/send/cancel', { token: rahim, body: { batchId: rahimBatch } });
    assert.strictEqual(r.body.cancelled, 2);
    r = await req('POST', '/api/send', { token: rahim, body: { fromDeviceId: B, fromSlot: 1,
        to: ['01555000114'], message: 'hi' } });
    assert.strictEqual(r.status, 200, 'cancelled SMS do not count against the limit');

    // ── validation ────────────────────────────────────────────────
    r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: A, fromSlot: 1,
        to: ['12345', '01711111111x'], message: 'hi' } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.problems.length, 2, 'every bad number is named');
    r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: A, fromSlot: 1,
        to: ['01555000111'], message: 'a'.repeat(460) } });
    assert.strictEqual(r.status, 400, 'four parts is too long');
    r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: A, fromSlot: 1,
        to: ['01555000111'], message: '   ' } });
    assert.strictEqual(r.status, 400, 'an empty message is refused');
    r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: A, fromSlot: 1,
        to: ['01711111111', '01555000200', '01555000200'], message: 'x' } });
    assert.strictEqual(r.body.jobs.length, 1, 'duplicates collapse and the sending SIM is left out');
    assert.strictEqual(r.body.skipped[0].number, '01711111111');
    r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: C, fromSlot: 1,
        to: ['01555000111'], message: 'x' } });
    assert.match(r.body.error, /SIM card changed/, 'an unconfirmed SIM cannot send');

    // Offline phone.
    users.getDevice(B).lastSeen = Date.now() - 10 * 60_000;
    r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: B, fromSlot: 1,
        to: ['01555000111'], message: 'x' } });
    assert.match(r.body.error, /offline/, 'an offline phone cannot be chosen');
    users.getDevice(B).lastSeen = Date.now();

    // ── 4./6. pull once, report per part ──────────────────────────
    r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: A, fromSlot: 2,
        to: ['01555000300'], message: 'b'.repeat(200) } });
    const twoPart = r.body.jobs[0];
    assert.strictEqual(twoPart.parts, 2);
    let s = await req('GET', `/api/settings?deviceId=${A}`, { apiKey: KEY });
    assert.ok(s.body.sendDue >= 1, 'the poll tells the phone there is work');
    let pulled = (await req('GET', `/api/send/pull?deviceId=${A}`, { apiKey: KEY })).body.jobs;
    const mine = pulled.find(j => j.id === twoPart.id);
    assert.ok(mine, 'the phone gets its job');
    assert.strictEqual(mine.slot, 2);
    assert.strictEqual(mine.fromNumber, '01733333333', 'with the number it must send from');
    const again = (await req('GET', `/api/send/pull?deviceId=${A}`, { apiKey: KEY })).body.jobs;
    assert.ok(!again.some(j => j.id === twoPart.id), 'a job is never handed out twice');
    assert.strictEqual((await req('GET', `/api/send/pull?deviceId=${A}`)).status, 401, 'pull needs the key');

    const rep = (deviceId, body) => req('POST', '/api/send/report', { apiKey: KEY,
        body: Object.assign({ deviceId, jobId: twoPart.id, parts: 2 }, body) });
    assert.strictEqual((await rep(B, { event: 'part_sent', part: 0 })).status, 403,
        'another phone cannot report on this job');
    await rep(A, { event: 'sending' });
    r = await rep(A, { event: 'part_sent', part: 0 });
    assert.strictEqual(r.body.status, 'sending');
    await rep(A, { event: 'part_sent', part: 0 });                 // duplicate
    r = await rep(A, { event: 'part_sent', part: 1 });
    assert.strictEqual(r.body.status, 'sent', 'sent once every part is out');
    r = await rep(A, { event: 'part_delivered', part: 0 });
    assert.strictEqual(r.body.status, 'sent');
    r = await rep(A, { event: 'part_delivered', part: 1 });
    assert.strictEqual(r.body.status, 'delivered');
    r = await rep(A, { event: 'part_failed', part: 1 });
    assert.strictEqual(r.body.status, 'delivered', 'a finished job is not reopened');
    assert.strictEqual((await rep(A, { event: 'bogus' })).status, 400);

    // A refusal.
    r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: A, fromSlot: 1,
        to: ['01555000301'], message: 'x' } });
    const refused = r.body.jobs[0];
    await req('GET', `/api/send/pull?deviceId=${A}`, { apiKey: KEY });
    r = await req('POST', '/api/send/report', { apiKey: KEY, body: { deviceId: A, jobId: refused.id,
        event: 'refused', error: 'sim_mismatch' } });
    assert.strictEqual(r.body.status, 'failed');
    // A dispatched job cannot be cancelled.
    r = await req('POST', '/api/send/cancel', { token: admin, body: { jobId: refused.id } });
    assert.strictEqual(r.body.cancelled, 0);

    // ── 4. a quiet phone makes it 'unknown', never re-queued ──────
    r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: A, fromSlot: 1,
        to: ['01555000302'], message: 'x' } });
    const quiet = r.body.jobs[0];
    await req('GET', `/api/send/pull?deviceId=${A}`, { apiKey: KEY });
    // Review #7: nothing heard at all → the pull reply was probably lost →
    // re-queued ONCE.
    outbox.sweep(Date.now() + 4 * 60_000);
    assert.strictEqual(outbox._jobs.get(quiet.id).status, 'queued', 'an unacknowledged pull is re-queued once');
    let again2 = (await req('GET', `/api/send/pull?deviceId=${A}`, { apiKey: KEY })).body.jobs;
    assert.ok(again2.some(j => j.id === quiet.id), 'and handed out again');
    outbox.sweep(Date.now() + 4 * 60_000);
    assert.strictEqual(outbox._jobs.get(quiet.id).status, 'dispatched', 'but only once');
    // The phone says it already had it: it is not sent again, and no longer waits.
    r = await req('POST', '/api/send/report', { apiKey: KEY, body: { deviceId: A, jobId: quiet.id,
        event: 'already_handled' } });
    assert.strictEqual(r.body.status, 'sending');
    outbox.sweep(Date.now() + outbox.DISPATCH_TIMEOUT_MS + 1000);
    assert.strictEqual(outbox._jobs.get(quiet.id).status, 'unknown');
    const pulledAfter = (await req('GET', `/api/send/pull?deviceId=${A}`, { apiKey: KEY })).body.jobs;
    assert.ok(!pulledAfter.some(j => j.id === quiet.id), 'an unknown job is never sent again');
    // A late report still lands.
    r = await req('POST', '/api/send/report', { apiKey: KEY, body: { deviceId: A, jobId: quiet.id,
        event: 'part_sent', part: 0, parts: 1 } });
    assert.strictEqual(r.body.status, 'sent', 'a late "sent" corrects unknown');
    // A refusal arriving after "unknown" is proof nothing was sent (review #8).
    r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: A, fromSlot: 1,
        to: ['01555000303'], message: 'x' } });
    const lateRefused = r.body.jobs[0];
    await req('GET', `/api/send/pull?deviceId=${A}`, { apiKey: KEY });
    outbox._jobs.get(lateRefused.id).acked = true;              // heard something
    outbox.sweep(Date.now() + outbox.DISPATCH_TIMEOUT_MS + 1000);
    r = await req('POST', '/api/send/report', { apiKey: KEY, body: { deviceId: A, jobId: lateRefused.id,
        event: 'refused', error: 'no_sim' } });
    assert.strictEqual(r.body.status, 'failed', 'refused after unknown becomes failed');
    // Late reports of a job re-queued meanwhile take it OUT of the queue.
    r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: A, fromSlot: 1,
        to: ['01555000304'], message: 'x' } });
    const lateJob = r.body.jobs[0];
    await req('GET', `/api/send/pull?deviceId=${A}`, { apiKey: KEY });
    outbox.sweep(Date.now() + 4 * 60_000);
    assert.strictEqual(outbox._jobs.get(lateJob.id).status, 'queued');
    r = await req('POST', '/api/send/report', { apiKey: KEY, body: { deviceId: A, jobId: lateJob.id,
        event: 'part_sent', part: 0, parts: 1 } });
    assert.strictEqual(r.body.status, 'sent', 'a late report on a re-queued job settles it');
    assert.ok(!(await req('GET', `/api/send/pull?deviceId=${A}`, { apiKey: KEY })).body.jobs
        .some(j => j.id === lateJob.id), 'and it is not handed out again');

    // ── 5. pacing, per phone ──────────────────────────────────────
    const many = Array.from({ length: 30 }, (_, i) => '0155510' + String(1000 + i));
    await req('POST', '/api/send', { token: admin, body: { fromDeviceId: A, fromSlot: 1, to: many, message: 'bulk' } });
    let total = 0;
    for (let i = 0; i < 6; i++) {
        total += (await req('GET', `/api/send/pull?deviceId=${A}`, { apiKey: KEY })).body.jobs.length;
    }
    const inWindow = Array.from(outbox._jobs.values())
        .filter(j => j.fromDeviceId === A && j.dispatchedAt && Date.now() - j.dispatchedAt < outbox.DEVICE_WINDOW_MS)
        .reduce((n, j) => n + (j.parts || 1), 0);
    assert.ok(inWindow <= outbox.DEVICE_WINDOW_MAX && inWindow >= outbox.DEVICE_WINDOW_MAX - 1,
        'a phone is handed at most the window budget, counted in SMS PARTS (review #5): ' + inWindow);
    assert.ok(total > 0 && total <= outbox.DEVICE_WINDOW_MAX);
    s = await req('GET', `/api/settings?deviceId=${A}`, { apiKey: KEY });
    assert.strictEqual(s.body.sendDue, undefined, 'nothing due while the window is full');
    // Another phone is not held up by A's queue.
    r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: B, fromSlot: 1,
        to: ['01555000400'], message: 'x' } });
    const bJobs = (await req('GET', `/api/send/pull?deviceId=${B}`, { apiKey: KEY })).body.jobs;
    assert.ok(bJobs.some(j => j.id === r.body.jobs[0].id), 'phone B pulls while A is paced');

    // ── internal SMS confirms receipt of a job we sent ────────────
    r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: B, fromSlot: 1,
        to: ['01733333333'], message: 'Hello from B' } });
    const toOurSim = r.body.jobs[0];
    await req('GET', `/api/send/pull?deviceId=${B}`, { apiKey: KEY });
    await req('POST', '/sms', { apiKey: KEY, body: { sender: '+8801822222222', recipient: '01733333333',
        message: 'Hello from B', deviceId: A } });
    assert.strictEqual(outbox._jobs.get(toOurSim.id).status, 'delivered',
        'arriving on our other phone confirms delivery');
    assert.ok(outbox._jobs.get(toOurSim.id).receivedAt > 0);

    // ── visibility ────────────────────────────────────────────────
    const rj = (await req('GET', '/api/send/jobs', { token: rahim })).body.jobs;
    assert.ok(rj.every(j => j.createdBy === 'rahim' || j.fromOwner === 'rahim'),
        'a user sees only what they sent and what was sent from their SIMs');
    assert.ok(rj.some(j => j.createdBy === 'admin' && j.fromOwner === 'rahim'),
        'including the admin\'s use of their SIM');
    assert.ok(!rj.some(j => j.fromDeviceId === A), 'never the admin\'s own sends');

    // ── a removed phone gets nothing and its queue expires ────────
    const D = 'd4d4d4d4d4d4d4d4';
    await register(D, [sim(1, '01600000001'), sim(2, '')]);
    r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: D, fromSlot: 1,
        to: ['01555000500'], message: 'x' } });
    const dJob = r.body.jobs[0];
    users.removeDevice(D);
    const dp = (await req('GET', `/api/send/pull?deviceId=${D}`, { apiKey: KEY })).body;
    assert.strictEqual(dp.revoked, true);
    assert.strictEqual(dp.jobs.length, 0);
    outbox.sweep();
    assert.strictEqual(outbox._jobs.get(dJob.id).status, 'expired');

    // ── review #1: a queued job is re-checked when collected ───────
    users.getDevice(B).lastSeen = Date.now();
    r = await req('POST', '/api/users/rahim/send', { token: admin, body: { enabled: true, dailyLimit: 50 } });
    r = await req('POST', '/api/send', { token: rahim, body: { fromDeviceId: B, fromSlot: 1,
        to: ['01555000700', '01555000701'], message: 'queued then revoked' } });
    const revokedJobs = r.body.jobs.map(j => j.id);
    await req('POST', '/api/users/rahim/send', { token: admin, body: { enabled: false } });
    for (const id of revokedJobs) {
        assert.strictEqual(outbox._jobs.get(id).status, 'expired', 'switching a user off expires their queue at once');
        assert.match(outbox._jobs.get(id).error, /switched off/);
    }
    await req('POST', '/api/users/rahim/send', { token: admin, body: { enabled: true } });
    r = await req('POST', '/api/send', { token: rahim, body: { fromDeviceId: B, fromSlot: 1,
        to: ['01555000702'], message: 'queued then reassigned' } });
    const reassigned = r.body.jobs[0].id;
    await req('POST', `/api/devices/${B}/assign`, { token: admin, body: { userId: 'admin' } });
    assert.strictEqual(outbox._jobs.get(reassigned).status, 'expired', 'a reassigned phone does not send the old owner\'s queue');
    assert.ok(!(await req('GET', `/api/send/pull?deviceId=${B}`, { apiKey: KEY })).body.jobs
        .some(j => j.id === reassigned));
    await req('POST', `/api/devices/${B}/assign`, { token: admin, body: { userId: 'rahim' } });
    // Expired-before-dispatch is refunded: it never cost anything.
    const usedNow = outbox.usedToday('rahim');
    assert.ok(usedNow < 10, 'expired-unsent jobs are not counted: ' + usedNow);

    // ── review #5: the daily limit counts billed SMS parts ────────
    await req('POST', '/api/users/rahim/send', { token: admin, body: { dailyLimit: usedNow + 3 } });
    r = await req('POST', '/api/send', { token: rahim, body: { fromDeviceId: B, fromSlot: 1,
        to: ['01555000710', '01555000711'], message: 'c'.repeat(200) } });
    assert.strictEqual(r.status, 429, 'two 2-part SMS need 4 of the 3 left');
    assert.match(r.body.error, /needs 4/);
    r = await req('POST', '/api/send', { token: rahim, body: { fromDeviceId: B, fromSlot: 1,
        to: ['01555000710'], message: 'c'.repeat(200) } });
    assert.strictEqual(r.status, 200, 'one 2-part SMS fits');
    await req('POST', '/api/users/rahim/send', { token: admin, body: { dailyLimit: 2 } });

    // ── review #8: a recipient label is scoped to who reads it ────
    r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: B, fromSlot: 1,
        to: ['01711111111'], message: 'to the admin phone' } });
    const labelled = r.body.jobs[0];
    assert.ok(labelled.toLabel.includes('Galaxy') || labelled.toLabel.includes('Phone'), 'the admin sees the label');
    const asRahim = (await req('GET', '/api/send/jobs', { token: rahim })).body.jobs.find(j => j.id === labelled.id);
    assert.strictEqual(asRahim.toLabel, '', 'the SIM owner does not see another user\'s phone name');

    // ── review #6: only an OWNED phone's numbers count as ours ────
    const E = 'e5e5e5e5e5e5e5e5';
    await register(E, [sim(1, '01300000001'), sim(2, '')], { installId: 'eeeeeeeeeeeeeeee' });
    await req('POST', '/sms', { apiKey: KEY, body: { sender: '01300000001', recipient: '01555000999',
        message: 'Your code is 135790', deviceId: A } });
    let fromE = store.getAllSms().find(m => m.sender === '01300000001');
    assert.strictEqual(fromE.status, 'pending', 'an unowned phone cannot make a sender "ours"');
    // Once it IS ours, anything still pending from it is reclassified.
    await req('POST', `/api/devices/${E}/assign`, { token: admin, body: { userId: 'rahim' } });
    store._reclassifyInternal();
    fromE = store.getAllSms().find(m => m.sender === '01300000001');
    assert.strictEqual(fromE.status, 'internal', 'pending messages are re-checked when ownership changes');
    assert.strictEqual((await req('GET', '/get?number=01555000999')).body.otp, '',
        'and can no longer be served');

    // ── review #3: nothing is accepted before the queue has loaded ─
    const firestoreMod = require('../lib/firestore');
    const realEnabled = firestoreMod.isEnabled, realRead = firestoreMod.readOutboxSince;
    firestoreMod.isEnabled = () => true;
    firestoreMod.readOutboxSince = async () => ({ ok: false, jobs: [] });
    await outbox.load(99);
    r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: A, fromSlot: 1,
        to: ['01555000800'], message: 'too early' } });
    assert.strictEqual(r.status, 503, 'no send is accepted while the queue is unloaded');
    assert.deepStrictEqual((await req('GET', `/api/send/pull?deviceId=${A}`, { apiKey: KEY })).body.jobs, [],
        'and no job is handed out');
    firestoreMod.readOutboxSince = async () => ({ ok: true, jobs: [] });
    await outbox.load();
    firestoreMod.isEnabled = realEnabled; firestoreMod.readOutboxSince = realRead;

    // ── the permission itself survives a restart ──────────────────
    const snapU = users.snapshot().users.find(u => u.id === 'rahim');
    assert.strictEqual(snapU.sendEnabled, true);
    assert.strictEqual(snapU.sendDailyLimit, 2);
    const reloaded = JSON.parse(JSON.stringify(users.snapshot()));
    delete reloaded.users.find(u => u.id === 'rahim').sendEnabled;     // a pre-4.41 record
    users.load(reloaded);
    assert.strictEqual(users.sendPolicy('rahim').enabled, false, 'a record from before 4.41 stays OFF');
    users.load(JSON.parse(JSON.stringify(Object.assign(users.snapshot(), {
        users: users.snapshot().users.map(u => u.id === 'rahim' ? Object.assign(u, { sendEnabled: true }) : u) }))));

    // ── 8. persistence ────────────────────────────────────────────
    const firestore = require('../lib/firestore');
    const saved = new Map();
    let failRead = false;
    firestore.isEnabled = () => true;
    firestore.writeOutbox = async (c, list) => { for (const j of list) saved.set(j.id, j); };
    firestore.readOutboxSince = async () => failRead ? { ok: false, jobs: [] }
        : { ok: true, jobs: Array.from(saved.values()) };
    r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: A, fromSlot: 1,
        to: ['01555000600'], message: 'persist me' } });
    const pj = r.body.jobs[0];
    await outbox.flush();
    assert.strictEqual(saved.get(pj.id).status, 'queued', 'a new job is saved');
    // Review #2: a change made WHILE a write is in flight must not be stranded.
    // Exactly the shutdown case: ONE flush() call, made while a slow write is
    // running, has to cover what changed during that write as well.
    let release;
    firestore.writeOutbox = (c, list) => new Promise(res => { release = () => {
        for (const j of list) saved.set(j.id, j); res(); }; });
    outbox.cancel({ role: 'admin', userId: 'admin' }, { jobId: pj.id });   // something to write
    const first = outbox.flush();                                           // write #1, slow
    await sleep(10);
    r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: A, fromSlot: 1,
        to: ['01555000601'], message: 'made mid-write' } });
    const mid = r.body.jobs[0];
    const atShutdown = outbox.flush();                                      // called mid-write
    firestore.writeOutbox = async (c, list) => { for (const j of list) saved.set(j.id, j); };
    release();
    await first;
    await atShutdown;
    assert.ok(saved.has(mid.id), 'a flush made during a slow write also writes what changed meanwhile');
    assert.strictEqual(outbox.stats().pendingSaves, 0, 'nothing left unsaved');
    // "Restart": empty memory, then load.
    const snapshot = Array.from(outbox._jobs.values());
    outbox._jobs.clear();
    failRead = true;
    await outbox.load(99);
    assert.strictEqual(outbox._jobs.size, 0, 'a failed read loads nothing (and retries)');
    failRead = false;
    await outbox.load();
    assert.strictEqual(outbox._jobs.get(mid.id).status, 'queued', 'the queue survives a restart');
    assert.strictEqual(outbox._jobs.get(pj.id).status, 'cancelled', 'with each job as it was last saved');
    for (const j of snapshot) if (!outbox._jobs.has(j.id)) outbox._jobs.set(j.id, j);

    console.log('ok — our own SMS never touches an OTP, sending is off until enabled and capped per day, '
        + 'only a ready SIM can send, each job reaches its phone once and is never re-sent, phones are paced '
        + 'independently, reports are per part and idempotent, and the queue survives a restart');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
