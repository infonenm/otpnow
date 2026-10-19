/**
 * test/audit-4421.test.js — server 4.42.1, findings of the full audit.
 *
 *   1. /api/register OMITS allowedHosts when no list is set (an explicit []
 *      wiped the list a phone already had), and sends it when one is.
 *   2. A send report that arrives before the outbox has loaded is answered
 *      503 (retry), never 404 (which made the phone drop it for good).
 *
 * Run: node test/audit-4421.test.js
 */
const assert = require('assert');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

process.env.DASHBOARD_PASSWORD = 'admin-pw';
process.env.API_KEY            = 'test-key';
process.env.USERS_ENABLED      = 'true';
process.env.STATE_FILE         = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-audit-')), 's.json');
process.env.PORT               = '3997';

const fcm = require('../lib/fcm');
fcm.send = async () => {};
const outbox = require('../lib/outbox');
require('../server.js');

function req(method, p, { body, token, apiKey } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (token)  headers.Authorization = 'Bearer ' + token;
        if (apiKey) headers['X-Api-Key'] = apiKey;
        const r = http.request({ host: '127.0.0.1', port: 3997, method, path: p, headers }, res => {
            let raw = ''; res.on('data', c => raw += c);
            res.on('end', () => { let b = null; try { b = JSON.parse(raw); } catch (e) { /* */ }
                                  resolve({ status: res.statusCode, body: b }); });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const register = id => req('POST', '/api/register', { apiKey: 'test-key',
    body: { deviceId: id, model: 'Galaxy', installId: id, appVersion: '4.38.3', sims: [], canSendSms: true } });

(async () => {
    await sleep(300);
    const admin = (await req('POST', '/api/login', { body: { password: 'admin-pw' } })).body.token;

    // ── 1. allowedHosts on register ──────────────────────────────
    let r = await register('d1d1d1d1d1d1d1d1');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(!('allowedHosts' in r.body), 'no list set: the key is omitted, never []');
    r = await req('POST', '/api/allowed-hosts', { token: admin, body: { hosts: ['spare.onrender.com'] } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    r = await register('d1d1d1d1d1d1d1d1');
    assert.ok(Array.isArray(r.body.allowedHosts) && r.body.allowedHosts.includes('spare.onrender.com'),
              'a set list is sent: ' + JSON.stringify(r.body.allowedHosts));

    // ── 2. a report before the outbox is ready ───────────────────
    const wasReady = outbox.ready();
    outbox._setLoaded(false);
    r = await req('POST', '/api/send/report', { apiKey: 'test-key',
        body: { deviceId: 'd1d1d1d1d1d1d1d1', jobId: 'nope', event: 'sent', part: 0, parts: 1 } });
    assert.strictEqual(r.status, 503, 'not loaded yet: retry, not "no such job" — ' + JSON.stringify(r.body));
    outbox._setLoaded(true);
    r = await req('POST', '/api/send/report', { apiKey: 'test-key',
        body: { deviceId: 'd1d1d1d1d1d1d1d1', jobId: 'nope', event: 'sent', part: 0, parts: 1 } });
    assert.strictEqual(r.status, 404, 'loaded: an unknown job is 404');
    outbox._setLoaded(wasReady);

    // ── 3. a stream ends with its session or its account ────────
    const created = (await req('POST', '/api/users', { token: admin, body: { name: 'Karim' } })).body;
    r = await req('POST', '/api/set-password', { body: { username: 'karim', code: created.enrollCode,
                                                          password: 'karim-password' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const karim = (await req('POST', '/api/login', { body: { username: 'karim', password: 'karim-password' } })).body.token;
    const openStream = async token => {
        const ticket = (await req('GET', '/api/stream-ticket', { token })).body.ticket;
        return new Promise((resolve, reject) => {
            const sreq = http.get({ host: '127.0.0.1', port: 3997, path: '/api/stream?ticket=' + ticket }, res => {
                const st = { ended: false, data: '' };
                res.on('data', c => { st.data += c; });
                res.on('end', () => { st.ended = true; });
                res.on('close', () => { st.ended = true; });
                resolve(st);
            });
            sreq.on('error', reject);
        });
    };
    const s1 = await openStream(karim);
    await sleep(100);
    assert.strictEqual(s1.ended, false, 'open while the account is active');
    r = await req('POST', '/api/users/karim/active', { token: admin, body: { active: false } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    await sleep(200);
    assert.strictEqual(s1.ended, true, 'deactivation closes the user\'s live stream');
    // Logout closes the stream opened under that session.
    const s2 = await openStream(admin);
    await sleep(100);
    const admin2 = (await req('POST', '/api/login', { body: { password: 'admin-pw' } })).body.token;
    await req('POST', '/api/logout', { token: admin });
    await sleep(200);
    assert.strictEqual(s2.ended, true, 'logout closes that session\'s stream');

    // ── 4. enrollment says nothing about which accounts exist ───
    const ghost = await req('POST', '/api/set-password', { body: { username: 'nobody-here', code: 'AAAA-BBBB',
                                                                   password: 'long-enough-pw' } });
    const wrong = await req('POST', '/api/set-password', { body: { username: 'karim', code: 'AAAA-BBBB',
                                                                   password: 'long-enough-pw' } });
    assert.strictEqual(ghost.status, 400); assert.strictEqual(wrong.status, 400);
    assert.strictEqual(ghost.body.error, wrong.body.error, 'one answer for every refusal');

    // ── 5. deactivation ends a user's override ──────────────────
    const store = require('../lib/store');
    await req('POST', '/api/users/karim/active', { token: admin2, body: { active: true } });
    const so = store.startOverride('karim', 30);
    assert.ok(so.ok, JSON.stringify(so));
    await req('POST', '/api/users/karim/active', { token: admin2, body: { active: false } });
    assert.ok(!('karim' in store.listOverrides()), 'no override outlives deactivation');

    // ── 6. parallel wrong passwords are answered one after another ──
    // (and the real password is never locked out by them — review of 4.38.4)
    const answered = [];
    for (let i = 0; i < 30; i++) {
        req('POST', '/api/login', { body: { password: 'wrong-' + i } }).then(x => answered.push(x.status));
    }
    await sleep(150);
    const ok = await req('POST', '/api/login', { body: { password: 'admin-pw' } });
    assert.strictEqual(ok.status, 200, 'the right password works while guesses are queued: ' + JSON.stringify(ok.body));
    await sleep(2000);
    const wrongSoFar = answered.filter(x => x === 401).length;
    const refusedNow = answered.filter(x => x === 429).length;
    assert.ok(wrongSoFar <= 5, 'wrong answers come out one at a time, not all at once: ' + wrongSoFar + ' in ~2 s');
    assert.ok(refusedNow >= 15, 'a queue longer than 30 s is refused at once: ' + refusedNow + ' x 429');
    // User sign-ins HASH: only a few run at once, the rest are refused before hashing.
    const userBurst = await Promise.all(Array.from({ length: 30 }, (_, i) =>
        req('POST', '/api/login', { body: { username: 'karim', password: 'nope-' + i } })));
    const userRefused = userBurst.filter(x => x.status === 429).length;
    assert.ok(userRefused >= 15, 'parallel hashing is capped: ' + userRefused + ' x 429');

    console.log('ok — register never wipes a phone\'s allowlist, a send report is never dropped while the server starts, '
        + 'streams end with their session, enrollment does not reveal accounts, overrides end with the account, guesses are queued and never lock out the real password');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
