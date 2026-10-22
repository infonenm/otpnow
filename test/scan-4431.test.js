/**
 * test/scan-4431.test.js — server 4.43.1: the full-package scan, server core.
 *
 * Each case was reproduced by an independent reviewer and fails without its fix.
 *   1. Two stale replays from one phone: /get serves the one the PHONE got last
 *      (Get Latest pressed twice; reversed or same-millisecond delivery).
 *   2. A words-only capture must be ONE clear spelled code — greedy captures
 *      picked up "one minute", "One time", "Ninety"; no code above 10 digits.
 *   3. A taught pattern never starts inside a run (unanchored: "One_…_Nine"
 *      read 23456789).
 *   4. A stalled dashboard stream is dropped, not buffered without limit.
 *   5. A message with no code is not archived as "superseded".
 *   6. A phone clock that ran ahead and was corrected does not block the next OTP.
 *   7. Oversized SMS bodies are cut at the boundary.
 *
 * Run: node test/scan-4431.test.js
 */
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

process.env.STATE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-scan4431-')), 's.json');
const quiet = () => {};
const realLog = console.log, realWarn = console.warn;
console.log = quiet; console.warn = quiet;

const history = require('../lib/history');
const recorded = [];
history.record = (sms, outcome) => { recorded.push([sms.message, outcome]); };
const store = require('../lib/store');
const otp   = require('../lib/otp');
const teach = require('../lib/teach');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    // ── 1. stale replays ─────────────────────────────────────────
    const now = Date.now();
    store.addSms('IVAC', '01711111111', 'Your OTP is 222222', now - 140_000, 'devA', 'a2');
    store.addSms('IVAC', '01711111111', 'Your OTP is 111111', now - 200_000, 'devA', 'a1');
    assert.strictEqual(store.getOtp('01711111111'), '222222', 'reversed delivery: the newer code on the phone');

    store.addSms('IVAC', '01722222222', 'Your OTP is 111111', now - 200_000, 'devB', 'b1');
    store.addSms('IVAC', '01722222222', 'Your OTP is 222222', now - 140_000, 'devB', 'b2');
    assert.strictEqual(store.getOtp('01722222222'), '222222', 'in-order delivery, same millisecond');

    store.addSms('IVAC', '01733333333', 'Your OTP is 222222', Date.now() - 150_000, 'devC', 'c2');
    await sleep(300);
    store.addSms('IVAC', '01733333333', 'Your OTP is 111111', Date.now() - 400_000, 'devC', 'c1');
    assert.strictEqual(store.getOtp('01733333333'), '222222', 'Get Latest x2: newest missed OTP, not the older');
    assert.strictEqual(store.getOtp('01733333333'), null, 'and the older one is never served after it');

    // Two different phones, no common clock: server order.
    store.addSms('IVAC', '01744444444', 'Your OTP is 333333', now - 140_000, 'devD', 'd1');
    await sleep(2);
    store.addSms('IVAC', '01744444444', 'Your OTP is 444444', now - 200_000, 'devE', 'd2');
    assert.strictEqual(store.getOtp('01744444444'), '444444', 'different phones: the one the server got last');

    // ── 2. words-only captures ──────────────────────────────────
    const greedy = [{ phoneNumber: 'IVACBD', patterns: ['prompted\\s+(.+)'] }];
    for (const [m, want] of [
        ['prompted Seven Seven Eight Zero Five Zero, valid for one minute.', null],
        ['prompted Seven Seven Eight Zero Five Zero one-time use only', null],
        ['prompted Four Two Six One\nOne time password', '4261'],          // (.+) stops at the line end

        ['prompted Seven Seven Eight Zero Five Zero Ninety days', '778050'],  // "Ninety" is not a digit
        ['prompted ' + 'Seven_'.repeat(30), null],
        ['prompted Seven_Seven_Eight_Zero_Five_Zero', '778050']
    ]) assert.strictEqual(otp.extractCode(m, 'IVACBD', '', greedy), want, JSON.stringify(m));
    assert.strictEqual(otp.convertTextToNumber('01711111111234'), null, 'never above 10 digits');
    const lines = [{ phoneNumber: 'IVACBD', patterns: ['prompted\\s+([\\s\\S]+)'] }];
    assert.strictEqual(otp.extractCode('prompted Four Two Six One\nOne time password', 'IVACBD', '', lines), null,
        'a capture across lines: "One" is not a fifth digit');

    // ── 3. never start inside a run ─────────────────────────────
    const a = teach.analyze({ message: 'Your IVAC sequence:\nSeven_Seven_Eight_Zero_Five_Zero', otpPart: '778050',
                              rule: 'IVACBD', filters: [], examples: [] });
    assert.ok(a.ok, a.error);
    const only = [{ phoneNumber: 'IVACBD', patterns: [a.pattern] }];
    for (const m of ['Your IVAC sequence:\nOne_Two_Three_Four_Five_Six_Seven_Eight_Nine',
                     'Your IVAC sequence:\nOne_Two_Three_Four_Five_Six_Seven_Eight_Nine_Zero']) {
        const r = otp.extractCode(m, 'IVACBD', '', only);
        assert.ok(r === null || r.length >= 9, `never a piece of a longer code: ${r}`);
    }
    assert.strictEqual(otp.extractCode('Phone four two six one is the code', 'IVACBD', '',
        [{ phoneNumber: 'IVACBD', patterns: [teach.analyze({ message: 'four two six one is the code',
            otpPart: '4261', rule: 'IVACBD', filters: [], examples: [] }).pattern] }]), '4261');

    // ── 4. stalled stream ───────────────────────────────────────
    let destroyed = false, writes = 0;
    const fake = { writableLength: 2 * 1024 * 1024, write() { writes++; }, destroy() { destroyed = true; },
                   end() {}, on() {}, setHeader() {}, writeHead() {}, flushHeaders() {} };
    store.addSSEClient(fake, { userId: 'admin', role: 'admin' });
    const before = writes;
    store.broadcast('ping', { x: 1 });
    assert.ok(destroyed, 'a stream holding over 1 MB unread is dropped');
    store.broadcast('ping', { x: 2 });
    assert.ok(writes - before <= 0, 'and never written to again');

    // ── 5. promo before an OTP is not "superseded" ──────────────
    recorded.length = 0;
    store.addSms('Grameenphone', '01755555555', 'Recharge now and get bonus data!', Date.now(), 'p', 'p1');
    store.addSms('IVAC', '01755555555', 'Your OTP is 445566', Date.now(), 'p', 'p2');
    const promo = store.getAllSms().find(x => x.message.startsWith('Recharge'));
    assert.strictEqual(promo.status, 'pending', 'it finishes as no_code at the end of its window');
    assert.ok(!recorded.some(([m, o]) => m.startsWith('Recharge') && o === 'superseded'));

    // ── 6. clock ran ahead, then NTP corrected it ───────────────
    const t = Date.now();
    store.addSms('IVAC', '01766666666', 'Your OTP is 111111', t + 50_000, 'devF', 'f1');   // stamped 50 s ahead
    store.addSms('IVAC', '01766666666', 'Your OTP is 222222', t + 1_000, 'devF', 'f2');    // clock corrected
    assert.strictEqual(store.getOtp('01766666666'), '222222', 'the corrected clock does not block the new OTP');

    // ── 7. oversized body ───────────────────────────────────────
    const big = 'x'.repeat(100_000) + ' Your OTP is 123456';
    const r = store.addSms('X', '01777777777', big, Date.now(), 'g', 'g1');
    const stored = store.getAllSms().find(x => x.id === r.id);
    assert.ok(stored.message.length <= 8000, 'cut at the boundary');

    console.log = realLog; console.warn = realWarn;
    console.log('ok — stale replays newest-first, words-only captures exact, no mid-run starts, stalled streams '
        + 'dropped, promos not superseded, corrected clocks, bodies capped');
    process.exit(0);
})().catch(e => { console.log = realLog; console.error(e); process.exit(1); });
