/**
 * test/master-parity.test.js — server 4.42.0: the server and OTP Master agree.
 *
 * OTP Master counts SMS parts and checks typed numbers on the phone, before
 * the server sees them. If the two rules drift, the console promises "1 SMS"
 * for a text the server charges as 2, or refuses a number the server accepts.
 *
 * The Kotlin test (otp-master/app/src/test/.../ServerParityTest.kt) carries a table
 * of vectors; this file GENERATES that table from the server's own functions
 * (outbox.smsParts, outbox.typedMobile) and fails when the copy in the Kotlin
 * test is stale — so changing either side without the other breaks a suite.
 *
 * Run:      node test/master-parity.test.js
 * Refresh:  node test/master-parity.test.js --write
 *
 * A server-only checkout (no otp-master/ folder) skips with a note.
 */
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

process.env.FIRESTORE_ENABLED = 'false';
const outbox = require('../lib/outbox');

const KT = path.join(__dirname, '..', '..', 'otp-master', 'app', 'src', 'test', 'java',
    'com', 'getotp', 'master', 'logic', 'ServerParityTest.kt');
const BEGIN = '    // BEGIN GENERATED VECTORS\n';
const END   = '    // END GENERATED VECTORS';

const TEXTS = ['', 'a', 'Your OTP is 123456', 'x'.repeat(160), 'x'.repeat(161), 'x'.repeat(306), 'x'.repeat(307),
    '{'.repeat(80), '{'.repeat(81), '€uro', 'Hello\nworld', 'à la carte', 'Ünïcödé', 'আপনার কোড ১২৩৪৫৬',
    'আ'.repeat(70), 'আ'.repeat(71), 'x'.repeat(100) + '😀', '😀'.repeat(35), '😀'.repeat(36), 'tab\there', 'a`b',
    '[x]~|^\\', '\f', 'C:\\foo', 'ç', 'Ç', 'x'.repeat(459), 'x'.repeat(460)];

const PHONES = ['01711111111', '+8801711111111', '8801711111111', '008801711111111', '1711111111', '017-1111-1111',
    '(017) 1111 1111', '0171111111x', '01211111111', '0171111111', '017111111111', ' 01911111111 ', '+880 19 1111 1111',
    'IVAC', '', '   ', '01311111111', '01811111111', '880171111111', '0088017111111111', '+1 555 0100',
    '0 1 7 1 1 1 1 1 1 1 1', '017\u00a01111\u20091111', '\u00a001711111111\ufeff', '\u001c01711111111',
    '\u3000+880\u30001711111111', '01711111111' + ' '.repeat(30) + '1', '०१७११११११११'];

// Kotlin has no \f escape, and invisible spaces are written as \uXXXX so the table can be read.
// (One pass over the escapes, so an escaped backslash followed by "f" — "C:\\foo" — stays itself.)
const esc = s => JSON.stringify(s).replace(/\$/g, '\\$').replace(/\\(\\|f)/g, (m, c) => c === 'f' ? '\\u000C' : m)
    .replace(/[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/g,
        c => '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
// Long single-character runs are written as "x".repeat(n).
const kt = s => {
    const cs = Array.from(s);
    return cs.length > 12 && cs.every(c => c === cs[0]) ? `${esc(cs[0])}.repeat(${cs.length})` : esc(s);
};

function generate() {
    const out = [];
    out.push('    // GENERATED from server/lib/outbox.js smsParts by test/master-parity.test.js — do not edit by hand.');
    out.push('    private val PARTS = listOf(');
    for (const t of TEXTS) {
        const r = outbox.smsParts(t);
        out.push(`        V(${kt(t)}, "${r.encoding}", ${r.units}, ${r.parts}, ${r.capacity}),`);
    }
    out.push('    )');
    out.push('    // GENERATED from server/lib/outbox.js typedMobile — do not edit by hand.');
    out.push('    private val PHONES = listOf(');
    for (const p of PHONES) out.push(`        ${kt(p)} to ${kt(outbox.typedMobile(p))},`);
    out.push('    )');
    return out.join('\n') + '\n';
}

// The rule itself, independent of the Kotlin file.
assert.strictEqual(outbox.typedMobile('+880 1711-111111'), '01711111111');
assert.strictEqual(outbox.typedMobile('0171111111x'), '');
assert.strictEqual(outbox.typedMobile(null), '');

if (!fs.existsSync(KT)) {
    console.log('master-parity: otp-master/ not present (server-only checkout) — Kotlin table not checked');
    console.log('✓ master-parity');
    process.exit(0);
}
const src = fs.readFileSync(KT, 'utf8');
const a = src.indexOf(BEGIN), b = src.indexOf(END);
assert.ok(a >= 0 && b > a, 'ServerParityTest.kt has no generated-vectors markers');
const want = generate();
const have = src.slice(a + BEGIN.length, b);
if (process.argv.includes('--write')) {
    fs.writeFileSync(KT, src.slice(0, a + BEGIN.length) + want + src.slice(b));
    console.log('master-parity: table rewritten');
} else {
    assert.strictEqual(have, want, 'ServerParityTest.kt vectors are stale — run: node test/master-parity.test.js --write');
}
console.log('✓ master-parity: ' + TEXTS.length + ' texts, ' + PHONES.length + ' numbers');
