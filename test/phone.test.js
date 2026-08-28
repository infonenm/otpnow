/**
 * test/phone.test.js — canonicalization vectors.
 *
 * The SAME table exists in the Android app at
 *   app/src/test/java/com/getotp/app/PhoneUtilsTest.java
 * Both must pass. If you add a case here, add it there in the same commit.
 *
 * Run: node test/phone.test.js       (no test framework, no dependencies)
 */

const assert = require('assert');
const { canonicalizePhone } = require('../lib/phone');

// input, expected
const VECTORS = [
    ['01712345678',      '01712345678'],   // already canonical
    ['8801712345678',    '01712345678'],   // country code, no plus
    ['+8801712345678',   '01712345678'],   // country code with plus
    ['008801712345678',  '01712345678'],   // international prefix
    ['1712345678',       '01712345678'],   // bare 10-digit
    ['+880 1712-345678', '01712345678'],   // separators are stripped
    [' 01712345678 ',    '01712345678'],   // surrounding whitespace
    ['IVAC',             'IVAC'],          // alphanumeric sender id survives
    ['bKash',            'bKash'],         // ditto, case preserved
    ['Unknown',          'Unknown'],       // the app's "no SIM resolved" marker
    ['',                 ''],
    ['   ',              ''],
    [null,               ''],
    [undefined,          ''],
    ['12345',            '12345'],         // unrecognised digit run: unchanged
    ['+8801712345',      '+8801712345'],   // too short for 880 rule: unchanged
];

let failed = 0;
for (const [input, expected] of VECTORS) {
    const actual = canonicalizePhone(input);
    try {
        assert.strictEqual(actual, expected);
    } catch (e) {
        failed++;
        console.error(`FAIL  canonicalizePhone(${JSON.stringify(input)}) = ` +
                      `${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
}

// Idempotence: canonicalizing twice must equal canonicalizing once. The server
// canonicalizes on store AND on fetch, so a non-idempotent rule would break
// lookups for whatever it double-transformed.
for (const [input] of VECTORS) {
    const once = canonicalizePhone(input);
    const twice = canonicalizePhone(once);
    if (once !== twice) {
        failed++;
        console.error(`FAIL  not idempotent: ${JSON.stringify(input)} -> ` +
                      `${JSON.stringify(once)} -> ${JSON.stringify(twice)}`);
    }
}

if (failed) {
    console.error(`\n${failed} failure(s)`);
    process.exit(1);
}
console.log(`ok — ${VECTORS.length} vectors + idempotence`);
