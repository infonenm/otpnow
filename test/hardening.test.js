/**
 * test/hardening.test.js — the service must not be killable.
 *
 * The failure this exists for was verified by experiment, not reasoned about:
 * Express 4 does not catch a rejected promise from an async handler, and Node
 * terminates on an unhandled rejection. /get and every gateway alias are async,
 * so ONE unexpected throw anywhere beneath them ended the process — losing every
 * OTP held in memory, dropping the dashboard, and forcing a cold start.
 *
 * Run: node test/hardening.test.js
 */

const assert = require('assert');
const fs = require('fs');
const STATE = '/tmp/hard-state.json';
try { fs.unlinkSync(STATE); } catch (e) {}

Object.assign(process.env, {
    API_KEY: 'k', DASHBOARD_PASSWORD: 'correct-horse', PORT: '3983', STATE_FILE: STATE
});
delete process.env.GET_KEY;

const store = require('../lib/store');
const real = console.log, realErr = console.error;
console.log = () => {}; console.error = () => {};
require('../server.js');
console.log = real; console.error = realErr;

const B = 'http://127.0.0.1:3983';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = (p, o) => fetch(B + p, o).then(async r => ({ s: r.status, t: await r.text() }));

(async () => {
    await sleep(400);

    // ── an internal failure must not kill the process ────────────
    const good = store.waitForOtp;
    store.waitForOtp = () => { throw new Error('simulated internal failure'); };
    console.error = () => {};                       // silence the expected log
    const boom = await J('/get?number=01711111111&wait=5');
    console.error = realErr;
    store.waitForOtp = good;

    assert.strictEqual(boom.s, 500, 'an internal failure must answer 500, not vanish');
    assert.ok(boom.t.startsWith('{'), 'and answer in JSON the client can parse');
    assert.ok(!boom.t.includes('simulated'), 'without leaking the internal message');

    // Still serving — this is the whole point.
    assert.strictEqual((await J('/health')).s, 200, 'server must survive an internal failure');

    // ── unknown routes answer JSON, not an HTML error page ───────
    // An HTML 404 is indistinguishable from "OTP not ready" to a client that
    // does JSON.parse in a try/catch — it retries for a minute against an
    // endpoint that does not exist and says nothing.
    const missing = await J('/no-such-endpoint?number=01711111111');
    assert.strictEqual(missing.s, 404);
    assert.ok(missing.t.startsWith('{'), '404 must be JSON');
    assert.ok(JSON.parse(missing.t).error.includes('No such endpoint'), 'and say what is wrong');

    // ── malformed JSON must not crash the parser path ────────────
    const bad = await J('/sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'k' },
        body: '{not json'
    });
    assert.ok(bad.s >= 400 && bad.s < 500, 'malformed JSON is a client error');
    assert.strictEqual((await J('/health')).s, 200, 'and the server keeps serving');

    // ── login back-off slows guessing but never locks you out ────
    const login = pw => {
        const t = Date.now();
        return fetch(B + '/api/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pw })
        }).then(async r => ({ s: r.status, ms: Date.now() - t }));
    };
    console.warn = () => {};
    const first = await login('wrong-1');
    for (let i = 2; i <= 5; i++) await login('wrong-' + i);
    const later = await login('wrong-6');
    assert.strictEqual(later.s, 401);
    assert.ok(later.ms > first.ms * 2,
        `back-off must grow (first ${first.ms}ms, sixth ${later.ms}ms)`);

    const ok = await login('correct-horse');
    assert.strictEqual(ok.s, 200, 'the correct password must still work');
    assert.ok(ok.ms < 500, `and must NOT be delayed (took ${ok.ms}ms) — no lockout`);

    console.log('ok — survives internal failures, answers JSON always, throttles guessing');
    process.exit(0);
})().catch(e => { realErr('FAIL:', e.message); process.exit(1); });
