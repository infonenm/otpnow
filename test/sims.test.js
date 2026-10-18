/**
 * test/sims.test.js — server 4.40.0: the phone reports its SIM 1 / SIM 2.
 *
 * What must hold:
 *   1. A report is stored per slot, CANONICAL (01XXXXXXXXX), and REPLACES the
 *      previous one — a new number overwrites, an empty one clears.
 *   2. ABSENT is not EMPTY: an older app sends no `sims` and keeps what is stored.
 *   3. Anything that is not a BD mobile number is stored as '' — the field is
 *      reachable with the API key, which ships in the APK.
 *   4. A SIM swap the phone reports is logged and stays "unconfirmed" until a
 *      number is saved; the log keeps the last SIM_LOG_MAX changes.
 *   5. An identical re-report writes nothing (phones register on every start).
 *   6. One number on two devices is flagged on both — reported or fallback.
 *   7. It survives snapshot/load, a bad stored document is cleaned, and a report
 *      heard while running from the cache is not lost when Firestore loads.
 *   8. /api/register accepts it, /api/devices shows it, the open panel is told,
 *      and a removed device cannot report.
 *
 * Run: node test/sims.test.js
 */
const assert = require('assert');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

process.env.DASHBOARD_PASSWORD = 'admin-pw';
process.env.API_KEY            = 'test-key';
process.env.USERS_ENABLED      = 'true';
process.env.OTP_PATTERNS       = '(\\d{4,8})';
process.env.STATE_FILE         = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-sims-')), 's.json');
process.env.PORT               = '3996';

const fcm = require('../lib/fcm');
fcm.send = async () => {};

const users = require('../lib/users');
const store = require('../lib/store');
require('../server.js');

let devicesChanged = 0;
store.notifyDevicesChanged = () => { devicesChanged++; };

