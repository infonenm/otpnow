/**
 * test/recommended-filters.test.js — server 4.43.0: the RECOMMENDED filters work.
 *
 * render.yaml's OTP_PATTERNS is the recommended set from FILTERS.md (DEFAULT +
 * the IVACBD rule). This reads that exact value and checks it on every IVAC
 * format seen so far and on the other senders' real shapes — so an edit to the
 * recommendation that breaks a format fails here, not on a booking.
 *
 * Run: node test/recommended-filters.test.js
 */
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const otp    = require('../lib/otp');

const yaml = fs.readFileSync(path.join(__dirname, '..', 'render.yaml'), 'utf8');
const m = yaml.match(/- key: OTP_PATTERNS\n\s+value: '([^\n]*)'/);
assert.ok(m, 'render.yaml has an OTP_PATTERNS value');
const rules = JSON.parse(m[1].replace(/''/g, "'"));

// Every pattern is usable (the same gate as a dashboard save).
for (const r of rules) {
    assert.strictEqual(otp.validateRule(r), null, JSON.stringify(r.phoneNumber));
    for (const p of r.patterns) assert.strictEqual(otp.validatePattern(p), null, p);
}
assert.ok(rules.find(r => r.phoneNumber === 'DEFAULT'), 'DEFAULT stays');
const ivac = rules.find(r => r.phoneNumber === 'IVACBD');
assert.ok(ivac && ivac.patterns.includes('@words'), 'IVACBD ends with the @words net');

const SIM = '01711111111';
const CASES = [
    // IVAC — every format seen, and the next likely ones
    ['IVACBD', '(IVACBD) For security, type the following sequence when prompted Seven_Seven_Eight_Zero_Five_Zero .', '778050'],
    ['IVACBD', 'You are prompted Four-Two-Six-One to continue.', '4261'],
    ['IVAC_BD', 'You are prompted 8842 . Thanks', '8842'],
    ['IVACBD', 'prompted SEVEN SEVEN EIGHT ZERO FIVE ZERO', '778050'],
    ['IVACBD', 'prompted Seven.Seven.Eight.Zero.Five.Zero', '778050'],
    ['IVACBD', 'prompted Seven*Seven*Eight*Zero*Five*Zero', '778050'],
    ['IVACBD', 'prompted Seven/Seven/Eight/Zero/Five/Zero', '778050'],
    ['IVACBD', 'prompted SevenSevenEightZeroFiveZero now', '778050'],
    ['IVACBD', 'Your security sequence: enter Nine.Four.Four.One.Two.Zero when asked', '944120'],
    ['IVACBD', 'Pay Tk 2000. Then type when prompted Seven_Seven_Eight_Zero_Five_Zero', '778050'],
    // IVAC — no code rather than a wrong one
    ['IVACBD', 'prompted Seven-Seven_Eight_Zero_Five_Zero', null],
    ['IVACBD', '(IVACBD) Payment of Tk 2000 received. Thank you', null],
    // Other senders — DEFAULT
    ['bKash', 'You are paying Tk 25,000.00 to IVAC. Your bKash verification code is 445566. Never share it.', '445566'],
    ['bKash', 'Your bKash OTP is 123456', '123456'],
    ['DGEPAY', 'Your DGePay OTP: 425793. Valid for 3 minutes.', '425793'],
    ['16216', 'Rocket: Your OTP is 8844 for Tk 2,000.00', '8844'],
    ['GP', 'Your code is 552211', '552211']
];
let n = 0;
for (const [sender, msg, want] of CASES) {
    assert.strictEqual(otp.extractCode(msg, sender, SIM, rules), want, `${sender}: ${msg}`);
    n++;
}

// Fast: the full recommended set on the IVAC message.
for (let i = 0; i < 2000; i++) otp.extractCode(CASES[0][1], 'IVACBD', SIM, rules);
const N = 20000, t = process.hrtime.bigint();
for (let i = 0; i < N; i++) otp.extractCode(CASES[0][1], 'IVACBD', SIM, rules);
const us = Number(process.hrtime.bigint() - t) / N / 1000;
assert.ok(us < 100, `${us} µs per extraction`);

console.log(`ok — the recommended filters read ${n} real message shapes correctly (${us.toFixed(1)} µs each)`);
