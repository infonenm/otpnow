/**
 * test/clear.test.js — server 4.41.3: deleting finished SMS from the outbox.
 *
 * What must hold:
 *   1. Cleared = gone: text and recipient are erased from memory AND from the
 *      Firestore document at once, and the SMS leaves every list.
 *   2. Clearing never hands back the daily limit or the phone's pacing window.
 *   3. Queued / sending SMS are never cleared. A user clears only what they
 *      sent; the admin anything.
 *   4. A late report for a cleared SMS is accepted and changes nothing; a
 *      cleared SMS cannot be retried.
 *   5. The leftover count record is deleted for good once nothing needs it,
 *      and a Firestore delete is never followed by a write of the same id.
 *
 * Run: node test/clear.test.js
 */
const assert = require('assert');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

process.env.DASHBOARD_PASSWORD = 'admin-pw';
process.env.API_KEY            = 'test-key';
process.env.USERS_ENABLED      = 'true';
process.env.STATE_FILE         = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-clear-')), 's.json');
process.env.PORT               = '3994';

const fcm = require('../lib/fcm');
fcm.send = async () => {};

const users     = require('../lib/users');
const outbox    = require('../lib/outbox');
const firestore = require('../lib/firestore');
require('../server.js');

function req(method, p, { body, token, apiKey } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json';
                    headers['Content-Length'] = Buffer.byteLength(data); }
        if (token)  headers.Authorization = 'Bearer ' + token;
        if (apiKey) headers['X-Api-Key'] = apiKey;
        const r = http.request({ host: '127.0.0.1', port: 3994, method, path: p, headers }, res => {
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
const sim = (slot, number) => ({ slot, number, source: 'manual', unconfirmed: false,
                                 changedAt: 0, changedFrom: '', present: true });
const register = (deviceId, sims) => req('POST', '/api/register', { apiKey: KEY,
    body: { deviceId, model: 'Phone', installId: deviceId, sims, canSendSms: true, appVersion: '4.36.0' } });

(async () => {
    await sleep(300);
    // Firestore, mocked: every write and delete in order.
    const ops = [];
    const docs = new Map();
    firestore.isEnabled = () => true;
    firestore.writeOutbox = async (c, list) => { for (const j of list) { docs.set(j.id, j); ops.push('w:' + j.id); } };
    firestore.deleteOutbox = async (c, ids) => { for (const id of ids) { docs.delete(id); ops.push('d:' + id); } };

    const admin = (await req('POST', '/api/login', { body: { password: 'admin-pw' } })).body.token;
    const created = (await req('POST', '/api/users', { token: admin, body: { name: 'Rahim' } })).body;
    await req('POST', '/api/set-password', { body: { username: 'rahim', code: created.enrollCode,
                                                     password: 'rahim-password' } });
    const rahim = (await req('POST', '/api/login', { body: { username: 'rahim', password: 'rahim-password' } })).body.token;

    const A = 'a1a1a1a1a1a1a1a1', B = 'b2b2b2b2b2b2b2b2';
    await register(A, [sim(1, '01711111111'), sim(2, '')]);
    await register(B, [sim(1, '01822222222'), sim(2, '')]);
    await req('POST', `/api/devices/${A}/assign`, { token: admin, body: { userId: 'admin' } });
    await req('POST', `/api/devices/${B}/assign`, { token: admin, body: { userId: 'rahim' } });
    await req('POST', '/api/users/rahim/send', { token: admin, body: { enabled: true, dailyLimit: 3 } });

    // Rahim sends two, both go out and fail; a third stays queued.
    let r = await req('POST', '/api/send', { token: rahim, body: { fromDeviceId: B, fromSlot: 1,
        to: ['01555000111', '01555000112'], message: 'secret text 4242' } });
    assert.strictEqual(r.status, 200);
    const [j1, j2] = r.body.jobs;
    await req('GET', `/api/send/pull?deviceId=${B}`, { apiKey: KEY });
    for (const j of [j1, j2]) {
        await req('POST', '/api/send/report', { apiKey: KEY, body: { deviceId: B, jobId: j.id,
            event: 'part_failed', part: 0, parts: 1, error: 'error code 112' } });
    }
    r = await req('POST', '/api/send', { token: rahim, body: { fromDeviceId: B, fromSlot: 1,
        to: ['01555000113'], message: 'still queued' } });
    const j3 = r.body.jobs[0];
    // And one from the admin, out of the same phone, delivered.
    r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: B, fromSlot: 1,
        to: ['01555000200'], message: 'admin text' } });
    const ja = r.body.jobs[0];
    outbox._jobs.get(ja.id).status = 'delivered';
    await outbox.flush();
    const usedBefore = outbox.usedToday('rahim');
    assert.strictEqual(usedBefore, 3);

    assert.strictEqual((await req('POST', '/api/send/clear', { token: rahim, body: {} })).status, 400,
        'nothing named, nothing cleared');
    assert.strictEqual((await req('POST', '/api/send/clear', { body: { all: true } })).status, 401);

    // 3. a user clears only their own, never a queued one
    r = await req('POST', '/api/send/clear', { token: rahim, body: { all: true } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.cleared, 2, 'the two finished ones — not the queued one, not the admin\'s');
    r = await req('POST', '/api/send/clear', { token: rahim, body: { jobIds: [ja.id] } });
    assert.strictEqual(r.body.cleared, 0, 'a user cannot delete what the admin sent');

    // 1. gone from every list, and the text is gone from memory and Firestore
    let list = (await req('GET', '/api/send/jobs', { token: rahim })).body.jobs.map(x => x.id);
    assert.deepStrictEqual(list.sort(), [j3.id, ja.id].sort(), 'only the queued one and the admin\'s remain');
    list = (await req('GET', '/api/send/jobs', { token: admin })).body.jobs.map(x => x.id);
    assert.ok(!list.includes(j1.id) && !list.includes(j2.id), 'gone for the admin too');
    const mem = outbox._jobs.get(j1.id);
    assert.ok(mem.deleted);
    for (const k of ['message', 'to', 'toLabel', 'fromNumber', 'error', 'createdByName', 'fromDeviceName']) {
        assert.strictEqual(mem[k], undefined, k + ' is erased in memory');
    }
    await outbox.flush();
    const doc = docs.get(j1.id);
    assert.ok(doc && doc.deleted, 'the Firestore document is overwritten');
    assert.ok(!JSON.stringify(doc).includes('secret text') && !JSON.stringify(doc).includes('01555000111'),
        'and holds neither the text nor the number');

    // 2. the daily limit and the pacing window are NOT handed back
    assert.strictEqual(outbox.usedToday('rahim'), usedBefore, 'clearing does not refund the daily limit');
    r = await req('POST', '/api/send', { token: rahim, body: { fromDeviceId: B, fromSlot: 1,
        to: ['01555000114'], message: 'x' } });
    assert.strictEqual(r.status, 429, 'still at the limit after clearing');
    const o = (await req('GET', '/api/send/jobs', { token: rahim })).body.quota;
    assert.strictEqual(o.usedToday, 3);

    // 4. late report: accepted, changes nothing, resurrects nothing
    r = await req('POST', '/api/send/report', { apiKey: KEY, body: { deviceId: B, jobId: j1.id,
        event: 'part_delivered', part: 0, parts: 1 } });
    assert.strictEqual(r.status, 200, 'the phone is told OK, so it stops retrying');
    assert.strictEqual(outbox._jobs.get(j1.id).status, 'failed');
    assert.strictEqual(outbox._jobs.get(j1.id).message, undefined);
    r = await req('POST', '/api/send/report', { apiKey: KEY, body: { deviceId: A, jobId: j1.id,
        event: 'part_delivered', part: 0, parts: 1 } });
    assert.strictEqual(r.status, 403, 'still only from the right phone');
    assert.strictEqual((await req('POST', '/api/send/retry', { token: rahim, body: { jobId: j1.id } })).status, 404,
        'a cleared SMS cannot be retried');

    // admin clears anything finished, including from a user's phone
    r = await req('POST', '/api/send/clear', { token: admin, body: { jobIds: [ja.id, j3.id] } });
    assert.strictEqual(r.body.cleared, 1, 'the delivered one; the queued one stays');
    assert.strictEqual(outbox._jobs.get(j3.id).status, 'queued');
    assert.ok(!outbox._jobs.get(j3.id).deleted);

    // 5. the count record goes for good once nothing needs it
    ops.length = 0;
    const now = Date.now();
    outbox.sweep(now);
    assert.ok(outbox._jobs.has(j1.id), 'kept while today still counts it');
    const tomorrow = outbox.dhakaDayStart(now) + 86_400_000 + 60_000;
    // Within the pacing window it must still stay, even on a new day.
    outbox._jobs.get(j1.id).dispatchedAt = tomorrow - 60_000;
    outbox.sweep(tomorrow);
    assert.ok(outbox._jobs.has(j1.id), 'kept while the phone\'s pacing window still counts it');
    outbox._jobs.get(j1.id).dispatchedAt = now;
    outbox.sweep(tomorrow);
    assert.ok(!outbox._jobs.has(j1.id) && !outbox._jobs.has(j2.id), 'yesterday\'s records leave memory');
    await outbox.flush();
    assert.ok(ops.includes('d:' + j1.id) && ops.includes('d:' + j2.id), 'and Firestore');
    assert.ok(!docs.has(j1.id), 'the document no longer exists');

    // A failed delete is retried, not lost.
    let fail = true;
    firestore.deleteOutbox = async (c, ids) => {
        if (fail) throw new Error('offline');
        for (const id of ids) { docs.delete(id); ops.push('d:' + id); }
    };
    r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: A, fromSlot: 1,
        to: ['01555000300'], message: 'to be cleared' } });
    const jf = r.body.jobs[0];
    outbox._jobs.get(jf.id).status = 'failed';
    await req('POST', '/api/send/clear', { token: admin, body: { jobIds: [jf.id] } });
    await outbox.flush();
    const jfMem = outbox._jobs.get(jf.id);
    jfMem.createdAt = now - 2 * 86_400_000; jfMem.dispatchedAt = 0;
    outbox.sweep(now);
    await outbox.flush();
    assert.ok(docs.has(jf.id), 'delete failed');
    assert.ok(outbox.stats().pendingSaves >= 1, 'and is still waiting');
    fail = false;
    await outbox.flush();
    assert.ok(!docs.has(jf.id), 'the retry deletes it');

    // ── review fixes (4.41.3) ────────────────────────────────────
    // (a) A failed write of a job that is cleared and swept meanwhile must not
    //     write its text back.
    let writeFails = true, failNow = null;
    firestore.writeOutbox = (c, list) => {
        // A SLOW failure: the write is still in flight while the SMS is
        // cleared and swept, and fails only afterwards.
        if (writeFails) return new Promise((res, rej) => { failNow = () => rej(new Error('offline')); });
        for (const j of list) { docs.set(j.id, j); ops.push('w:' + j.id); }
        return Promise.resolve();
    };
    r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: A, fromSlot: 1,
        to: ['01555000333'], message: 'secret P3' } });
    const jp = r.body.jobs[0];
    outbox._jobs.get(jp.id).status = 'failed';
    const inFlight = outbox.flush();                       // the full copy, failing
    await req('POST', '/api/send/clear', { token: admin, body: { jobIds: [jp.id] } });
    outbox._jobs.get(jp.id).createdAt = now - 2 * 86_400_000;
    outbox._jobs.get(jp.id).dispatchedAt = 0;
    outbox.sweep(now);                                     // leaves memory, delete queued
    assert.ok(!outbox._jobs.has(jp.id));
    failNow();
    await inFlight;
    writeFails = false;
    await outbox.flush();
    assert.ok(!docs.has(jp.id), 'not written back');
    assert.ok(!ops.some(o => o === 'w:' + jp.id), 'the stale full copy is never written after the clear');

    // (b) A job handed to the phone once, then re-queued and expired, may have
    //     gone out: it is 'unknown' (Retry warns), never a silent 'expired'.
    r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: B, fromSlot: 1,
        to: ['01555000444'], message: 'maybe sent' } });
    const jq = outbox._jobs.get(r.body.jobs[0].id);
    jq.status = 'queued'; jq.dispatchedAt = now - 40 * 60_000; jq.createdAt = now - 41 * 60_000; jq.requeued = 1;
    users.getDevice(B).lastSeen = now - 40 * 60_000;
    outbox.sweep(now);
    assert.strictEqual(jq.status, 'unknown', 'dispatched before → unknown, not expired');
    assert.match(jq.error, /reached the phone once/);
    users.getDevice(B).lastSeen = Date.now();

    // (c) An empty id list with all:true clears all; alone it is refused.
    assert.strictEqual((await req('POST', '/api/send/clear', { token: admin, body: { jobIds: [] } })).status, 400);
    r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: A, fromSlot: 1,
        to: ['01555000555'], message: 'x' } });
    outbox._jobs.get(r.body.jobs[0].id).status = 'delivered';
    r = await req('POST', '/api/send/clear', { token: admin, body: { all: true, jobIds: [] } });
    assert.ok(r.body.cleared >= 1, 'all:true with an empty list is still "all"');

    // (d) Firestore retention: documents older than the 3-day window go, hourly.
    const cut = [];
    firestore.deleteOutboxBefore = async (c, cutoff) => { cut.push(cutoff); return 0; };
    const t0 = Date.now() + 3 * 86_400_000;                // past every earlier sweep's hourly guard
    outbox.sweep(t0);
    await sleep(20);
    outbox.sweep(t0 + 60_000);
    assert.strictEqual(cut.length, 1, 'at most once an hour');
    assert.strictEqual(cut[0], t0 - 3 * 86_400_000, 'everything older than the 3 days nothing can show');

    // (e) Before the queue has loaded, retry and clear say so (503), not 404.
    const realRead = firestore.readOutboxSince;
    firestore.readOutboxSince = async () => ({ ok: false, jobs: [] });
    await outbox.load(99);
    assert.strictEqual((await req('POST', '/api/send/retry', { token: admin, body: { jobId: jq.id } })).status, 503);
    assert.strictEqual((await req('POST', '/api/send/clear', { token: admin, body: { all: true } })).status, 503);
    firestore.readOutboxSince = async () => ({ ok: true, jobs: [] });
    await outbox.load();
    firestore.readOutboxSince = realRead;

    console.log('ok — a cleared SMS loses its text and number everywhere at once, never refunds the daily limit '
        + 'or the pacing window, never touches queued SMS, ignores late reports, and its count record is '
        + 'deleted for good once nothing needs it');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
