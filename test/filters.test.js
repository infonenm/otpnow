/**
 * test/filters.test.js — same-sender rules must merge, not shadow.
 *
 * The trap this closes: sender matching normalises (upper-case, then spaces,
 * underscores and hyphens stripped), and matching stops at the FIRST rule that
 * claims a sender. So an operator adding a second rule for "IVACBD" when
 * "IVAC_BD" already existed created a rule that could never run — and the
 * dashboard showed it as if it were live. The fallback pattern looked present
 * and was silently dead.
 *
 * Run: node test/filters.test.js
 */

const assert = require('assert');
process.env.STATE_FILE = '/tmp/filters-test.json';
const real = console.log; console.log = () => {};
const store = require('../lib/store');
const { extractCode } = require('../lib/otp');
console.log = real;

// Exactly the shape that was on the dashboard.
const raw = [
    { phoneNumber: 'DEFAULT',     patterns: ['\\bis\\s+(\\d{4,8})\\b', '(\\d{4,8})'] },
    { phoneNumber: 'IVAC_BD',     patterns: ['prompted\\s+((?:[A-Za-z]+-?)+)'] },
    { phoneNumber: 'IVACBD',      patterns: ['prompted\\s+((?:[A-Za-z]+-?)+)'] },
    { phoneNumber: 'IVAC FEES',   patterns: ['prompted\\s+((?:[A-Za-z]+-?)+)'] },
    { phoneNumber: '01708404440', patterns: ['prompted\\s+((?:[A-Za-z]+-?)+)'] },
    { phoneNumber: '01708404440', patterns: ['prompted\\s+(.*?)\\s*\\.'] },
    { phoneNumber: 'IVACBD',      patterns: ['prompted\\s+(.*?)\\s*\\.'] },
];

const merged = store.mergeFilterRules(raw);
assert.strictEqual(merged.length, 4, '7 rows targeting 4 senders must fold to 4 rules');

const find = n => merged.find(r => r.phoneNumber === n);
assert.deepStrictEqual(find('IVAC_BD').patterns.length, 2,
    'IVAC_BD and IVACBD are the same sender — their patterns must combine');
assert.deepStrictEqual(find('01708404440').patterns.length, 2);
assert.strictEqual(find('IVAC_BD').patterns[0], 'prompted\\s+((?:[A-Za-z]+-?)+)',
    'the first rule keeps priority — merging must not reorder behaviour');
assert.strictEqual(merged[0].phoneNumber, 'DEFAULT', 'DEFAULT keeps its position');

// The point of it all: the second pattern now actually runs.
const N = '01719749470';
assert.strictEqual(
    extractCode('You are prompted Four-Two-Six-One to continue.', 'IVACBD', N, merged),
    '4261', 'word format still works via the first pattern');
assert.strictEqual(
    extractCode('You are prompted 8842 . Thanks', 'IVACBD', N, merged), '8842',
    'the FALLBACK pattern must catch the digit format — before merging this returned null');

// Merging is idempotent: saving twice must not keep folding or duplicating.
assert.deepStrictEqual(store.mergeFilterRules(merged), merged,
    'merging an already-merged set must be a no-op');

// A genuinely different sender is never absorbed.
assert.ok(find('IVAC FEES'), 'IVAC FEES normalises to IVACFEES and stays separate');

console.log('ok — same-sender rules merge, fallbacks run, order preserved');
process.exit(0);
