/**
 * test/config-isolation.test.js — identity writes may never touch the config.
 *
 * =============================================================================
 * THE BUG THIS FILE EXISTS FOR
 *
 * persistState() wrote the local state file AND pushed the in-memory config to
 * Firestore, unconditionally. loadIdentity() then wired that same function in as
 * the IDENTITY persister — so every markDirty() pushed config too, and
 * registerDevice() calls markDirty() on every phone's every process start.
 *
 * The chain that destroyed real filter sets:
 *
 *   fresh container (redeploy / free-tier spin-up, so no state file)
 *     -> the Firestore config read times out
 *     -> the guards correctly keep the env CATCH-ALL and refuse to migrate,
 *        logging "your saved config in Firestore is untouched"
 *     -> a phone registers itself two seconds later
 *     -> the catch-all is written over the operator's real filters
 *     -> the retry chain reads back the catch-all it just wrote.
 *
 * Silent, permanent, and triggered by a phone rebooting. The migration guard
 * could not see it because it arrived through the identity door, not the
 * migration door.
 *
 * So the assertion is mechanical and counts writes PER DOCUMENT: an identity
 * change writes the identity document and nothing else. And — the other half,
 * because a fix that just stops writing would be worse than the bug — an
 * operator's real save must still reach Firestore.
 * =============================================================================
 *
 * Run: node test/config-isolation.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { spawnSync } = require('child_process');

const LIB = path.join(__dirname, '..', 'lib');

/**
 * A Firestore stand-in that counts writes SEPARATELY per document id, which is
 * the whole point: the old bug wrote the right document and the wrong one.
 *
 * @param opts.configReadThrows simulate the cold-start read failure
 * @param opts.storedConfig     what the operator has saved in Firestore
 */
function fakeDb(opts) {
    opts = opts || {};
    const writes = { config: 0, identity: 0 };
    const stored = { config: opts.storedConfig || null, identity: { users: [], devices: [] } };
    return {
        writes, stored,
        collection() {
            return {
                doc: (id) => ({
                    get: async () => {
                        if (id === 'config' && opts.configReadThrows) {
                            throw new Error('4 DEADLINE_EXCEEDED: simulated cold-start timeout');
                        }
                        return { exists: !!stored[id], data: () => stored[id] };
                    },
                    set: async (value) => { writes[id]++; stored[id] = value; }
                })
            };
        },
        batch: () => ({ set() {}, delete() {}, commit: async () => {} })
    };
}

/**
 * Run a scenario in a FRESH process.
 *
 * store.js reads the state file and builds `settings` at require time, so the
 * cold-start case only exists before that module has ever been loaded. A test
 * that reuses this process would be testing a warm restart and would have
 * passed against the broken code.
 */
function run(body) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-iso-'));
    const code = `
const assert = require('assert');
const firestore = require(${JSON.stringify(path.join(LIB, 'firestore.js'))});
const mkDb = ${fakeDb.toString()};
${body}
`;
    const r = spawnSync(process.execPath, ['-e', code], {
        encoding: 'utf8',
        env: Object.assign({}, process.env, {
            FIRESTORE_ENABLED: 'true',
            USERS_ENABLED:     'true',
            // A path that does not exist: this IS the fresh container.
            STATE_FILE:        path.join(dir, 'state.json'),
            OTP_PATTERNS:      '',          // -> the catch-all default
            HISTORY_ENABLED:   'false'
        })
    });
    if (r.status !== 0) {
        console.error(r.stdout);
        console.error(r.stderr);
        assert.fail('scenario exited ' + r.status);
    }
    return r.stdout;
}

