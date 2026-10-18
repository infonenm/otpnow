/**
 * test/move.test.js — server 4.42.0: "Push to all phones" that cannot be missed.
 *
 *   1. preflight: the new server must answer this server's API key like a
 *      GetOTP server; an unreachable host, a different API key or a non-GetOTP
 *      answer is refused BEFORE any phone moves. A different admin password is
 *      only a warning (the phones do not need it).
 *   2. /api/set-url keeps the move pending; every poll then carries
 *      moveTo {url, ts} — to every phone, or only the target user's phones.
 *   3. /api/set-url/cancel stops it. A refused preflight moves nobody.
 *   4. Phones covered by a pending move are not reported offline (going quiet
 *      here is the move working).
 *
 * Run: node test/move.test.js
 */
const assert = require('assert');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

process.env.DASHBOARD_PASSWORD = 'admin-pw';
process.env.API_KEY            = 'test-key';
process.env.USERS_ENABLED      = 'true';
process.env.STATE_FILE         = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-move-')), 's.json');
process.env.PORT               = '3953';

const fcm = require('../lib/fcm');
const pushes = [];
fcm.send = async (action, ts, topic, extra) => { pushes.push({ action, ts, topic, data: extra || {} }); };

const move   = require('../lib/move');
const users  = require('../lib/users');
const alerts = require('../lib/alerts');
require('../server.js');

