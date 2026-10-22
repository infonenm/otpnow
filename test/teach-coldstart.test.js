/**
 * test/teach-coldstart.test.js — server 4.43.0: Teach never writes over the
 * saved config before it has loaded.
 *
 * Found by review: on a fresh container whose Firestore read was failing, the
 * running filters were the env catch-all; Teach added its rule to THAT and
 * wrote the whole set back — the saved rules and every taught example gone,
 * permanently. Teach must refuse until the saved config is known, and work
 * normally once it is.
 *
 * Run: node test/teach-coldstart.test.js
 */
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { spawnSync } = require('child_process');

const LIB = path.join(__dirname, '..', 'lib');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-teachcold-'));
const code = `
const firestore = require(${JSON.stringify(path.join(LIB, 'firestore.js'))});
const stored = { config: {
    filters: [{ phoneNumber: 'IVACBD', patterns: ['OTP is ([0-9]{6})'] }, { phoneNumber: 'bKash', patterns: ['code ([0-9]{6})'] }],
    globalForwarding: true, autoDeleteMinutes: 30,
    filterExamples: [{ rule: 'IVACBD', sender: 'IVACBD', message: 'Your OTP is 445566', code: '445566', at: 1 },
                     { rule: 'bKash', sender: 'bKash', message: 'code 123456', code: '123456', at: 2 }] } };
let fail = true, writes = 0;
firestore._setDbForTests({ collection() { return { doc: (id) => ({
    get: async () => { if (id === 'config' && fail) throw new Error('DEADLINE'); return { exists: !!stored[id], data: () => stored[id] }; },
    set: async (v, o) => { writes++; stored[id] = (o && o.merge) ? Object.assign({}, stored[id], v) : v; } }) }; },
    batch: () => ({ set() {}, delete() {}, commit: async () => {} }) });
const store = require(${JSON.stringify(path.join(LIB, 'store.js'))});
const teach = require(${JSON.stringify(path.join(LIB, 'teach.js'))});
store.loadDurableConfig();
setTimeout(async () => {
    console.log('READY_DURING=' + store.teachReady());
    let threw = false;
    try { store.setFilters([{ phoneNumber: 'IVACBD', patterns: ['@words'] }], []); } catch (e) { threw = true; }
    console.log('STORE_REFUSED=' + threw);
    // A hand save during the outage must not erase the saved examples either.
    store.setFilters([{ phoneNumber: 'DEFAULT', patterns: ['(\\\\d{4,8})'] }]);
    await new Promise(r => setTimeout(r, 1500));
    console.log('EXAMPLES_KEPT=' + (stored.config.filterExamples || []).length);
    fail = false;
    await store.reloadDurable();
    await new Promise(r => setTimeout(r, 300));
    console.log('READY_AFTER=' + store.teachReady());
    process.exit(0);
}, 3500);
`;
const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: Object.assign({}, process.env, {
    FIRESTORE_ENABLED: 'true', USERS_ENABLED: 'false', HISTORY_ENABLED: 'false',
    STATE_FILE: path.join(dir, 'state.json'), OTP_PATTERNS: '' }) });
const out = r.stdout;
assert.ok(/READY_DURING=false/.test(out), 'Teach is off while the saved config is unknown: ' + out + r.stderr);
assert.ok(/STORE_REFUSED=true/.test(out), 'the store refuses a Teach write too');
assert.ok(/EXAMPLES_KEPT=2/.test(out), 'a hand save during the outage keeps the saved examples (merge write)');
assert.ok(/READY_AFTER=true/.test(out), 'and Teach works once the saved config has loaded');
console.log('ok — Teach waits for the saved config; an outage save never erases taught examples');
