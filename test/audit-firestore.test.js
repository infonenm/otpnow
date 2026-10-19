/**
 * test/audit-firestore.test.js — server 4.42.1, Firestore findings of the audit.
 *
 *   1. A write that TIMED OUT but still commits later must not land over a
 *      newer write: the newer value is what Firestore ends up holding.
 *   2. flushNow() returns only once a save made during the awaited write has
 *      been written too.
 *   3. Identity writes do not touch the config write status.
 *
 * Run: node test/audit-firestore.test.js
 */
process.env.FIRESTORE_TIMEOUT_MS = '600';
const assert = require('assert');
const fs = require('../lib/firestore');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    // ── 1. a late commit never wins over a newer one ────────────
    let stored = null, n = 0;
    fs._setDbForTests({ collection: () => ({ doc: () => ({ set: d => {
        const slow = n++ === 0;                       // first RPC: past the timeout, then commits
        return new Promise(r => setTimeout(() => { stored = d.filters; r(); }, slow ? 4000 : 50));
    } }) }) });
    fs.writeConfigNow({ filters: 'A' });
    await sleep(700);                                 // A has timed out (600 ms), still in flight
    fs.writeConfig({ filters: 'B' });
    await sleep(5000);                                // retry/debounce writes B; A commits at 4 s
    assert.strictEqual(stored, 'B', 'Firestore holds the newer value, not the late older one');
    assert.strictEqual(fs.getStatus().pendingWrite, false);

    // ── 2. flushNow waits for a save made during the awaited write ──
    const writes = [];
    fs._setDbForTests({ collection: () => ({ doc: () => ({ set: d => {
        writes.push(d.filters); return new Promise(r => setTimeout(r, 200));
    } }) }) });
    fs.writeConfig({ filters: 'C' });
    const p = fs.flushNow();
    await sleep(50);
    fs.writeConfig({ filters: 'D' });                 // during C's write
    await p;
    assert.deepStrictEqual(writes, ['C', 'D'], 'both written before flushNow returned');
    assert.strictEqual(fs.getStatus().pendingWrite, false);

    // ── 3. identity status is its own ───────────────────────────
    fs._setDbForTests({ collection: () => ({ doc: id => ({ set: () =>
        String(id).includes('config') || writes.length < 0 ? Promise.resolve()
            : Promise.reject(new Error('identity down')) }) }) });
    const before = fs.getStatus().lastWriteOk;
    fs.writeIdentity({ users: [], devices: [] });
    await fs.flushNow();
    const st = fs.getStatus();
    assert.strictEqual(st.identityWriteOk, false, 'the identity failure is recorded…');
    assert.strictEqual(st.lastWriteOk, before, '…without touching the config indicator');

    console.log('ok — a late commit never overwrites a newer write, flushNow waits for saves made meanwhile, '
        + 'identity writes keep their own status');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