function req(method, p, { body, token, apiKey } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (token)  headers.Authorization = 'Bearer ' + token;
        if (apiKey) headers['X-Api-Key'] = apiKey;
        const r = http.request({ host: '127.0.0.1', port: 3953, method, path: p, headers }, res => {
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
const KEY = 'test-key';

/** A fake `fetch` standing in for the new server. */
function fakeServer({ key = KEY, password = 'admin-pw', down = false, notGetotp = false } = {}) {
    const calls = [];
    const f = async (url, opts) => {
        calls.push(url);
        if (down) { const e = new Error('connect ECONNREFUSED'); throw e; }
        const json = (status, b) => ({ ok: status < 400, status, json: async () => b });
        if (url.endsWith('/api/settings')) {
            if (notGetotp) return { ok: true, status: 200, json: async () => { throw new Error('html'); } };
            return (opts.headers || {})['X-Api-Key'] === key ? json(200, { globalForwarding: true }) : json(401, { error: 'bad key' });
        }
        if (url.endsWith('/api/login')) {
            return JSON.parse(opts.body).password === password ? json(200, { token: 't1' }) : json(401, { error: 'wrong' });
        }
        if (url.endsWith('/api/logout')) return json(200, { success: true });
        return json(404, {});
    };
    f.calls = calls;
    return f;
}

(async () => {
    await sleep(300);

    // ── 1. preflight ─────────────────────────────────────────────
    let p = await move.preflight('https://spare.onrender.com', KEY, 'admin-pw', fakeServer());
    assert.ok(p.ok && p.warnings.length === 0, 'a ready server with the same key and password passes cleanly');
    p = await move.preflight('https://spare.onrender.com', KEY, 'admin-pw', fakeServer({ key: 'other' }));
    assert.ok(!p.ok && /API key/.test(p.error), 'a different API_KEY is refused: ' + p.error);
    p = await move.preflight('https://spare.onrender.com', KEY, 'admin-pw', fakeServer({ down: true }));
    assert.ok(!p.ok && /did not answer/.test(p.error), 'an unreachable host is refused');
    p = await move.preflight('https://spare.onrender.com', KEY, 'admin-pw', fakeServer({ notGetotp: true }));
    assert.ok(!p.ok && /not like a GetOTP server/.test(p.error), 'something else at that address is refused');
    p = await move.preflight('https://spare.onrender.com', KEY, 'admin-pw', fakeServer({ password: 'x' }));
    assert.ok(p.ok && /sign in again/.test(p.warnings[0]), 'a different admin password only warns');
    const hang = async (url, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort',
        () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }));
    p = await move.preflight('https://spare.onrender.com', KEY, null, hang, 50);
    assert.ok(!p.ok && /timed out/.test(p.error), 'a host that never answers times out');
    // Headers, then a body that never comes: the same deadline covers it.
    const stall = async (url, opts) => ({ ok: true, status: 200, json: () => new Promise((_, rej) =>
        opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); })) });
    p = await move.preflight('https://spare.onrender.com', KEY, null, stall, 50);
    assert.ok(!p.ok && /timed out/.test(p.error), 'a body that never arrives times out too');
    // The same server under another name.
    const selfish = async (url) => ({ ok: true, status: 200, json: async () => ({ globalForwarding: true, serverId: 'me' }) });
    p = await move.preflight('https://alias.onrender.com', KEY, null, selfish, 1000, 'me');
    assert.ok(!p.ok && /is this server/.test(p.error), 'moving to itself is refused');
    // A move left running is dropped after 7 days (it silences alerts here).
    move.set('https://spare.onrender.com', 1, null, 'admin');
    assert.ok(move.forDevice('x', () => 'admin'), 'pending');
    assert.strictEqual(move.forDevice('x', () => 'admin', Date.now() + move.MAX_PENDING_MS + 1000), null, 'expired');
    move._reset();

    // ── setup: admin, a user, three phones ───────────────────────
    const admin = (await req('POST', '/api/login', { body: { password: 'admin-pw' } })).body.token;
    const created = (await req('POST', '/api/users', { token: admin, body: { name: 'Rahim' } })).body;
    assert.ok(created && created.enrollCode, 'user created');
    const reg = id => req('POST', '/api/register', { apiKey: KEY, body: { deviceId: id, model: 'M-' + id, installId: id,
        appVersion: '4.38.0', sims: [], canSendSms: true } });
    const A = 'a1a1a1a1a1a1a1a1', B = 'b2b2b2b2b2b2b2b2';
    await reg(A); await reg(B);
    await req('POST', `/api/devices/${A}/assign`, { token: admin, body: { userId: 'rahim' } });
    // No allowed-hosts list: a move is refused outright — the check would send
    // this server's API key and admin password to whatever host was typed.
    let r0 = await req('POST', '/api/set-url', { token: admin, body: { url: 'https://spare.onrender.com' } });
    assert.strictEqual(r0.status, 400);
    assert.match(r0.body.error, /allowed hosts/);
    await req('POST', '/api/allowed-hosts', { token: admin, body: { hosts: ['spare.onrender.com'] } });
    const poll = id => req('GET', `/api/settings?deviceId=${id}`, { apiKey: KEY });
    assert.strictEqual((await poll(A)).body.moveCarrier, true, 'the poll says it carries moves (the app then treats a push as a signal)');

    assert.strictEqual((await poll(A)).body.moveTo, undefined, 'no move pending: no moveTo (older apps see nothing new)');

    // ── 3a. a refused preflight moves nobody ─────────────────────
    const realPreflight = move.preflight;
    move.preflight = async () => ({ ok: false, error: 'spare.onrender.com refused this server\'s API key', warnings: [] });
    let r = await req('POST', '/api/set-url', { token: admin, body: { url: 'https://spare.onrender.com' } });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /API key/);
    assert.ok(!pushes.some(x => x.action === 'set_url'), 'no push');
    assert.strictEqual((await poll(A)).body.moveTo, undefined, 'and nothing pending');

    // ── 2. pending move on every poll ────────────────────────────
    move.preflight = async () => ({ ok: true, warnings: [] });
    r = await req('POST', '/api/set-url', { token: admin, body: { url: 'https://spare.onrender.com' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const pushed = pushes.find(x => x.action === 'set_url');
    assert.ok(pushed && pushed.data.url === 'https://spare.onrender.com', 'pushed');
    let mA = (await poll(A)).body.moveTo, mB = (await poll(B)).body.moveTo;
    assert.deepStrictEqual(mA, { url: 'https://spare.onrender.com', ts: pushed.ts }, 'the poll carries the same move and ts as the push');
    assert.deepStrictEqual(mB, mA, 'to every phone');
    r = await req('GET', '/api/full-settings', { token: admin });
    assert.strictEqual(r.body.serverMove.url, 'https://spare.onrender.com', 'the dashboard sees the pending move');

    // ── 4. covered phones are not reported offline ───────────────
    alerts._reset();
    const t0 = Date.now();
    users.getDevice(A).lastSeen = t0; users.getDevice(B).lastSeen = t0;
    alerts.check(t0);
    alerts.check(t0 + 60 * 60_000);
    assert.ok(!alerts.recent().some(a => a.kind === 'offline'), 'moving phones going quiet here is not "offline"');

    // targeted move: only that user's phones
    move.preflight = async () => ({ ok: true, warnings: [] });
    r = await req('POST', '/api/set-url', { token: admin, body: { url: 'https://spare.onrender.com', target: 'rahim' } });
    assert.strictEqual(r.status, 200);
    mA = (await poll(A)).body.moveTo; mB = (await poll(B)).body.moveTo;
    assert.ok(mA && mA.url === 'https://spare.onrender.com', "rahim's phone moves");
    assert.strictEqual(mB, undefined, 'the unassigned phone does not');
    assert.ok(mA.ts > pushed.ts, 'a newer move has a newer ts (the app applies the newest)');

    // one move at a time
    let release;
    move.preflight = () => new Promise(res => { release = () => res({ ok: true, warnings: [] }); });
    const slow = req('POST', '/api/set-url', { token: admin, body: { url: 'https://spare.onrender.com' } });
    await sleep(100);
    r = await req('POST', '/api/set-url', { token: admin, body: { url: 'https://spare.onrender.com' } });
    assert.strictEqual(r.status, 409, 'a second move while one is being checked is refused');
    release();
    assert.strictEqual((await slow).status, 200);

    // ── 3b. cancel ───────────────────────────────────────────────
    r = await req('POST', '/api/set-url/cancel', { token: admin, body: {} });
    assert.ok(r.body.cancelled);
    assert.strictEqual((await poll(A)).body.moveTo, undefined, 'cancelled: no longer offered');
    move.preflight = realPreflight;

    // the allowlist is still checked first
    r = await req('POST', '/api/set-url', { token: admin, body: { url: 'https://elsewhere.example.com' } });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /allowed hosts/);

    console.log('ok — a move is checked before anyone moves, then rides every poll until cancelled, to all phones or one '
        + "user's, and moving phones are not reported offline");
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
