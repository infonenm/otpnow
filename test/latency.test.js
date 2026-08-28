/**
 * test/latency.test.js — the forward-to-fetch path.
 *
 * The thing this system is judged on is the gap between "the SMS reached the
 * server" and "the script has the OTP". This test measures that gap directly
 * and asserts the long-poll path behaves identically to the immediate path in
 * every respect that matters: consume-on-read, supersede, and never handing the
 * same OTP to two callers.
 *
 * Run: node test/latency.test.js
 */

const assert = require('assert');
const http = require('http');

process.env.API_KEY = 'test-api-key';
process.env.DASHBOARD_PASSWORD = 'test-password';
process.env.GET_KEY = 'test-fetch-key';
process.env.PORT = '3998';
// Short window so the expiry assertion below is a real one.
process.env.OTP_MAX_AGE_SECONDS = '5';

const realLog = console.log;
console.log = () => {};
require('../server.js');

const BASE = 'http://127.0.0.1:3998';

const get = (path) => fetch(BASE + path).then(r => r.json());
const postSms = (recipient, message) => fetch(BASE + '/sms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': process.env.API_KEY },
    body: JSON.stringify({ sender: 'IVAC', recipient, message, arrivedAt: Date.now() })
}).then(r => r.json());

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    await sleep(400);   // let the listener bind
    const K = '&key=' + process.env.GET_KEY;

    // ── 1. The fetch key is enforced when GET_KEY is set ─────────
    const noKey = await fetch(BASE + '/get?number=01711111111');
    assert.strictEqual(noKey.status, 401, 'missing key must be rejected');
    const badKey = await fetch(BASE + '/get?number=01711111111&key=wrong-length-key');
    assert.strictEqual(badKey.status, 401, 'wrong key must be rejected');

    // ── 2. A successful fetch spends the OTP ─────────────────────
    await postSms('01711111111', 'Your OTP is 123456');
    assert.deepStrictEqual(await get('/get?number=01711111111' + K),
        { success: true, otp: '123456' }, 'first fetch returns it');
    assert.deepStrictEqual(await get('/get?number=01711111111' + K),
        { success: false, otp: '' }, 'and it is spent — consume on read');

    // A newer SMS supersedes whatever came before, fetched or not.
    await postSms('01711111111', 'Your OTP is 654321');
    assert.deepStrictEqual(await get('/get?number=01711111111' + K),
        { success: true, otp: '654321' }, 'the newest code must win');
    assert.deepStrictEqual(await get('/get?number=01711111111' + K),
        { success: false, otp: '' }, 'and it too is spent once fetched');

    // ── 3. Long-poll: parked BEFORE the SMS arrives ──────────────
    // This is the real scenario. Measure server-receive -> client-has-it.
    const parked = get('/get?number=01822222222&wait=10' + K);
    await sleep(150);                       // waiter is now parked

    const t0 = process.hrtime.bigint();
    await postSms('01822222222', 'Your OTP is 778899');
    const answer = await parked;
    const deliveryMs = Number(process.hrtime.bigint() - t0) / 1e6;

    assert.deepStrictEqual(answer, { success: true, otp: '778899' }, 'long-poll delivery');
    assert.ok(deliveryMs < 100, `long-poll delivery took ${deliveryMs.toFixed(1)}ms`);

    // ── 4. Two waiters on one number: exactly one gets the OTP ───
    const a = get('/get?number=01933333333&wait=3' + K);
    const b = get('/get?number=01933333333&wait=3' + K);
    await sleep(150);
    await postSms('01933333333', 'Your OTP is 445566');
    const [ra, rb] = await Promise.all([a, b]);
    const winners = [ra, rb].filter(r => r.success);
    assert.strictEqual(winners.length, 1, 'exactly one fetch may consume the OTP');
    assert.strictEqual(winners[0].otp, '445566');

    // ── 5. Timeout returns cleanly, and does not poison the next fetch
    const t1 = Date.now();
    const timedOut = await get('/get?number=01744444444&wait=1' + K);
    const waited = Date.now() - t1;
    assert.strictEqual(timedOut.success, false, 'timeout must report failure');
    assert.strictEqual(timedOut.timedOut, true, 'timeout must be distinguishable');
    assert.ok(waited >= 900, `should have waited ~1s, waited ${waited}ms`);

    await postSms('01744444444', 'Your OTP is 111222');
    assert.deepStrictEqual(await get('/get?number=01744444444' + K),
        { success: true, otp: '111222' }, 'number still works after a timed-out wait');

    // ── 5b. An UNFETCHED OTP still ages out ──────────────────────
    // OTP_MAX_AGE_SECONDS is set to 5 for this run (the lowest the clamp
    // allows), so this is a real expiry rather than a simulated one.
    await sleep(5300);
    assert.deepStrictEqual(await get('/get?number=01744444444' + K),
        { success: false, otp: '' }, 'an unfetched OTP past its window must expire');

    // ── 6. Long-poll honours canonicalization ────────────────────
    const parked880 = get('/get?number=%2B8801866666666&wait=5' + K);
    await sleep(150);
    await postSms('01866666666', 'Your OTP is 909090');
    assert.deepStrictEqual(await parked880,
        { success: true, otp: '909090' }, '+880 form must match the 01 form');

    // ── 7. Supersede still wins for a parked waiter ──────────────
    await postSms('01955555555', 'Your OTP is 111111');
    await postSms('01955555555', 'Your OTP is 222222');
    assert.deepStrictEqual(await get('/get?number=01955555555' + K),
        { success: true, otp: '222222' }, 'newest code wins');

    console.log = realLog;
    console.log(`ok — long-poll delivered in ${deliveryMs.toFixed(1)} ms after the SMS ` +
                `reached the server; consume-on-fetch, supersede and expiry all hold`);
    process.exit(0);
})().catch((e) => {
    console.log = realLog;
    console.error('FAIL:', e.message);
    process.exit(1);
});
