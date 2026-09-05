/**
 * test/concurrency.test.js — many numbers at once, none of them waiting.
 *
 * =============================================================================
 * THE PROPERTY THIS FILE PINS
 *
 * The stated usage is: several DIFFERENT numbers fetched at the same time, and
 * the same number NOT fetched repeatedly at the same time. For that shape the
 * requirement is absolute — a request for number B must never be delayed, or
 * refused, because of anything happening on number A.
 *
 * Nothing in the design couples them: notifyWaiters() touches only
 * waiters.get(thatRecipient), and getOtp() is a Map lookup. The one thing that
 * DID couple them was the global waiter cap — a shared pool of 200, so number B
 * could be answered `busy` because of number A. That is now 1000 against a
 * per-number 5, so it cannot bind here.
 *
 * "Cannot bind" is an argument. This measures it instead: 120 distinct numbers
 * parked simultaneously through the real HTTP server, then 120 SMS delivered,
 * with every response timed. Latency is asserted, not assumed, because the
 * whole product is milliseconds.
 * =============================================================================
 *
 * Run: node test/concurrency.test.js
 */

const assert = require('assert');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

process.env.DASHBOARD_PASSWORD = 'admin-pw';
process.env.API_KEY            = 'test-key';
process.env.OTP_PATTERNS       = '(\\d{4,8})';
process.env.USERS_ENABLED      = 'false';
process.env.HISTORY_ENABLED    = 'false';
process.env.STATE_FILE         = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-c-')), 'state.json');
process.env.PORT               = '3952';

const store = require('../lib/store');
require('../server.js');

const BASE  = 'http://127.0.0.1:3952';
const AGENT = new http.Agent({ keepAlive: true, maxSockets: 512 });

function get(urlPath) {
    const t0 = process.hrtime.bigint();
    return new Promise((resolve, reject) => {
        const r = http.get(BASE + urlPath, { agent: AGENT }, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => resolve({
                body: JSON.parse(raw),
                ms: Number(process.hrtime.bigint() - t0) / 1e6
            }));
        });
        r.on('error', reject);
    });
}

function postSms(sender, recipient, message) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({ sender, recipient, message, arrivedAt: Date.now() });
        const r = http.request(BASE + '/sms', {
            method: 'POST', agent: AGENT,
            headers: { 'Content-Type': 'application/json',
                       'Content-Length': Buffer.byteLength(data),
                       'X-Api-Key': 'test-key' }
        }, res => { res.resume(); res.on('end', resolve); });
        r.on('error', reject);
        r.write(data); r.end();
    });
}

/** 01700000000 + n, kept 11 digits so canonicalizePhone leaves it alone. */
function num(n) { return '017' + String(10000000 + n); }

(async () => {
    await new Promise(r => setTimeout(r, 300));

    const N = 120;
    const limits = store.waiterLimits();

    // ── The caps must not be able to bind on distinct numbers ────────────────
    //
    // The real invariant is not "big enough for this test". It is that the
    // global ceiling divided by the per-number quota leaves room for every
    // number in the fleet to be at FULL quota at once — because only then is
    // "a request for a distinct number is never refused" a property of the
    // design rather than of the current load.
    //
    // 200 global / 20 per number was a ratio of 10: eleven busy numbers could
    // starve the twelfth. 1000 / 5 is 200, against a fleet of at most ~100 SIMs.
    const headroom = Math.floor(limits.global / limits.perNumber);
    assert.ok(headroom >= 100,
        `the caps must leave room for at least 100 distinct numbers at full `
        + `per-number quota; got ${limits.global}/${limits.perNumber} = ${headroom}. `
        + 'A low ratio makes the global pool shared, which is the one thing that '
        + 'lets one number refuse another.');
    assert.ok(limits.global >= N,
        `the global cap (${limits.global}) must not bind on ${N} distinct numbers`);
    assert.ok(limits.perNumber < limits.global,
        'the per-number cap must be the tight one, so the global one stays loose');

    // ── 120 distinct numbers park at the same instant ────────────────────────
    const pending = [];
    for (let i = 0; i < N; i++) pending.push(get(`/get?number=${num(i)}&wait=20`));

    // Let them all reach the server and park.
    await new Promise(r => setTimeout(r, 400));
    assert.strictEqual(store.waiterLimits().parked, N,
        'every one of them must actually be parked — a refused park resolves '
        + 'instantly and would make the timings below meaningless');

    // Not one of them may have been refused.
    for (let i = 0; i < N; i++) {
        assert.strictEqual(store.waitersFull(num(i)), false,
            `number ${num(i)} must still have room while ${N} others are parked`);
    }

    // ── Deliver one SMS per number, all at once ──────────────────────────────
    const t0 = Date.now();
    await Promise.all(Array.from({ length: N }, (_, i) =>
        postSms('IVAC', num(i), 'Your OTP is ' + String(100000 + i))));

    const answers = await Promise.all(pending);
    const wall = Date.now() - t0;

    // ── Every one answered, with its OWN code ────────────────────────────────
    for (let i = 0; i < N; i++) {
        assert.strictEqual(answers[i].body.success, true,
            `number ${num(i)} must have been served`);
        assert.strictEqual(answers[i].body.otp, String(100000 + i),
            `number ${num(i)} must get ITS OWN code, not another number's`);
        assert.ok(!answers[i].body.busy,
            `number ${num(i)} must never be told busy — no request for a distinct `
            + 'number may be refused because of another number');
    }

    // ── And answered on the connection that was already open ─────────────────
    //
    // The park itself took ~400ms of deliberate sleep above, so the number that
    // matters is the wall clock from "SMS posted" to "all 120 answered". A
    // long-poll that had degraded into a timeout would show up as seconds; one
    // that had serialised behind another number would grow with N.
    assert.ok(wall < 2000,
        `all ${N} numbers must be served together, not in sequence — took ${wall}ms`);

    console.log(`   ${N} numbers parked, all served in ${wall}ms wall clock`);

    // ── Nothing is left parked ───────────────────────────────────────────────
    assert.strictEqual(store.waiterLimits().parked, 0,
        'every waiter must be released once served — a leaked waiter is a slot '
        + 'that never comes back');

    // ── The per-number cap still contains a runaway loop ─────────────────────
    //
    // The point of making the global cap loose is that the per-number one is
    // tight. Check it still is, and that it does not touch anyone else.
    const HOT = num(500);
    const hot = [];
    for (let i = 0; i < limits.perNumber; i++) hot.push(get(`/get?number=${HOT}&wait=5`));
    await new Promise(r => setTimeout(r, 200));

    const over = await get(`/get?number=${HOT}&wait=5`);
    assert.strictEqual(over.body.busy, true,
        'the number over its own quota is told busy — and busy, not timedOut, '
        + 'because a zero-millisecond timeout reads as "nothing came" and is '
        + 'answered with an immediate retry');

    const bystander = await get(`/get?number=${num(501)}&wait=0`);
    assert.ok(!bystander.body.busy,
        'a different number must be unaffected while one number is at its quota');

    await Promise.all(hot);

    console.log('ok — 120 distinct numbers park and are served together with no '
        + 'contention, each gets its own code, and a number at its own quota is '
        + 'contained without touching anyone else');
    process.exit(0);
})().catch(e => {
    console.error(e);
    process.exit(1);
});
