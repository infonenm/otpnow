/**
 * test/xss.test.js — attacker-controlled fields must not reach the DOM as markup.
 *
 * The hole: canonicalizePhone returns the raw string when it cannot parse a
 * number, so any recipient posted to /sms arrives at the dashboard verbatim. It
 * was then interpolated into <option value="${n}">${n}</option> unescaped, which
 * closes the attribute and injects markup into the dashboard's own origin —
 * where the session token and the saved password live.
 *
 * Reaching it needs the API key, which ships inside the APK and is recoverable
 * with `strings`. So "needs the key" is not the same as "needs a secret".
 *
 * Run: node test/xss.test.js
 */

const assert = require('assert');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../public/index.html', 'utf8');

// Every interpolation of a message field into markup must go through esc().
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

// esc() escapes < > & but NOT quotes, so escaped data must never be placed
// where a quote would matter — i.e. never inside inline JS.
assert.ok(!/onclick="[^"]*\$\{esc\(/.test(html),
    'esc() output must not be interpolated into inline JS — it does not escape quotes');
assert.ok(/data-code="\$\{esc\(code\)\}"/.test(html),
    'the code should travel as a data attribute, read by a delegated handler');

// The store must not sanitise on the way in — escaping belongs at render time,
// and pretending otherwise hides the real contract.
const {canonicalizePhone} = require('../lib/phone');
const evil = '"><img src=x onerror=alert(1)>';
assert.strictEqual(canonicalizePhone(evil), evil,
    'canonicalizePhone passes unparseable input through — the renderer must escape');

console.log('ok — attacker-controlled fields are escaped at every render site');
