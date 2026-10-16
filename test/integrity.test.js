/**
 * test/integrity.test.js — the 4.37.0 findings, pinned.
 *
 * Every case here served a WRONG or MISSING code before 4.37.0, or reported
 * something the system was not doing. Each assertion names the failure it
 * guards against, because a regression here costs a real booking.
 *
 * Run: node test/integrity.test.js
 */

const assert = require('assert');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

process.env.DASHBOARD_PASSWORD   = 'admin-pw';
process.env.API_KEY              = 'test-key';
process.env.HISTORY_ENABLED      = 'true';
process.env.FIRESTORE_ENABLED    = 'true';
process.env.FIREBASE_SERVICE_ACCOUNT = '{"stub":true}';
process.env.OTP_PATTERNS         = '(\\d{4,8})';
process.env.OTP_MAX_AGE_SECONDS  = '120';
process.env.STATE_FILE           = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-int-')), 'state.json');
process.env.PORT                 = '3993';

// ── Firestore stub: a config read we can hold open, plus an archive ─────────
const firestore = require('../lib/firestore');
const archived = [];
let releaseConfig = null;
const REAL_FILTERS = [{ phoneNumber: 'DEFAULT',
                        patterns: ['\\bis\\s+(\\d{4,8})\\b', '(\\d{4,8})'] }];
firestore.init = function () {
    const docs = new Map();
    const query = () => {
        const q = {
            where: () => q, orderBy: () => q, limit: () => q,
            get: async () => ({
                empty: archived.length === 0, size: archived.length,
                forEach: (fn) => archived.forEach(r => fn({ data: () => r, ref: {} }))
            })
        };
        return q;
    };
    firestore._setDbForTests({
        batch: () => ({ set: (ref, v) => archived.push(v), delete: () => {}, commit: async () => {} }),
        collection: (c) => Object.assign(query(), {
            doc: (id) => ({
                // The config read is HELD until the test releases it: that is a
                // fresh container waiting on a cold Firestore connection.
                get: () => (c === 'getotp' && id === 'config')
                    ? new Promise(r => { releaseConfig = () =>
                          r({ exists: true, data: () => ({ filters: REAL_FILTERS }) }); })
                    : Promise.resolve({ exists: !!docs.get(c + '/' + id),
                                        data: () => docs.get(c + '/' + id) }),
                set: async (v) => { docs.set(c + '/' + id, v); }
            })
        })
    });
};

const history = require('../lib/history');
const store   = require('../lib/store');
const otp     = require('../lib/otp');
require('../server');

