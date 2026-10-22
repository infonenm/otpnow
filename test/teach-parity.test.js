/**
 * test/teach-parity.test.js — server 4.43.0: OTP Master reads Teach's answers.
 *
 * OTP Master's TeachParityTest.kt parses a /api/teach/test response and a
 * /api/teach state. This file GENERATES both from lib/teach.js and fails when
 * the copy in the Kotlin test is stale — a field renamed here without the app
 * breaks a suite, instead of showing an empty result screen.
 *
 * Run:      node test/teach-parity.test.js
 * Refresh:  node test/teach-parity.test.js --write
 */
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

process.env.FIRESTORE_ENABLED = 'false';
const teach = require('../lib/teach');

const KT = path.join(__dirname, '..', '..', 'otp-master', 'app', 'src', 'test', 'java',
    'com', 'getotp', 'master', 'logic', 'TeachParityTest.kt');
const BEGIN = '    // BEGIN GENERATED TEACH\n';
const END   = '    // END GENERATED TEACH';

const MSG = '(IVACBD) For security, type the following sequence when prompted Seven_Seven_Eight_Zero_Five_Zero .';
const FILTERS = [{ phoneNumber: 'DEFAULT', patterns: ['(\\d{4,8})'] },
                 { phoneNumber: 'IVAC_BD', patterns: ['prompted\\s+((?:[A-Za-z]+-?)+)'] }];
const EXAMPLE = { rule: 'IVAC_BD', sender: 'IVACBD', message: 'prompted Four-Two-Six-One', code: '4261', at: 1700000000000 };

function generate() {
    const a = teach.analyze({ message: MSG, otpPart: 'Seven_Seven_Eight_Zero_Five_Zero', rule: 'IVACBD',
        filters: FILTERS, examples: [EXAMPLE],
        recent: [{ sender: 'IVACBD', recipient: '01711111111', message: MSG, receivedAt: 1700000001000 }] });
    assert.ok(a.ok && a.canApply, 'the fixture must be a good result');
    delete a.proposedFilters;                       // never sent to a client
    const state = { unread: [{ ref: 'abc123', rule: 'IVACBD', sender: 'IVACBD', recipient: '01711111111',
                               message: MSG, at: 1700000002000, count: 1 }],
                    examples: [EXAMPLE], rules: ['IVAC_BD'], broken: [] };
    const k = s => JSON.stringify(s).replace(/\$/g, '\\$');
    const out = [];
    out.push('    // GENERATED from server/lib/teach.js by test/teach-parity.test.js — do not edit by hand.');
    out.push(`    private val ANALYSIS = ${k(JSON.stringify(a))}`);
    out.push(`    private val STATE = ${k(JSON.stringify(state))}`);
    out.push(`    private val WANT_CAN_APPLY = ${a.canApply}`);
    out.push(`    private val WANT_CODE = ${k(a.code)}`);
    out.push(`    private val WANT_RULE = ${k(a.rule)}`);
    out.push(`    private val WANT_FORMAT = ${k(a.format)}`);
    out.push(`    private val WANT_FOUND = ${k(a.found.text)}`);
    out.push(`    private val WANT_ANCHOR = ${k(a.anchor || '')}`);
    out.push(`    private val WANT_NOW_READS = ${k(a.nowReads || '')}`);
    out.push(`    private val WANT_PATTERN = ${k(a.pattern)}`);
    out.push(`    private val WANT_STATUSES = listOf(${a.patterns.map(p => k(p.status)).join(', ')})`);
    out.push(`    private val WANT_CHECKS = ${a.checks.length}`);
    out.push(`    private val WANT_CHANGES = ${a.changes.length}`);
    return out.join('\n') + '\n';
}

if (!fs.existsSync(KT)) {
    console.log('teach-parity: otp-master/ not present (server-only checkout) — Kotlin fixture not checked');
    process.exit(0);
}
const src = fs.readFileSync(KT, 'utf8');
const a = src.indexOf(BEGIN), b = src.indexOf(END);
assert.ok(a >= 0 && b > a, 'TeachParityTest.kt has no generated markers');
const want = generate();
if (process.argv.includes('--write')) {
    fs.writeFileSync(KT, src.slice(0, a + BEGIN.length) + want + src.slice(b));
    console.log('teach-parity: fixture rewritten');
} else {
    assert.strictEqual(src.slice(a + BEGIN.length, b), want,
        'TeachParityTest.kt fixture is stale — run: node test/teach-parity.test.js --write');
}
console.log('✓ teach-parity');
