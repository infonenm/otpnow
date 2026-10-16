/**
 * test/refusal.test.js — a message that is not made live must never be served
 * later.
 *
 * Found by an independent review of 4.37.0. commitCode refused a message (an
 * earlier SMS re-pushed late, a Test while a real code was live) but left it
 * `pending` with its code. It reached the server AFTER the live code, so its own
 * window closed later — and once the live entry aged out, getOtp's fallback
 * served it: a code older than one already spent, or a Test code to a script
 * waiting for its next real OTP. A stale replay had the same path in 4.36.0.
 *
 * The clock is moved by replacing Date.now — the store reads time only through
 * it — so the two-minute window can be crossed without waiting two minutes.
 *
 * Run: node test/refusal.test.js
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.STATE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-rf-')), 's.json');
process.env.OTP_MAX_AGE_SECONDS = '120';
process.env.OTP_PATTERNS = JSON.stringify([{ phoneNumber: 'DEFAULT',
    patterns: ['\\bis\\s+(\\d{4,8})\\b', '(\\d{4,8})'] }]);

const store   = require('../lib/store');
const history = require('../lib/history');

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const at = ms => { offset = ms; };
const all = store._internals.smsMap;
const DEV = 'aaaaaaaaaaaaaaaa';

// ── 1. An earlier SMS re-pushed late (Get Latest / queue retry) ─────────────
at(0);
const t0 = Date.now();
store.addSms('IVAC', '01711111111', 'Your OTP is 111111', t0, DEV, 'a');
at(10_000);
const z = store.addSms('IVAC', '01711111111', 'Your OTP is 999999', t0 - 30_000, DEV, 'z');
assert.strictEqual(all.get(z.id).status, 'superseded', 'refused at once, not left pending');
assert.strictEqual(store.getOtp('01711111111'), '111111');
assert.strictEqual(store.getOtp('01711111111'), null);
at(121_000); store._finalizeExpired();
assert.strictEqual(store.getOtp('01711111111'), null);
assert.strictEqual(store.getOtp('01711111111'), null,
    'the refused older code is NEVER served after the live one ages out');

// ── 2. A Test while a real code is live ─────────────────────────────────────
at(200_000);
store.addSms('IVAC', '01722222222', 'Your OTP is 445566', Date.now(), null, 'r');
assert.strictEqual(store.getOtp('01722222222'), '445566');
at(220_000);
// Real code already spent here, so this Test MAY run — that is rule 3 working.
store.addSms(history.TEST_SENDER, '01722222222', 'Test OTP: 918273 (SIM 1)', Date.now(), null, 't1');
assert.strictEqual(store.getOtp('01722222222'), '918273', 'after the real code was spent, Test runs');

at(300_000);
store.addSms('IVAC', '01733333333', 'Your OTP is 556677', Date.now(), null, 'r3');
at(310_000);
const t2 = store.addSms(history.TEST_SENDER, '01733333333', 'Test OTP: 918273 (SIM 1)', Date.now(), null, 't2');
assert.strictEqual(all.get(t2.id).status, 'superseded', 'a Test refused by a live real code is finished');
assert.strictEqual(store.getOtp('01733333333'), '556677');
at(425_000); store._finalizeExpired();
assert.strictEqual(store.getOtp('01733333333'), null);
assert.strictEqual(store.getOtp('01733333333'), null,
    'the refused Test code is never handed to a script waiting for its next OTP');

// ── 3. A stale replay after a newer code was spent (also in 4.36.0) ─────────
at(500_000);
const fresh = Date.now();
store.addSms('IVAC', '01744444444', 'Your OTP is 222222', fresh, DEV, 'f');
assert.strictEqual(store.getOtp('01744444444'), '222222');
at(510_000);
const st = store.addSms('IVAC', '01744444444', 'Your OTP is 999999', fresh - 4 * 60_000, DEV, 's');
assert.strictEqual(all.get(st.id).status, 'superseded', 'a replay older than a code already live is finished');
at(625_000); store._finalizeExpired();
assert.strictEqual(store.getOtp('01744444444'), null);
assert.strictEqual(store.getOtp('01744444444'), null, 'and is never served by the fallback');

// ── 4. ...but a stale replay with nothing newer is still delivered ──────────
at(700_000);
store.addSms('IVAC', '01755555555', 'Your OTP is 333444', Date.now() - 4 * 60_000, DEV, 'lonely');
assert.strictEqual(store.getOtp('01755555555'), '333444',
    'a delayed replay with nothing to compete against is still better than nothing');

// ── 5. A phone clock that was AHEAD does not block its next real OTP ────────
at(800_000);
store.addSms('IVAC', '01766666666', 'Your OTP is 101010', Date.now() + 10 * 60_000, DEV, 'ahead');
assert.strictEqual(store.getOtp('01766666666'), '101010');
at(805_000);
store.addSms('IVAC', '01766666666', 'Your OTP is 202020', Date.now(), DEV, 'corrected');
assert.strictEqual(store.getOtp('01766666666'), '202020',
    'an implausible (future) arrivedAt is not used to refuse the next OTP');

Date.now = realNow;
console.log('ok — a refused message is finished at once and never served later; '
    + 'a lonely replay still is');
process.exit(0);
