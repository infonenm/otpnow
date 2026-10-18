/**
 * test/send-ui.test.js — server 4.41.0: the Send SMS panel and the server agree.
 *
 * The dashboard shows "1 part / 2 parts / too long" and accepts or rejects a
 * typed number BEFORE asking the server. If its rule drifted from the server's,
 * the panel would offer a Send the server then refuses — or, worse, show one
 * part while the SIM is billed for two. So both functions are EXTRACTED from
 * the page and run against lib/outbox.js over the same inputs (the method
 * xss.test.js uses for esc()).
 *
 * Also pins that nothing the panel renders from a job or a directory entry is
 * interpolated without esc(), and that no inline handler carries data.
 *
 * Run: node test/send-ui.test.js
 */
const assert = require('assert');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../public/index.html', 'utf8');

function extractFunction(src, name) {
    const start = src.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + '() not found in the dashboard');
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error('unbalanced ' + name);
}

const uiParts  = new Function('return (' + extractFunction(html, 'smsParts') + ')')();
const uiNumber = new Function('return (' + extractFunction(html, 'canonicalNumber') + ')')();

process.env.USERS_ENABLED = 'true';
const outbox = require('../lib/outbox');
const { canonicalizePhone } = require('../lib/phone');

// ── length: identical on every input ────────────────────────────
const samples = ['', 'a', 'Hello', 'a'.repeat(160), 'a'.repeat(161), 'a'.repeat(306), 'a'.repeat(307),
    'a'.repeat(459), 'a'.repeat(460), '€'.repeat(80), '€'.repeat(81), '{}[]~|^\\', 'Tk 2000.00 — paid',
    'আমার নাম রিয়াদ', 'আ'.repeat(70), 'আ'.repeat(71), 'আ'.repeat(134), 'আ'.repeat(135), 'আ'.repeat(201),
    'আ'.repeat(202), 'Hi 😀', 'Ünïcödé façade', 'line1\nline2\r\n', 'ÄÖÑÜ§¿äöñüà', '@£$¥èéùìòÇØøÅåΔ_'];
for (const t of samples) {
    assert.deepStrictEqual(uiParts(t), outbox.smsParts(t), 'part count differs for ' + JSON.stringify(t.slice(0, 20)));
}
for (let i = 0; i < 2000; i++) {
    const pool = 'abcXYZ 0123€{}আমিঠ😀\n@£';
    let t = '';
    const n = Math.floor(Math.random() * 480);
    for (let k = 0; k < n; k++) t += pool[Math.floor(Math.random() * pool.length)];
    assert.deepStrictEqual(uiParts(t), outbox.smsParts(t), 'random sample differs: ' + JSON.stringify(t));
}

// ── typed numbers: the panel accepts exactly what the server accepts ─
const serverAccepts = raw => {
    const typed = String(raw).trim().slice(0, 32);
    const c = /[^0-9+\-\s().]/.test(typed) ? '' : canonicalizePhone(typed);
    return /^01[3-9][0-9]{8}$/.test(c) ? c : '';
};
for (const raw of ['01711111111', '+8801711111111', '8801711111111', '008801711111111', '1711111111',
                   '017-1111-1111', '(017) 1111 1111', '01211111111', '0171111111', '017111111111',
                   '0171111111x', 'abc', '', '+880 1911-222333', '01911222333 ', '٠١٧١١١١١١١١']) {
    assert.strictEqual(uiNumber(raw), serverAccepts(raw), 'number rule differs for ' + JSON.stringify(raw));
}

// ── what the panel renders is escaped ───────────────────────────
const panel = html.slice(html.indexOf('//  SEND SMS (4.41.0)'), html.indexOf('function notify(msg)'));
assert.ok(panel.length > 1000, 'the Send SMS script block is where it should be');
// Only HTML templates are sinks: a label built as plain data (and escaped where
// it is finally rendered) or text set through textContent is not.
const htmlTemplates = (panel.match(/`[^`]*`/g) || []).filter(t => /<[a-z]/i.test(t));
assert.ok(htmlTemplates.length >= 8, 'found the panel\'s HTML templates');
for (const t of htmlTemplates) {
    for (const f of ['j.to', 'j.message', 'j.error', 'j.toLabel', 'j.fromNumber', 'x.reason', 'x.number',
                     'x.deviceName', 'x.ownerName', 'u.name', 'r.number', 'r.label', 'j.createdByName',
                     'j.status', 'st', 'key', 'u.userId', 'j.id']) {
        const bare = new RegExp('\\$\\{\\s*' + f.replace('.', '\\.') + '\\s*\\}');
        assert.ok(!bare.test(t), `${f} is interpolated into HTML without esc(): ${t.slice(0, 80)}`);
    }
}
assert.ok(!/on(click|change|input)="[^"]*\$\{/.test(panel), 'no data in inline handlers');

// The internal status is shown for what it is.
assert.ok(/case 'internal':\s+return 'From one of your own SIMs/.test(html), 'internal SMS are labelled');

// Fonts are served by this server: the CSP forbids third-party stylesheets.
assert.ok(!/fonts\.googleapis\.com/.test(html), 'no Google Fonts link (the CSP would block it)');
for (const f of (html.match(/url\(\/fonts\/[^)]+\)/g) || [])) {
    const file = f.slice(4, -1);
    assert.ok(fs.existsSync(__dirname + '/../public' + file), 'font file exists: ' + file);
}

console.log('ok — the panel counts SMS parts and accepts numbers exactly as the server does, '
    + 'renders nothing unescaped, and serves its own fonts');
process.exit(0);
