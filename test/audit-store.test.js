/**
 * test/audit-store.test.js — server 4.42.1, store findings of the full audit.
 *
 *   1. A config change saved WHILE the boot Firestore read is out is not undone
 *      when that (older) read lands — the "off that turns itself back on".
 *   2. A real OTP superseded by a code that later turns out not to exist (a
 *      promo the catch-all read as "2000") is LIVE again after the correction.
 *   3. A parked /get?wait= woken by a fetchable replay gets it, even when an
 *      aged-out consumed entry was still in the way.
 *   4. Auto-delete never removes a code before the OTP window ends.
 *
 * Run: node test/audit-store.test.js
 */
process.env.OTP_MAX_AGE_SECONDS = '5';
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.STATE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-astore-')), 's.json');

const store     = require('../lib/store');
const firestore = require('../lib/firestore');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    // ── 1. a save during the boot read wins ──────────────────────
    let stored = { filters: [{ phoneNumber: 'DEFAULT', patterns: ['OTP is (\\d{6})'] }],
                   globalForwarding: true, autoDeleteMinutes: 30 };
    firestore._setDbForTests({ collection: () => ({ doc: () => ({
        get: () => { const snap = JSON.parse(JSON.stringify(stored));
                     return new Promise(r => setTimeout(() => r({ exists: true, data: () => snap }), 800)); },
        set: async v => { stored = v; } }) }) });
    store.loadDurableConfig(0);
    await sleep(200);
    store.setGlobalForwarding(false);                       // the operator, mid-read
    await sleep(1200);
    assert.strictEqual(store.isForwardingEnabled(), false, 'the older read must not switch it back ON');
    assert.ok(store.isConfigReady(), 'and the config is still marked ready');
    // A read with no change in between is applied as before.
    await firestore.flushNow();                              // the save above reaches "Firestore"
    assert.strictEqual(stored.globalForwarding, false, 'the save during the read was written');
    stored = Object.assign({}, stored, { globalForwarding: true });     // changed elsewhere
    await store.reloadDurable();
    await sleep(1200);
    assert.strictEqual(store.isForwardingEnabled(), true, 'an undisturbed read still applies');

    // ── 1b. ...but the OTHER fields still come from Firestore (review of 4.38.4):
    //        a toggle during a cold start must not keep the env catch-all filters.
    {
        const realFilters = [{ phoneNumber: 'IVAC', patterns: ['OTP is (\\d{6})'] }];
        // Memory holds a catch-all that was never saved here (as on a cold
        // start, from the env) — it reaches memory through a read, not a save.
        stored = { filters: [{ phoneNumber: 'DEFAULT', patterns: ['(\\d{4,8})'] }], globalForwarding: true,
                   autoDeleteMinutes: 30, updatedAt: Date.now() };
        await store.reloadDurable(); await sleep(1000);
        assert.strictEqual(store.getSettings().filters[0].phoneNumber, 'DEFAULT', 'precondition: catch-all in memory');
        // Firestore has the real filters, written before the toggle below.
        stored = { filters: realFilters, globalForwarding: true, autoDeleteMinutes: 30, updatedAt: Date.now() - 500 };
        const p1 = store.reloadDurable();
        await sleep(100);
        store.setGlobalForwarding(false);        // the operator, during the read
        await p1; await sleep(1200);
        assert.strictEqual(store.isForwardingEnabled(), false, 'the toggle stands');
        assert.strictEqual(JSON.stringify(store.getSettings().filters.map(f => f.phoneNumber)), '["IVAC"]',
                           'the saved filters still come from Firestore: ' + JSON.stringify(store.getSettings().filters));
        await firestore.flushNow();
        assert.strictEqual(stored.globalForwarding, false, 'the merged config is written…');
        assert.deepStrictEqual(stored.filters.map(f => f.phoneNumber), ['IVAC'], '…with the real filters, not the catch-all');
    }

    // ── 1c. a RETRY read that starts after a save, before its write lands ──
    {
        let fail = true;
        stored = { filters: [{ phoneNumber: 'IVAC', patterns: ['OTP is (\\d{6})'] }], globalForwarding: true,
                   autoDeleteMinutes: 30, updatedAt: Date.now() - 60_000 };
        firestore._setDbForTests({ collection: () => ({ doc: () => ({
            get: () => fail ? (fail = false, Promise.reject(new Error('cold'))) :
                new Promise(r => setTimeout(() => r({ exists: true, data: () => JSON.parse(JSON.stringify(stored)) }), 50)),
            set: async () => { /* the debounced write has not landed yet */ } }) }) });
        await store.reloadDurable();
        store.setGlobalForwarding(false);
        await sleep(2500);                       // the retry read (2 s) lands, the doc still says true
        assert.strictEqual(store.isForwardingEnabled(), false, 'a read of an OLDER document never undoes the toggle');
        firestore._setDbForTests({ collection: () => ({ doc: () => ({
            get: () => Promise.resolve({ exists: true, data: () => JSON.parse(JSON.stringify(stored)) }),
            set: async v => { stored = v; } }) }) });
        await firestore.flushNow();
    }

    // ── 2. a superseded real OTP comes back ──────────────────────
    store.setFilters([{ phoneNumber: 'DEFAULT', patterns: ['(\\d{4,8})'] }]);     // a catch-all
    const N = '01733333333';
    store.addSms('IVAC', N, 'Your OTP is 445566', Date.now(), 'd1');
    store.addSms('Shop', N, 'Tk 2000 paid', Date.now(), 'd1');          // "2000" supersedes it
    store.setFilters([{ phoneNumber: 'DEFAULT', patterns: ['OTP is (\\d{6})'] }]);
    assert.strictEqual(store.getOtp(N), '445566', 'the real OTP is live again after the correction');
    assert.strictEqual(store.getOtp(N), null, 'and is consumed once, as always');
    // ...but only what THAT code superseded: an OTP replaced by a real newer one stays replaced.
    const M = '01744444444';
    store.addSms('IVAC', M, 'Your OTP is 111111', Date.now(), 'd1');
    store.addSms('IVAC', M, 'Your OTP is 222222', Date.now(), 'd1');
    store.setFilters([{ phoneNumber: 'DEFAULT', patterns: ['OTP is (\\d{6})', 'never(\\d)'] }]);
    assert.strictEqual(store.getOtp(M), '222222', 'a real newer code still wins');
    assert.strictEqual(store.getOtp(M), null);

    // ── 4. auto-delete never cuts the OTP window ────────────────
    store.setAutoDeleteMinutes && store.setAutoDeleteMinutes(1);
    const r4 = store.addSms('IVAC', '01755555555', 'Your OTP is 777777', Date.now(), 'd1');
    const s4 = store.getAllSms().find(s => s.id === r4.id);
    assert.ok(s4.deleteAt - s4.receivedAt >= 5000, 'deleteAt is never before the OTP window ends');

    // ── 3. a woken waiter falls through to the fallback ─────────
    const W = '01722222222', T0 = Date.now();
    store.addSms('IVAC', W, 'Your OTP is 111111', T0, 'dW');
    assert.strictEqual(store.getOtp(W), '111111');
    // (2b, sharing the wait below) a superseded OTP whose window has CLOSED
    // is not brought back by a later correction.
    const X = '01766666666';
    store.setFilters([{ phoneNumber: 'DEFAULT', patterns: ['(\\d{4,8})'] }]);
    store.addSms('IVAC', X, 'Your OTP is 445566', Date.now(), 'dX');
    store.addSms('Shop', X, 'Tk 2000 paid', Date.now(), 'dX');
    await sleep(6000);                                   // the consumed entry ages out (5 s window)
    store.setFilters([{ phoneNumber: 'DEFAULT', patterns: ['OTP is (\\d{6})'] }]);
    assert.strictEqual(store.getOtp(X), null, 'an OTP past its window stays finished');
    assert.strictEqual(store.getAllSms().find(m => m.recipient === X && m.sender === 'IVAC').status,
                       'superseded', 'and keeps its outcome');
    const p = store.waitForOtp(W, 1500);
    store.addSms('IVAC', W, 'Your OTP is 222222', T0 + 500, 'dW');   // a stale replay, fetchable as fallback
    assert.strictEqual(await p, '222222', 'the waiter gets what a plain /get would');

    // ── 4b. with a long OTP window, a 1-minute auto-delete waits for it ──
    const { spawnSync } = require('child_process');
    const child = spawnSync(process.execPath, ['-e', `
        const store = require(${JSON.stringify(path.join(__dirname, '../lib/store'))});
        store.setAutoDeleteMinutes(1);
        const r = store.addSms('IVAC', '01755555555', 'Your OTP is 777777', Date.now(), 'd1');
        const s = store.getAllSms().find(x => x.id === r.id);
        process.exit(s.deleteAt - s.receivedAt >= 600000 ? 0 : 3);`],
        { env: Object.assign({}, process.env, { OTP_MAX_AGE_SECONDS: '600' }), encoding: 'utf8' });
    assert.strictEqual(child.status, 0, 'auto-delete of 1 min must wait for a 600 s OTP window: ' + child.stderr);

    console.log('ok — a save during the boot read stands, a wrongly superseded OTP comes back, '
        + 'a woken waiter finds the fallback, and auto-delete never cuts a live code');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