const REAL_FILTERS = [{ phoneNumber: 'IVAC', patterns: ['OTP is ([0-9]{6})'] }];

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE ORIGINAL BUG, EXACTLY.
//
// Config read fails, identity read succeeds, a phone registers itself. The
// operator's filters must still be in Firestore afterwards.
// ─────────────────────────────────────────────────────────────────────────────
run(`
const db = mkDb({ configReadThrows: true,
                  storedConfig: { filters: ${JSON.stringify(REAL_FILTERS)},
                                  globalForwarding: true, autoDeleteMinutes: 30 } });
firestore._setDbForTests(db);

const store = require(${JSON.stringify(path.join(LIB, 'store.js'))});
store.loadDurableConfig();
store.loadIdentity();

setTimeout(() => {
    // The server is running on the env catch-all, correctly — the read failed
    // and the guards refused to migrate.
    const running = store.getSettings().filters;
    assert.strictEqual(running[0].phoneNumber, 'DEFAULT',
        'precondition: the failed read leaves the catch-all running');

    // A phone announces itself. No operator involved; this happens on every
    // process start of every device.
    store.users.registerDevice('a1b2c3d4e5f60718', { model: 'Galaxy A14' });

    setTimeout(() => {
        assert.strictEqual(db.writes.config, 0,
            'a device registration must not write the config document — it did, '
            + 'and it wrote the catch-all over the operator saved filters');
        assert.ok(db.writes.identity > 0,
            'the identity document itself must still be saved');
        assert.deepStrictEqual(db.stored.config.filters, ${JSON.stringify(REAL_FILTERS)},
            'the operator saved filters must be untouched in Firestore — which is '
            + 'what the log line at boot already promised');
        process.exit(0);
    }, 3000);
}, 300);
`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE SAME ISOLATION ON THE HEALTHY PATH.
//
// Nothing failed, the real config loaded. An identity change still has no
// business rewriting it — one write per fact.
// ─────────────────────────────────────────────────────────────────────────────
run(`
const db = mkDb({ storedConfig: { filters: ${JSON.stringify(REAL_FILTERS)},
                                  globalForwarding: true, autoDeleteMinutes: 30 } });
firestore._setDbForTests(db);

const store = require(${JSON.stringify(path.join(LIB, 'store.js'))});
store.loadDurableConfig();
store.loadIdentity();

setTimeout(() => {
    assert.strictEqual(store.getSettings().filters[0].phoneNumber, 'IVAC',
        'precondition: the real config loaded');

    store.users.registerDevice('00112233445566aa', { model: 'Pixel 6' });
    store.users.createUser('Rahim');

    setTimeout(() => {
        assert.strictEqual(db.writes.config, 0,
            'identity changes must not rewrite the config document even when '
            + 'the config in memory is correct — one write per fact');
        assert.ok(db.writes.identity > 0, 'identity is saved');
        process.exit(0);
    }, 3000);
}, 300);
`);

// ─────────────────────────────────────────────────────────────────────────────
// 3. AND THE REAL SAVE PATH STILL WORKS.
//
// The failure mode of an over-eager fix is a config that never persists at all,
// which is the same data loss with a different cause. An operator's save must
// still reach Firestore — including DURING an outage, because then it is an
// explicit instruction rather than a stale value drifting upwards.
// ─────────────────────────────────────────────────────────────────────────────
run(`
const db = mkDb({ configReadThrows: true });
firestore._setDbForTests(db);

const store = require(${JSON.stringify(path.join(LIB, 'store.js'))});
store.loadDurableConfig();
store.loadIdentity();

setTimeout(() => {
    store.setFilters([{ phoneNumber: 'bKash', patterns: ['code ([0-9]{6})'] }]);
    store.setGlobalForwarding(false);

    setTimeout(() => {
        assert.ok(db.writes.config > 0,
            'an operator save must still push to Firestore — a fix that silenced '
            + 'this would be the same data loss from the other direction');
        assert.strictEqual(db.stored.config.filters[0].phoneNumber, 'bKash',
            'and it must be what they actually saved');
        assert.strictEqual(store.configStatus().source, 'dashboard',
            'a real save is what may report the source as "dashboard"');
        process.exit(0);
    }, 3000);
}, 300);
`);

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE DIAGNOSTIC MUST NOT LIE.
//
// configSource answers "why is it using the catch-all?". persistState set it to
// 'dashboard' unconditionally, so the first phone to register made the dashboard
// claim the running config came from a save that never happened — turning the
// one readout built for this failure into a witness for the wrong answer.
// ─────────────────────────────────────────────────────────────────────────────
run(`
const db = mkDb({ configReadThrows: true });
firestore._setDbForTests(db);

const store = require(${JSON.stringify(path.join(LIB, 'store.js'))});
store.loadDurableConfig();
store.loadIdentity();

setTimeout(() => {
    store.users.registerDevice('deadbeefdeadbeef', { model: 'A14' });
    setTimeout(() => {
        assert.strictEqual(store.configStatus().source, 'env defaults',
            'a device registration must not make the dashboard claim the config '
            + 'came from a dashboard save');
        process.exit(0);
    }, 500);
}, 300);
`);

console.log('ok — an identity change writes identity and nothing else: a registering '
    + 'phone can no longer push the cold-start catch-all over saved filters, real '
    + 'saves still persist, and configSource stops claiming a save that never happened');
