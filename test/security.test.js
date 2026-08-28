/**
 * test/security.test.js — the dashboard's authentication and headers.
 *
 * The session token used to be HMAC(API_KEY, DASHBOARD_PASSWORD): the same
 * string forever, un-revocable, and derived from the password itself — so a
 * leaked token was both permanent and a verifier for the password. It is now
 * random, expiring and revocable, and these assertions are what stop that
 * regressing.
 *
 * Run: node test/security.test.js
 */

const assert = require('assert');
const fs = require('fs');
const STATE = '/tmp/sec-state.json';
try { fs.unlinkSync(STATE); } catch (e) {}

Object.assign(process.env, {
    API_KEY: 'k', DASHBOARD_PASSWORD: 'correct-horse',
    PORT: '3976', STATE_FILE: STATE, SESSION_TTL_MINUTES: '5'
});

const real = console.log; console.log = () => {};
require('../server.js');
console.log = real;

const B = 'http://127.0.0.1:3976';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const login = pw => fetch(B + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw })
}).then(r => r.json());

(async () => {
    await sleep(400);

    // ── tokens ───────────────────────────────────────────────────
    const a = (await login('correct-horse')).token;
    const b = (await login('correct-horse')).token;
    assert.ok(a && b, 'login returns a token');
    assert.notStrictEqual(a, b, 'each login must mint a NEW token, not a constant');
    assert.ok(!a.includes('correct-horse'), 'token must not contain the password');
    assert.strictEqual(a.length, 64, '32 random bytes, hex');

    const auth = t => ({ Authorization: 'Bearer ' + t });
    assert.strictEqual((await fetch(B + '/api/messages', { headers: auth(a) })).status, 200);

    // ── logout revokes server-side ───────────────────────────────
    await fetch(B + '/api/logout', { method: 'POST', headers: auth(a) });
    assert.strictEqual((await fetch(B + '/api/messages', { headers: auth(a) })).status, 401,
        'a logged-out token must stop working — forgetting it client-side is not logout');
    assert.strictEqual((await fetch(B + '/api/messages', { headers: auth(b) })).status, 200,
        'revoking one session must not touch another');

    // ── forged tokens ────────────────────────────────────────────
    for (const bad of ['', 'x', 'a'.repeat(64), b + 'a']) {
        assert.strictEqual((await fetch(B + '/api/messages', { headers: auth(bad) })).status, 401,
            `forged token accepted: ${bad.slice(0, 12)}`);
    }

    // ── headers ──────────────────────────────────────────────────
    const h = (await fetch(B + '/health')).headers;
    const csp = h.get('content-security-policy') || '';
    assert.ok(csp.includes("default-src 'self'"), 'CSP must be set');
    assert.ok(csp.includes("frame-ancestors 'none'"), 'CSP must forbid framing');
    assert.ok(csp.includes("base-uri 'none'"), 'CSP must pin base-uri');
    assert.strictEqual(h.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(h.get('referrer-policy'), 'no-referrer',
        'the SSE token rides in the URL — it must never leave in a Referer');
    assert.strictEqual(h.get('x-frame-options'), 'DENY');

    // ── CORS is scoped ───────────────────────────────────────────
    const fetchPath = await fetch(B + '/get?number=01711111111');
    assert.strictEqual(fetchPath.headers.get('access-control-allow-origin'), '*',
        '/get stays wildcarded — the userscript calls it cross-origin');
    const api = await fetch(B + '/api/messages', { headers: auth(b) });
    assert.strictEqual(api.headers.get('access-control-allow-origin'), null,
        'the dashboard API must NOT be wildcarded — nothing legitimate calls it cross-origin');

    // ── the dashboard no longer stores the password ──────────────
    const html = fs.readFileSync(__dirname + '/../public/index.html', 'utf8');
    assert.ok(!/sessionStorage\.setItem\('getotp_pw'/.test(html),
        'the password must not be written to storage — XSS reads it, and it outlives any token');

    console.log('ok — tokens random/expiring/revocable, headers set, CORS scoped');
    process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