function req(method, p, { body, token, apiKey } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json';
                    headers['Content-Length'] = Buffer.byteLength(data); }
        if (token)  headers.Authorization = 'Bearer ' + token;
        if (apiKey) headers['X-Api-Key'] = apiKey;
        const r = http.request({ host: '127.0.0.1', port: 3996, method, path: p, headers }, res => {
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

const sim = (slot, number, extra) => Object.assign({ slot, number, source: number ? 'manual' : '',
                                                     unconfirmed: false, changedAt: 0, changedFrom: '' }, extra || {});
const register = (deviceId, sims, extra) => req('POST', '/api/register', {
    apiKey: 'test-key',
    body: Object.assign({ deviceId, model: 'Galaxy A14', installId: 'aaaaaaaaaaaaaaaa' },
                        sims === undefined ? {} : { sims }, extra || {})
});

(async () => {
    await sleep(300);
    const admin = (await req('POST', '/api/login', { body: { password: 'admin-pw' } })).body.token;
    const devicesNow = async () => (await req('GET', '/api/devices', { token: admin })).body.devices;
    const dev = async id => (await devicesNow()).find(d => d.id === id);

    const A = 'a1a1a1a1a1a1a1a1', B = 'b2b2b2b2b2b2b2b2';

    // ── 1. stored canonical, per slot ─────────────────────────────
    let r = await register(A, [sim(1, '+8801711111111'), sim(2, '8801822222222', { source: 'auto' })]);
    assert.strictEqual(r.status, 200);
    let d = await dev(A);
    assert.deepStrictEqual(d.sims.map(s => s.number), ['01711111111', '01822222222'],
        'numbers are stored canonical, whatever form the phone sent');
    assert.deepStrictEqual(d.sims.map(s => s.source), ['manual', 'auto']);
    assert.strictEqual(d.simLog.length, 0, 'the first report is the starting point, not a change');
    assert.strictEqual(devicesChanged, 1, 'the open panel is told');

    // ── 5. identical re-report: no change, no push, no write ─────
    const v = users.simsVersion();
    let writes = 0;
    users.setPersister(() => { writes++; });
    await register(A, [sim(1, '01711111111'), sim(2, '01822222222', { source: 'auto' })]);
    assert.strictEqual(users.simsVersion(), v, 'an identical report is not a change');
    assert.strictEqual(writes, 0, 'a phone re-registering with the same SIMs writes nothing');
    assert.strictEqual(devicesChanged, 1);

    // ── 2. absent keeps; a non-list keeps ─────────────────────────
    await register(A, undefined);
    await register(A, undefined, { sims: 'nonsense' });
    d = await dev(A);
    assert.deepStrictEqual(d.sims.map(s => s.number), ['01711111111', '01822222222'],
        'an older app (no sims key) or a malformed one must not erase what is stored');
    // The same rule one layer in: server.js filters non-lists, and users.js
    // must not depend on that — a second caller would not know to.
    assert.strictEqual(users.normalizeSimReport(undefined), null);
    assert.strictEqual(users.normalizeSimReport('nonsense'), null);
    users.registerDevice(A, { sims: 'nonsense', installId: 'aaaaaaaaaaaaaaaa' });
    users.registerDevice(A, { sims: null, installId: 'aaaaaaaaaaaaaaaa' });
    assert.deepStrictEqual(users.getDevice(A).sims.map(s => s.number), ['01711111111', '01822222222'],
        'registerDevice itself keeps what is stored when the report is not a list');

    // ── 1. a new number REPLACES; an empty one clears ─────────────
    await register(A, [sim(1, '01733333333'), sim(2, '01822222222', { source: 'auto' })]);
    d = await dev(A);
    assert.strictEqual(d.sims[0].number, '01733333333');
    assert.strictEqual(d.simLog[0].event, 'changed');
    assert.strictEqual(d.simLog[0].from, '01711111111');
    assert.strictEqual(d.simLog[0].to, '01733333333');
    assert.ok(writes > 0, 'a real change is persisted');

    await register(A, [sim(1, '01733333333'), sim(2, '')]);
    d = await dev(A);
    assert.strictEqual(d.sims[1].number, '');
    assert.strictEqual(d.sims[1].source, '', 'an empty slot has no source');
    assert.strictEqual(d.simLog[0].event, 'cleared');
    assert.strictEqual(d.simLog[0].slot, 2);

    // ── 3. hostile / invalid numbers are never stored ─────────────
    await register(A, [sim(1, '"><img src=x onerror=alert(1)>'), sim(2, '12345'),
                       { slot: 7, number: '01999999999' }, null, 'x']);
    d = await dev(A);
    assert.deepStrictEqual(d.sims.map(s => s.number), ['', ''],
        'only a BD mobile number is ever stored; a bad slot is ignored');
    assert.strictEqual(d.sims.length, 2, 'always exactly two slots');

    // ── 4. SIM swap: unconfirmed until a number is saved ──────────
    await register(A, [sim(1, '01744444444'), sim(2, '')]);
    const swapAt = Date.now() - 60_000;
    await register(A, [sim(1, '', { unconfirmed: true, changedAt: swapAt, changedFrom: '01744444444' }),
                       sim(2, '')]);
    d = await dev(A);
    assert.strictEqual(d.sims[0].unconfirmed, true);
    assert.strictEqual(d.sims[0].changedAt, swapAt, "the phone's own time of the swap is kept");
    assert.strictEqual(d.sims[0].changedFrom, '01744444444');
    assert.strictEqual(d.simLog[0].event, 'sim_changed');
    assert.strictEqual(d.simLog[0].from, '01744444444');

    // Saving the new number confirms it — logged as a set, marked confirmed.
    await register(A, [sim(1, '01755555555'), sim(2, '')]);
    d = await dev(A);
    assert.strictEqual(d.sims[0].unconfirmed, false);
    assert.strictEqual(d.simLog[0].event, 'set');
    assert.strictEqual(d.simLog[0].confirmed, true);

    // A swap where the SIM DOES expose a number: unconfirmed with a number.
    await register(A, [sim(1, '01766666666', { source: 'auto', unconfirmed: true,
                                               changedAt: Date.now(), changedFrom: '01755555555' }), sim(2, '')]);
    d = await dev(A);
    assert.strictEqual(d.sims[0].number, '01766666666');
    assert.strictEqual(d.sims[0].unconfirmed, true, 'a detected number is still unconfirmed until saved');
    // ...and saving that same number confirms without a number change.
    await register(A, [sim(1, '01766666666'), sim(2, '')]);
    d = await dev(A);
    assert.strictEqual(d.simLog[0].event, 'confirmed');

    // An implausible phone clock is not believed.
    await register(A, [sim(1, '01766666666'), sim(2, '01877777777', { unconfirmed: true, changedAt: 5 })]);
    d = await dev(A);
    assert.ok(Math.abs(d.sims[1].changedAt - Date.now()) < 10_000, 'a 1970 timestamp becomes "now"');
    assert.strictEqual(d.sims[1].changedFrom, '', 'changedFrom only when the phone says');

    // Only unconfirmed slots carry a change time.
    await register(A, [sim(1, '01766666666', { changedAt: 12345678 }), sim(2, '01877777777')]);
    d = await dev(A);
    assert.strictEqual(d.sims[0].changedAt, 0);

    // ── 4. the log is capped ──────────────────────────────────────
    for (let i = 0; i < 15; i++) {
        await register(A, [sim(1, '0171' + String(1000000 + i)), sim(2, '01877777777')]);
    }
    d = await dev(A);
    assert.strictEqual(d.simLog.length, users.SIM_LOG_MAX, 'the change log keeps only the newest entries');
    assert.strictEqual(d.simLog[0].to, '01711000014', 'newest first');

    // ── 6. one number on two devices is flagged on both ───────────
    await register(B, [sim(1, '01877777777'), sim(2, '')], { installId: 'bbbbbbbbbbbbbbbb' });
    const all = await devicesNow();
    const a = all.find(x => x.id === A), b = all.find(x => x.id === B);
    assert.strictEqual(a.simConflicts.length, 1);
    assert.strictEqual(a.simConflicts[0].number, '01877777777');
    assert.strictEqual(a.simConflicts[0].devices[0].id, B);
    assert.strictEqual(b.simConflicts[0].devices[0].id, A);
    assert.strictEqual(b.simConflicts[0].devices[0].slot, 2);

    // The admin's fallback number counts too.
    await register(B, [sim(1, '01899999999'), sim(2, '')], { installId: 'bbbbbbbbbbbbbbbb' });
    users.setDeviceSim(A, '01899999999');
    const bb = await dev(B);
    assert.strictEqual(bb.simConflicts[0].devices[0].slot, 0, 'slot 0 = the fallback number');
    users.setDeviceSim(A, '');
    assert.strictEqual((await dev(B)).simConflicts.length, 0);

    // ── 8. a removed device cannot report ─────────────────────────
    const C = 'c3c3c3c3c3c3c3c3';
    await register(C, [sim(1, '01600000000'), sim(2, '')], { installId: 'cccccccccccccccc' });
    users.removeDevice(C);
    const before = users.simsVersion();
    r = await register(C, [sim(1, '01611111111'), sim(2, '')], { installId: 'cccccccccccccccc' });
    assert.strictEqual(r.body.revoked, true);
    assert.strictEqual(users.simsVersion(), before, 'a removed device changes nothing');

    // ── 7. snapshot -> load keeps it; bad stored data is cleaned ──
    const snap = users.snapshot();
    const stored = snap.devices.find(x => x.id === A);
    assert.strictEqual(stored.sims.length, 2, 'reported SIMs are persisted');
    assert.strictEqual(stored.simLog.length, users.SIM_LOG_MAX);
    users.load(JSON.parse(JSON.stringify(snap)));
    d = users.getDevice(A);
    assert.deepStrictEqual(d.sims.map(s => s.number), ['01711000014', '01877777777']);
    assert.strictEqual(d.simLog.length, users.SIM_LOG_MAX);

    users.load({ devices: [
        { id: 'dddddddddddddddd', name: 'Old', sims: [{ slot: 1, number: '<b>x</b>' }, { slot: 9 }],
          simLog: [{ event: 'hack', slot: 1 }, { event: 'set', slot: 1, to: '017', at: 1 },
                   { event: 'changed', slot: 2, from: '01711111111', to: '01722222222', at: 2 }] },
        { id: 'eeeeeeeeeeeeeeee', name: 'Pre-4.40' }
    ]});
    d = users.getDevice('dddddddddddddddd');
    assert.deepStrictEqual(d.sims.map(s => s.number), ['', '']);
    assert.strictEqual(d.simLog.length, 2, 'an unknown event is dropped');
    assert.strictEqual(d.simLog[0].to, '', 'a malformed number in the log is blanked');
    assert.strictEqual(users.getDevice('eeeeeeeeeeeeeeee').sims, null,
        'a device that never reported is null, not two empty slots');

    // ── 7. a report heard from the cache survives the real load ───
    const storedDoc = { devices: [{ id: A, name: 'Phone A', sims: [sim(1, '01700000001'), sim(2, '')],
                                    simLog: [] }] };
    users.loadCache(JSON.parse(JSON.stringify(storedDoc)));
    assert.strictEqual(users.isLoaded(), false);
    users.registerDevice(A, { sims: [sim(1, '01700000002'), sim(2, '')] });
    writes = 0;
    users.load(JSON.parse(JSON.stringify(storedDoc)));        // Firestore: still the old SIM
    d = users.getDevice(A);
    assert.strictEqual(d.sims[0].number, '01700000002',
        'the live report outranks the older stored copy');
    assert.ok(writes > 0, 'and is written back');
    // A reload with nothing newer in memory does not write.
    writes = 0;
    users.load(users.snapshot());
    assert.strictEqual(writes, 0);

    console.log('ok — SIM 1/SIM 2 are stored canonical per device, replaced by each report, kept when an '
        + 'older app says nothing, swaps stay unconfirmed until saved and are logged, duplicates are '
        + 'flagged, hostile values are dropped, and a report survives restarts and the cache window');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
