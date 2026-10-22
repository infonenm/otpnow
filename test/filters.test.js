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

// ── 2026-10-22: IVAC switched to underscore separators ──────────────────────
// \b does not break on '_', so no word converted and the raw words were served
// as the OTP. Must be digits with either separator, and the original pattern.
{
    const { convertTextToNumber } = require('../lib/otp');
    const SMS = '(IVACBD) For security, type the following sequence when prompted '
              + 'Seven_Seven_Eight_Zero_Five_Zero .';
    const userRule = [{ phoneNumber: 'IVACBD', patterns: ['prompted\\s+((?:[A-Za-z]+[_-]?)+)'] }];
    assert.strictEqual(extractCode(SMS, 'IVACBD', N, userRule), '778050',
        'underscore-separated number words must convert');
    assert.strictEqual(extractCode('prompted Four-Two-Six-One to continue.', 'IVACBD', N, userRule), '4261',
        'the hyphen format must keep working with the same pattern');
    assert.strictEqual(convertTextToNumber('Seven_Seven_Eight_Zero_Five_Zero'), '778050');
    assert.strictEqual(convertTextToNumber('one.two three four'), '1234');
    assert.strictEqual(convertTextToNumber('one two three'), null, 'never a code under 4 digits');
    assert.strictEqual(convertTextToNumber('someone'), null, 'a word INSIDE a word is not a digit');
    assert.strictEqual(convertTextToNumber('Hello_World'), null,
        'no digits means no code — never the raw text');
    // A pattern that MATCHES but captures no digits and no number words: the
    // format changed under it. 4.42.4 fell through to the next pattern — often a
    // catch-all that reads an amount — so 4.43.0 stops with NO code instead.
    const twoPats = [{ phoneNumber: 'IVACBD', patterns: ['prompted\\s+([A-Za-z]+)\\b', '(\\d{4,8})'] }];
    assert.strictEqual(extractCode('prompted Hello, pay Tk 2000', 'IVACBD', N, twoPats), null,
        'a digitless capture stops: never the amount');
}

// Merging is idempotent: saving twice must not keep folding or duplicating.
assert.deepStrictEqual(store.mergeFilterRules(merged), merged,
    'merging an already-merged set must be a no-op');

// A genuinely different sender is never absorbed.
assert.ok(find('IVAC FEES'), 'IVAC FEES normalises to IVACFEES and stays separate');

// ── The dashboard must SHOW a rejection ──────────────────────────────────────
//
// POST /api/filters refuses a pattern that can never match (double-escaped, or
// with no capture group) precisely so the mistake surfaces when you save it
// rather than the next time you need an OTP. saveConfig() awaited both fetches
// and read neither result, so it reported "Settings saved" and closed the modal
// on a 400 — the guard fired correctly and was invisible at the only place
// anyone uses it. These are static checks on the one file that renders it.
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../public/index.html', 'utf8');
const saveConfig = html.slice(html.indexOf('async function saveConfig()'));
const body = saveConfig.slice(0, saveConfig.indexOf('\n    }') + 6);

assert.ok(/if\s*\(!fRes\.ok\)/.test(body),
    'saveConfig must check the /api/filters response before claiming success');
assert.ok(body.indexOf("notify('💾 Saved')") > 0
       && body.indexOf('showConfigError') < body.indexOf("notify('💾 Saved')"),
    'a rejection must be surfaced, and before any success message');
assert.ok(/problems/.test(html),
    "the server's per-pattern 'problems' list must be rendered, not just the status code");
assert.ok(/id="configError"/.test(html),
    'the modal needs somewhere to put the reason');
// 4.41.2: Settings is a page, and a save never leaves it. The edit counts as
// saved (setConfigBase) only after BOTH replies were checked.
assert.strictEqual(body.indexOf('closeConfig()'), -1,
    'a save must not close the page — rejected patterns stay on screen');
// 4.41.3 review: what was SENT is what is recorded as saved, and only after
// the server accepted it — an edit made during the request stays unsaved.
assert.ok(body.indexOf('cfgBase.filters = JSON.stringify(sendFilters)') > body.indexOf('if (!fRes.ok)')
       && body.indexOf('cfgBase.autoDelete = sendMins') > body.indexOf('if (!aRes.ok)'),
    'a setting counts as saved only after the server accepted exactly what was sent');
assert.ok(!/setConfigBase\(\)/.test(body),
    'saving must not snapshot the screen as saved — it may hold an edit made during the request');

console.log('ok — same-sender rules merge, fallbacks run, order preserved, '
    + 'and a refused pattern is shown');
process.exit(0);
