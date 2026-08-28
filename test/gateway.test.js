/**
 * test/gateway.test.js — the /bkash, /rocket, /dgepayebl aliases.
 *
 * The Payment Auto Fill userscript calls these names. On this server they were
 * 404s, so the script got an HTML error page, JSON.parse threw, and it retried
 * twenty times over a minute before giving up silently. That looked exactly
 * like "the OTP never arrived".
 *
 * Run: node test/gateway.test.js
 */

const assert = require('assert');
const fs = require('fs');
const STATE = '/tmp/gw-state.json';
try { fs.unlinkSync(STATE); } catch (e) {}

Object.assign(process.env, {
    API_KEY: 'k', DASHBOARD_PASSWORD: 'p', PORT: '3992', STATE_FILE: STATE,
    // Scoped on purpose here, so the isolation guarantees are actually tested.
    GATEWAYS: JSON.stringify({ bkash: ['bkash'], rocket: ['rocket', '16216'], dgepayebl: [] })
});
delete process.env.GET_KEY;

const real = console.log; console.log = () => {};
require('../server.js');
console.log = real;

const B = 'http://127.0.0.1:3992';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = (p, o) => fetch(B + p, o).then(async r => ({ s: r.status, b: await r.json().catch(() => null) }));
const post = (sender, to, msg) => J('/sms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'k' },
    body: JSON.stringify({ sender, recipient: to, message: msg, arrivedAt: Date.now() })
});

const N = '01676109853';

(async () => {
    await sleep(400);

    // ── they exist and return JSON, which is the whole bug ───────
    for (const ep of ['bkash', 'rocket', 'dgepayebl']) {
        const r = await J(`/${ep}?number=${N}`);
        assert.strictEqual(r.s, 200, `/${ep} must not 404`);
        assert.ok(r.b && typeof r.b.success === 'boolean',
            `/${ep} must return JSON the script can parse, not an HTML error page`);
    }

    // ── a scoped alias answers only for its own sender ───────────
    await post('bKash', N, 'Your bKash OTP is 445566');
    assert.strictEqual((await J(`/rocket?number=${N}`)).b.success, false,
        'the rocket alias must not answer with a bKash OTP');
    assert.strictEqual((await J(`/bkash?number=${N}`)).b.otp, '445566',
        'the bkash alias must answer with it');
    assert.strictEqual((await J(`/bkash?number=${N}`)).b.success, false,
        'and it is spent, exactly as /get would be');

    // ── the critical isolation guarantee ─────────────────────────
    // A gateway polling the wrong OTP must not CONSUME it, or two scripts
    // polling the same SIM would eat each other's codes.
    await post('bKash', N, 'Your bKash OTP is 778899');
    for (let i = 0; i < 3; i++) await J(`/rocket?number=${N}`);   // wrong gateway, polling hard
    assert.strictEqual((await J(`/bkash?number=${N}`)).b.otp, '778899',
        'a mismatched gateway must never consume another gateway OTP');

    // sender token matching is loose enough for real sender IDs
    await post('16216', N, 'Rocket OTP 112233');
    assert.strictEqual((await J(`/rocket?number=${N}`)).b.otp, '112233',
        'a numeric short-code sender must match its token');

    // ── an UNSCOPED alias behaves exactly like /get ──────────────
    await post('EBL-3DS', N, 'Your card OTP is 909090');
    assert.strictEqual((await J(`/dgepayebl?number=${N}`)).b.otp, '909090',
        'an unscoped alias takes the latest OTP whoever sent it');

    // ── long-poll works on the aliases too ───────────────────────
    const parked = J(`/bkash?number=${N}&wait=10`);
    await sleep(150);
    const t0 = Date.now();
    await post('bKash', N, 'Your bKash OTP is 246810');
    const answer = await parked;
    assert.strictEqual(answer.b.otp, '246810', 'alias long-poll must deliver');
    assert.ok(Date.now() - t0 < 500, 'and deliver immediately, not on a timer');

    // ── the 880 form still resolves, as everywhere else ──────────
    await post('bKash', N, 'Your bKash OTP is 135791');
    // '+880' + the number without its leading zero — the form the phone reports.
    assert.strictEqual((await J('/bkash?number=%2B880' + N.slice(1)).then(r => r.b.otp)), '135791',
        'aliases must canonicalize the number like /get');

    console.log('ok — gateway aliases answer, stay in their lane, and long-poll');
    process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