const PORT = 3993;
function req(method, p, { body, token, apiKey } = {}) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const headers = { 'Content-Type': 'application/json' };
        if (data) headers['Content-Length'] = Buffer.byteLength(data);
        if (token) headers.Authorization = 'Bearer ' + token;
        if (apiKey) headers['X-Api-Key'] = apiKey;
        const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers }, res => {
            let buf = '';
            res.on('data', c => buf += c);
            res.on('end', () => {
                let json = null; try { json = JSON.parse(buf); } catch (e) { /* not json */ }
                resolve({ status: res.statusCode, json });
            });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TEST = history.TEST_SENDER;
let n = 0;
const num = () => '0171' + String(1000000 + (++n)).slice(-7);   // a fresh number per case

(async () => {
    await sleep(150);

    // ═════════════════════════════════════════════════════════════════════
    // 1. COLD START — the held-back batch must obey "newest wins" and "stale
    //    never supersedes", exactly like a message on a warm server.
    //    Before: the OLDEST message in the batch won, and a replay took over.
    // ═════════════════════════════════════════════════════════════════════
    assert.strictEqual(store.isConfigReady(), false, 'fresh container: extraction is held');
    const c1 = num(), c2 = num(), c3 = num();
    const t0 = Date.now();
    store.addSms('IVAC', c1, 'Your OTP is 111111', t0, null, 'c1a');          // older
    store.addSms('IVAC', c1, 'Your OTP is 445566', t0, null, 'c1b');          // newer
    store.addSms('IVAC', c2, 'Your OTP is 222222', t0 - 4 * 60_000, null, 'c2r');   // replay FIRST
    store.addSms('IVAC', c2, 'Your OTP is 556677', t0, null, 'c2f');
    store.addSms('IVAC', c3, 'Your OTP is 667788', t0, null, 'c3f');
    store.addSms('IVAC', c3, 'Your OTP is 333333', t0 - 4 * 60_000, null, 'c3r');   // replay LAST
    // A script long-polling c1 through the cold start. It must be woken only
    // after the whole held-back batch is in — woken mid-batch it took 111111
    // and a plain /get then served 445566 as well (independent review, 4.37.0).
    const parkedC1 = store.waitForOtp(c1, 3000);
    releaseConfig();
    await sleep(50);
    assert.strictEqual(await parkedC1, '445566', 'a parked fetch gets the NEWER code of the batch');
    assert.strictEqual(store.getOtp(c1), null, 'and only one code is ever served for it');
    assert.strictEqual(store.getOtp(c2), '556677', 'a replay before a fresh code does not win');
    assert.strictEqual(store.getOtp(c3), '667788', 'a replay after a fresh code does not take over');

    // ═════════════════════════════════════════════════════════════════════
    // 2. TEST MESSAGES are the lowest priority.
    //    Before: Test on a number with a live IVAC code -> /get served the test.
    // ═════════════════════════════════════════════════════════════════════
    const t1 = num();
    store.addSms('IVAC', t1, 'Your IVAC OTP is 445566', Date.now(), null, 't1a');
    store.addSms(TEST, t1, 'Test OTP: 918273 (SIM 1)', Date.now(), null, 't1b');
    assert.strictEqual(store.getOtp(t1), '445566', 'Test must not displace a live real code');

    const t2 = num();
    store.addSms(TEST, t2, 'Test OTP: 918273 (SIM 1)', Date.now(), null, 't2a');
    assert.strictEqual(store.getOtp(t2), '918273', 'Test still proves the pipeline on an idle number');

    const t3 = num();
    store.addSms(TEST, t3, 'Test OTP: 918273 (SIM 1)', Date.now(), null, 't3a');
    store.addSms('IVAC', t3, 'Your OTP is 778899', Date.now(), null, 't3b');
    assert.strictEqual(store.getOtp(t3), '778899', 'any real SMS displaces a test');

    const t4 = num();
    store.addSms('IVAC', t4, 'Your OTP is 101010', Date.now(), null, 't4a');
    assert.strictEqual(store.getOtp(t4), '101010');
    store.addSms(TEST, t4, 'Test OTP: 121212 (SIM 1)', Date.now(), null, 't4b');
    assert.strictEqual(store.getOtp(t4), '121212', 'after the real code was SPENT, a test may run');

    // ═════════════════════════════════════════════════════════════════════
    // 3. SAME PHONE, EARLIER ARRIVAL — a re-push heard late never wins.
    //    The app's queue retry and Get Latest re-send messages the server may
    //    already have, under a msgId that may not match.
    // ═════════════════════════════════════════════════════════════════════
    const dev = 'aaaaaaaaaaaaaaaa', r1 = num();
    const a = Date.now() - 30_000, b = Date.now() - 5_000;
    store.addSms('IVAC', r1, 'Your OTP is 111222', a, dev, 'r1a');
    store.addSms('IVAC', r1, 'Your OTP is 333444', b, dev, 'r1b');
    store.addSms('IVAC', r1, 'Your OTP is 111222', a, dev, 'r1a-again');   // different msgId
    assert.strictEqual(store.getOtp(r1), '333444', 'an earlier SMS re-pushed late does not replace the later one');

    const r2 = num();
    store.addSms('IVAC', r2, 'Your OTP is 555666', b, dev, 'r2a');
    assert.strictEqual(store.getOtp(r2), '555666');
    store.addSms('IVAC', r2, 'Your OTP is 777888', a, dev, 'r2-old');
    assert.strictEqual(store.getOtp(r2), null, 'an older re-push cannot become fetchable after the newer code was spent');

    const r3 = num();
    store.addSms('IVAC', r3, 'Your OTP is 121314', b, 'bbbbbbbbbbbbbbbb', 'r3a');
    store.addSms('IVAC', r3, 'Your OTP is 151617', a, 'cccccccccccccccc', 'r3b');
    assert.strictEqual(store.getOtp(r3), '151617',
        'across DIFFERENT phones the device clocks are not comparable — arrival order rules');

    // ═════════════════════════════════════════════════════════════════════
    // 4. FILTER MATCHING — numbers are matched as numbers.
    // ═════════════════════════════════════════════════════════════════════
    const rules = [
        { phoneNumber: '16216', patterns: ['Rocket.*?(\\d{4,8})'] },
        { phoneNumber: '01799999999', patterns: ['SIM2 (\\d{4})'] },
        { phoneNumber: 'bKash', patterns: ['is (\\d{4,8})'] },
        { phoneNumber: 'DEFAULT', patterns: ['\\bis\\s+(\\d{4,8})\\b', '(\\d{4,8})'] }];
    assert.strictEqual(otp.extractCode('Your IVAC OTP is 445566', 'IVAC', '01716216555', rules), '445566',
        'a short-code rule must not claim a SIM whose number contains those digits');
    assert.strictEqual(otp.extractCode('Rocket OTP 556677', '16216', '01700000000', rules), '556677',
        'the short code itself still matches its sender');
    assert.strictEqual(otp.extractCode('Rocket OTP 556677', 'Rocket-16216', '01700000000', rules), '556677',
        'a whole digit run inside an alphanumeric sender still matches');
    assert.strictEqual(otp.extractCode('Your code is 123456', '01716216555', '01700000000', rules), '123456',
        'a phone-number sender that merely CONTAINS the digits is not claimed');
    assert.strictEqual(otp.extractCode('SIM2 4321 is 999999', 'IVAC', '+8801799999999', rules), '4321',
        'a per-SIM rule matches its SIM in any format');
    assert.strictEqual(otp.extractCode('SIM2 4321 is 999999', 'IVAC', '01799999990', rules), '999999',
        'and no other SIM');
    assert.strictEqual(otp.extractCode('Your code is 123456', 'BKASH-16247', '017', rules), '123456',
        'a lettered rule still claims a sender containing it');
    assert.strictEqual(otp.extractCode('আপনার OTP ৪৪৫৫৬৬', 'Robi', '017', rules), '445566',
        'Bengali digits are read');
    assert.strictEqual(otp.extractCode('কোড ৪৪৫৫৬৬ is ১২৩৪৫৬', 'X', '017', rules), '123456',
        'Bengali digits work with keyword patterns too');

    // The gateway aliases' sender scope uses the same rule.
    assert.strictEqual(store.senderMatches('16216', ['16216']), true);
    assert.strictEqual(store.senderMatches('Rocket-16216', ['16216']), true);
    assert.strictEqual(store.senderMatches('01716216555', ['16216']), false,
        '/rocket must not accept a phone-number sender that merely contains 16216');
    assert.strictEqual(store.senderMatches('bKash-16247', ['bkash']), true);
    assert.strictEqual(store.senderMatches('anything', []), true, 'unscoped still means any sender');

    // ═════════════════════════════════════════════════════════════════════
    // 5. THE END OF THE OTP WINDOW is reported when it happens, once.
    //    Before: "pending" for 30 minutes, archived as expired only at delete.
    // ═════════════════════════════════════════════════════════════════════
    const e1 = num();
    await history.drain(Date.now() + 5000);
    archived.length = 0;
    const archivedIds = async () => { await history.drain(Date.now() + 5000);
                                      return archived.map(r => r.smsId); };
    const ex = store.addSms('IVAC', e1, 'Your OTP is 909090', Date.now(), null, 'e1');
    const nc = store.addSms('Promo', e1, 'Big sale today!', Date.now(), null, 'e1b');
    const all = store._internals.smsMap;
    assert.strictEqual(store._finalizeExpired(Date.now()), 0, 'nothing finishes inside the window');
    const later = Date.now() + store.OTP_MAX_AGE_MS + 1000;
    store._finalizeExpired(later);
    assert.strictEqual(all.get(ex.id).status, 'expired', 'an unfetched code becomes expired');
    assert.strictEqual(all.get(nc.id).status, 'no_code', 'a message with no code becomes no_code');
    let ids = await archivedIds();
    assert.strictEqual(ids.filter(i => i === ex.id).length, 1, 'the expired one archived once');
    assert.strictEqual(ids.filter(i => i === nc.id).length, 1, 'the no-code one archived once');
    assert.strictEqual(archived.find(r => r.smsId === ex.id).outcome, 'expired');
    assert.strictEqual(archived.find(r => r.smsId === nc.id).outcome, 'no_code');
    store._finalizeExpired(later + 60_000);
    ids = await archivedIds();
    assert.strictEqual(ids.filter(i => i === ex.id || i === nc.id).length, 2, 'and never again');
    assert.strictEqual(store._internals.numberMap.has(e1), false, 'the live entry is gone with it');

    const tst = num();
    const tm = store.addSms(TEST, tst, 'Test OTP: 111999 (SIM 1)', Date.now(), null, 'tst');
    store._finalizeExpired(Date.now() + store.OTP_MAX_AGE_MS + 1000);
    ids = await archivedIds();
    assert.ok(!ids.includes(tm.id), 'test messages are still never archived');

    // ═════════════════════════════════════════════════════════════════════
    // 6. A FILTER FIX reaches the code that is already waiting — once, at save
    //    time, instead of re-running every regex on every fetch.
    // ═════════════════════════════════════════════════════════════════════
    const f1 = num();
    store.setFilters([{ phoneNumber: 'DEFAULT', patterns: ['Tk (\\d{4,8})'] }]);
    store.addSms('IVAC', f1, 'Tk 2000 paid. Your OTP is 445566.', Date.now(), null, 'f1');
    store.setFilters(REAL_FILTERS);
    assert.strictEqual(store.getOtp(f1), '445566', 'saving a corrected filter corrects the waiting code');

    // Same batch rule on the filter-save path, with a parked fetch.
    const f2 = num();
    store.setFilters([{ phoneNumber: 'DEFAULT', patterns: ['NOMATCH(\\d{4})'] }]);
    store.addSms('IVAC', f2, 'Your OTP is 111111', Date.now(), null, 'f2a');
    store.addSms('IVAC', f2, 'Your OTP is 445566', Date.now(), null, 'f2b');
    const parkedF2 = store.waitForOtp(f2, 3000);
    store.setFilters(REAL_FILTERS);
    assert.strictEqual(await parkedF2, '445566', 'a filter fix wakes a parked fetch with the newer code');
    assert.strictEqual(store.getOtp(f2), null, 'and only once');

    // ═════════════════════════════════════════════════════════════════════
    // 7. HTTP: fetch rate, serverTime, the API key, and stream scoping.
    // ═════════════════════════════════════════════════════════════════════
    archived.length = 0;
    const row = (outcome) => ({ outcome, receivedAt: Date.now(), smsId: String(Math.random()) });
    archived.push(row('fetched'), row('fetched'), row('expired'), row('superseded'),
                  row('no_code'), row('no_code'), row('cleared'));
    const login = await req('POST', '/api/login', { body: { password: 'admin-pw' } });
    const admin = login.json.token;
    const sum = await req('GET', '/api/history/summary?days=30', { token: admin });
    assert.strictEqual(sum.json.totals.cleared, 1, 'cleared has its own bucket');
    assert.strictEqual(sum.json.fetchRate, 50,
        'fetch rate = fetched / (fetched + expired + superseded): no_code and cleared are not misses');

    const set = await req('GET', '/api/settings?deviceId=dddddddddddddddd', { apiKey: 'test-key' });
    assert.ok(Math.abs(set.json.serverTime - Date.now()) < 5000, 'settings carry the server clock');
    const bad = await req('GET', '/api/settings', { apiKey: 'test-kez' });
    assert.strictEqual(bad.status, 401, 'a wrong key is still refused');
    const shortKey = await req('GET', '/api/settings', { apiKey: 'x' });
    assert.strictEqual(shortKey.status, 401, 'a different-length key is refused without throwing');

    const fs2 = await req('GET', '/api/full-settings', { token: admin });
    assert.strictEqual(fs2.json.otpMaxAgeSeconds, 120, 'the dashboard is told the real OTP window');

    console.log('ok — newest wins on every path, Test cannot destroy a live code, numbers match '
        + 'as numbers, Bengali digits are read, and the window end is reported when it happens');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
