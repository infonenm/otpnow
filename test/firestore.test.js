/**
 * test/firestore.test.js — Phase 1: durable config, and the promise that it
 * never touches the path an OTP travels on.
 *
 * =============================================================================
 * THE ASSERTION THIS FILE EXISTS FOR
 *
 * Firebase RTDB was removed from this project because it sat on the message
 * path. Bringing Firestore back is only acceptable while it stays off that
 * path — and "stays off" has to be checked mechanically, not promised in a
 * comment, because the whole failure mode is that someone later adds one
 * innocuous read inside addSms and nobody notices until OTPs are slow.
 *
 * So: a counting stub replaces the Firestore client, a full /sms -> /get cycle
 * runs against it, and the call count must be ZERO.
 * =============================================================================
 *
 * Run: node test/firestore.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { spawnSync } = require('child_process');

const LIB = path.join(__dirname, '..', 'lib');

function tmpState() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-fs-')), 'state.json');
}

/**
 * A counting stand-in for the Firestore client.
 * Shaped exactly like the two calls lib/firestore.js makes: .collection().doc().get()
 * and .set().
 */
function fakeDb(opts) {
    opts = opts || {};
    const calls = { get: 0, set: 0 };
    const written = [];
    return {
        calls, written,
        collection() {
            return {
                doc: () => ({
                    get: async () => {
                        calls.get++;
                        if (opts.readThrows) throw new Error('simulated read failure');
                        if (opts.readHangs) return new Promise(() => {});   // never settles
                        return {
                            exists: !!opts.doc,
                            data: () => opts.doc
                        };
                    },
                    set: async (value) => {
                        calls.set++;
                        if (opts.writeThrows) throw new Error('simulated write failure');
                        written.push(value);
                    }
                })
            };
        }
    };
}

/** Run a snippet in a fresh process — load-time behaviour needs one. */
function run(env, code) {
    const r = spawnSync(process.execPath, ['-e', code], {
        env: Object.assign({}, process.env, env), encoding: 'utf8'
    });
    return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

const PRELUDE = `
const firestore = require(${JSON.stringify(path.join(LIB, 'firestore.js'))});
const mk = ${fakeDb.toString()};
`;

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE ONE THAT MATTERS: zero Firestore calls on the OTP path.
// ─────────────────────────────────────────────────────────────────────────────
{
    const out = run({ STATE_FILE: tmpState(), OTP_PATTERNS: '(\\d{4,8})' }, PRELUDE + `
        const db = mk({ doc: { filters: [{ phoneNumber: 'DEFAULT', patterns: ['(\\\\d{4,8})'] }],
                               globalForwarding: true, autoDeleteMinutes: 30 } });
        firestore._setDbForTests(db);
        const store = require(${JSON.stringify(path.join(LIB, 'store.js'))});
        store.loadDurableConfig();

        setTimeout(() => {
            const before = db.calls.get + db.calls.set;
            // A FULL cycle: receive, extract, supersede, fetch, consume.
            for (let i = 0; i < 50; i++) {
                store.addSms('bKash', '017' + String(10000000 + i), 'Your OTP is 44556' + (i % 10), Date.now());
            }
            for (let i = 0; i < 50; i++) store.getOtp('017' + String(10000000 + i));
            const after = db.calls.get + db.calls.set;
            console.log('HOTPATH_CALLS=' + (after - before));
            process.exit(0);
        }, 200);
    `);
    const n = /HOTPATH_CALLS=(\d+)/.exec(out.stdout);
    assert.ok(n, 'test did not report a call count:\n' + out.stdout + out.stderr);
    assert.strictEqual(n[1], '0',
        'FIRESTORE WAS CALLED ON THE OTP PATH. 100 messages/fetches produced '
        + n[1] + ' Firestore calls; the contract is zero.');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Config is READ at boot and applied.
// ─────────────────────────────────────────────────────────────────────────────
{
    const out = run({ STATE_FILE: tmpState(), OTP_PATTERNS: '(\\d{4,8})' }, PRELUDE + `
        firestore._setDbForTests(mk({ doc: {
            filters: [{ phoneNumber: 'IVAC', patterns: ['prompted\\\\s+(\\\\d{4,8})'] },
                      { phoneNumber: 'DEFAULT', patterns: ['(\\\\d{4,8})'] }],
            globalForwarding: false, autoDeleteMinutes: 45 } }));
        const store = require(${JSON.stringify(path.join(LIB, 'store.js'))});
        store.loadDurableConfig();
        setTimeout(() => {
            const s = store.getSettings();
            console.log('RULES=' + s.filters.length);
            console.log('FWD=' + s.globalForwarding);
            console.log('MINS=' + s.autoDeleteMinutes);
            console.log('SOURCE=' + store.configStatus().source);
            process.exit(0);
        }, 200);
    `);
    assert.ok(/RULES=2/.test(out.stdout), 'both rules should load: ' + out.stdout);
    assert.ok(/FWD=false/.test(out.stdout),
        'a persisted OFF in Firestore must beat FORWARDING_DEFAULT');
    assert.ok(/MINS=45/.test(out.stdout), 'autoDeleteMinutes should load');
    assert.ok(/SOURCE=Firestore/.test(out.stdout), 'the source must be recorded');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Fallback chain. A read failure must NOT lose the local config.
// ─────────────────────────────────────────────────────────────────────────────
{
    const stateFile = tmpState();
    fs.writeFileSync(stateFile, JSON.stringify({
        globalForwarding: true, autoDeleteMinutes: 30,
        filters: [{ phoneNumber: 'DEFAULT', patterns: ['\\bis\\s+(\\d{4,8})\\b'] }]
    }));

    const out = run({ STATE_FILE: stateFile }, PRELUDE + `
        firestore._setDbForTests(mk({ readThrows: true }));
        const store = require(${JSON.stringify(path.join(LIB, 'store.js'))});
        store.loadDurableConfig();
        setTimeout(() => {
            console.log('PATTERN=' + store.getSettings().filters[0].patterns[0]);
            console.log('READY=' + store.isConfigReady());
            process.exit(0);
        }, 200);
    `);
    assert.ok(/PATTERN=\\bis/.test(out.stdout),
        'a Firestore outage must fall back to the state file, not to the catch-all');
    assert.ok(/READY=true/.test(out.stdout),
        'a failed read must still release the config gate — never a permanent hang');
    assert.ok(/read failed/i.test(out.stderr), 'the failure must be logged, not swallowed');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Migration: empty Firestore + local config -> written up exactly once.
// ─────────────────────────────────────────────────────────────────────────────
{
    const stateFile = tmpState();
    fs.writeFileSync(stateFile, JSON.stringify({
        globalForwarding: false, autoDeleteMinutes: 20,
        filters: [{ phoneNumber: 'DEFAULT', patterns: ['(\\d{4,8})'] }]
    }));

    const out = run({ STATE_FILE: stateFile }, PRELUDE + `
        const db = mk({ doc: null });                 // document does not exist
        firestore._setDbForTests(db);
        const store = require(${JSON.stringify(path.join(LIB, 'store.js'))});
        store.loadDurableConfig();
        setTimeout(() => {
            console.log('SETS=' + db.calls.set);
            console.log('BY=' + (db.written[0] || {}).updatedBy);
            console.log('FWD=' + (db.written[0] || {}).globalForwarding);
            process.exit(0);
        }, 300);
    `);
    assert.ok(/SETS=1/.test(out.stdout), 'migration writes exactly once: ' + out.stdout);
    assert.ok(/BY=migration/.test(out.stdout), 'and marks itself as the migration');
    assert.ok(/FWD=false/.test(out.stdout), 'carrying the local state up unchanged');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. DEFERRED EXTRACTION — the cold-start window.
//
// No state file, so the only config available at boot is the CATCH-ALL. A
// message arriving in that window must NOT be extracted under it. It must still
// be stored and broadcast; only the extraction waits.
// ─────────────────────────────────────────────────────────────────────────────
{
    const out = run({ STATE_FILE: tmpState(), OTP_PATTERNS: '(\\d{4,8})' }, PRELUDE + `
        // Read resolves only after we have pushed a message through.
        let release;
        const slow = new Promise(r => { release = r; });
        const db = {
            collection: () => ({ doc: () => ({
                get: async () => { await slow; return { exists: true, data: () => ({
                    filters: [{ phoneNumber: 'DEFAULT', patterns: ['\\\\bis\\\\s+(\\\\d{4,8})\\\\b'] }],
                    globalForwarding: true, autoDeleteMinutes: 30 }) }; },
                set: async () => {}
            }) })
        };
        firestore._setDbForTests(db);
        const store = require(${JSON.stringify(path.join(LIB, 'store.js'))});
        store.loadDurableConfig();

        // A bKash message whose AMOUNT would be grabbed by the catch-all.
        store.addSms('bKash', '01711111111', 'Tk 2000.00 paid. Your OTP is 445566.', Date.now());

        // Stored and visible immediately — nothing blocked.
        console.log('STORED=' + store.getAllSms().length);
        console.log('CODE_DURING=' + JSON.stringify(store.getOtp('01711111111')));

        // A parked long-poll, exactly as a real fetching script would be.
        const parked = store.waitForOtp('01711111111', 3000, () => {});
        setTimeout(() => release(), 50);
        parked.then(otp => {
            console.log('CODE_AFTER=' + JSON.stringify(otp));
            process.exit(0);
        });
    `);
    assert.ok(/STORED=1/.test(out.stdout),
        'the message must be stored immediately — only extraction is deferred');
    assert.ok(/CODE_DURING=null/.test(out.stdout),
        'nothing may be extracted under the catch-all during the cold-start window');
    assert.ok(/CODE_AFTER="445566"/.test(out.stdout),
        'once the real config lands the CORRECT code is extracted and the parked '
        + 'long-poll is woken — got: ' + out.stdout);
    assert.ok(!/CODE_AFTER="2000"/.test(out.stdout),
        'the catch-all would have grabbed the amount; that is the bug being prevented');
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. The deferral ceiling. A read that never settles must not hold OTPs forever.
// ─────────────────────────────────────────────────────────────────────────────
{
    const out = run({ STATE_FILE: tmpState(), OTP_PATTERNS: '(\\d{4,8})' }, PRELUDE + `
        firestore._setDbForTests(mk({ readHangs: true }));
        const store = require(${JSON.stringify(path.join(LIB, 'store.js'))});
        store.loadDurableConfig();
        store.addSms('X', '01711111111', 'code 445566', Date.now());
        setTimeout(() => {
            console.log('READY=' + store.isConfigReady());
            console.log('CODE=' + JSON.stringify(store.getOtp('01711111111')));
            process.exit(0);
        }, 3600);
    `);
    assert.ok(/READY=true/.test(out.stdout),
        'the 3s ceiling must release the gate even if Firestore never answers');
    assert.ok(/CODE="445566"/.test(out.stdout),
        'and the held message must then be extracted with whatever config exists — '
        + 'deferral must never become a hang');
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. A failed WRITE must not claim success.
// ─────────────────────────────────────────────────────────────────────────────
{
    const out = run({ STATE_FILE: tmpState() }, PRELUDE + `
        firestore._setDbForTests(mk({ doc: null, writeThrows: true }));
        firestore.writeConfig({ filters: [], globalForwarding: true, autoDeleteMinutes: 30 }, 'dashboard');
        setTimeout(() => {
            const st = firestore.getStatus();
            console.log('PENDING=' + st.pendingWrite);
            console.log('OK=' + st.lastWriteOk);
            process.exit(0);
        }, 2400);
    `);
    assert.ok(/PENDING=true/.test(out.stdout),
        'a failed durable write must stay flagged as pending — the dashboard has to '
        + 'be able to say "saved locally, not in the cloud" rather than claim success');
    assert.ok(/OK=false/.test(out.stdout), 'and record the failure');
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Flag off: completely inert.
// ─────────────────────────────────────────────────────────────────────────────
{
    const out = run({ STATE_FILE: tmpState(), FIRESTORE_ENABLED: 'false' }, `
        const firestore = require(${JSON.stringify(path.join(LIB, 'firestore.js'))});
        firestore.init();
        console.log('ENABLED=' + firestore.isEnabled());
        const store = require(${JSON.stringify(path.join(LIB, 'store.js'))});
        console.log('READY=' + store.isConfigReady());
        process.exit(0);
    `);
    assert.ok(/ENABLED=false/.test(out.stdout), 'the flag must gate everything');
    assert.ok(/READY=true/.test(out.stdout),
        'with Firestore off there is nothing to wait for — no message may ever be deferred');
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. PRODUCTION REQUIRE ORDER.
//
// Every case above sets up the stub BEFORE requiring the store. server.js does
// the opposite: it requires lib/store first and calls firestore.init() several
// lines later. The first cut of this feature computed the deferral gate at
// module load as
//
//     configReady = hasPersistedConfig() || !firestore.isEnabled()
//
// which, in that order, was ALWAYS true — deferral could never fire in the real
// server, and every test above still passed. A cold start extracted "2000" out
// of "Tk 2000.00 paid. Your OTP is 445566." and served it.
//
// So this case mimics server.js's order exactly. A suite that builds its world
// differently from production proves less than it appears to.
// ─────────────────────────────────────────────────────────────────────────────
{
    const out = run({ STATE_FILE: tmpState(), OTP_PATTERNS: '(\\d{4,8})' }, `
        // Order matters: store FIRST, exactly as server.js does it.
        const store = require(${JSON.stringify(path.join(LIB, 'store.js'))});
        const firestore = require(${JSON.stringify(path.join(LIB, 'firestore.js'))});
        firestore._setDbForTests({ collection: () => ({ doc: () => ({
            get: () => new Promise(() => {}),        // never answers
            set: async () => {}
        }) }) });
        store.loadDurableConfig();

        store.addSms('bKash', '01711111111', 'Tk 2000.00 paid. Your OTP is 445566.', Date.now());
        console.log('READY=' + store.isConfigReady());
        console.log('CODE=' + JSON.stringify(store.getOtp('01711111111')));
        process.exit(0);
    `);
    assert.ok(/READY=false/.test(out.stdout),
        'the gate must close in loadDurableConfig(), not at module load — in '
        + "server.js's require order firestore.init() has not run yet");
    assert.ok(/CODE=null/.test(out.stdout),
        'REGRESSION: a cold start served a code extracted by the catch-all. '
        + 'That is the payment amount, not the OTP. Got: ' + out.stdout);
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. The gate is OPEN by default, so an omission can never wedge the store.
// ─────────────────────────────────────────────────────────────────────────────
{
    const out = run({ STATE_FILE: tmpState(), OTP_PATTERNS: '(\\d{4,8})' }, `
        const store = require(${JSON.stringify(path.join(LIB, 'store.js'))});
        // loadDurableConfig() deliberately NOT called — as in every other suite.
        store.addSms('X', '01711111111', 'code 445566', Date.now());
        console.log('READY=' + store.isConfigReady());
        console.log('CODE=' + JSON.stringify(store.getOtp('01711111111')));
        process.exit(0);
    `);
    assert.ok(/READY=true/.test(out.stdout),
        'without loadDurableConfig there is nothing to wait for; the gate stays open');
    assert.ok(/CODE="445566"/.test(out.stdout),
        'a caller that never loads durable config must behave exactly as before');
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. Saving must CLEAR the "running on env defaults" warning.
//
// configSource was written only at boot and by a Firestore load, so after a
// successful save the dashboard still showed "running on env defaults — these
// filters are the catch-all" in red. Alarming and wrong. The catch-all warning
// is the one message that must never cry wolf, or it stops being read on the
// day it is true.
// ─────────────────────────────────────────────────────────────────────────────
{
    const out = run({ STATE_FILE: tmpState(), OTP_PATTERNS: '(\\d{4,8})' }, `
        const store = require(${JSON.stringify(path.join(LIB, 'store.js'))});
        console.log('BEFORE=' + store.configStatus().source);
        store.setFilters([{ phoneNumber: 'DEFAULT', patterns: ['\\bis\\s+(\\d{4,8})\\b'] }]);
        console.log('AFTER=' + store.configStatus().source);
        process.exit(0);
    `);
    assert.ok(/BEFORE=env defaults/.test(out.stdout),
        'a fresh container with no state file genuinely is on the catch-all');
    assert.ok(/AFTER=dashboard/.test(out.stdout),
        'after a save the config is the operator\'s, and the red warning must clear: '
        + out.stdout);
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. A Firestore error must be a DIAGNOSIS, not a gRPC status code.
//
// The dashboard showed "5 NOT_FOUND:" — often with nothing after the colon.
// That is a code, not an answer, and the cure ("create the database in the
// Firebase console; enabling FCM does not create one") is unguessable from it.
// Hit for real on the first deploy with FIRESTORE_ENABLED=true.
// ─────────────────────────────────────────────────────────────────────────────
{
    const firestore = require('../lib/firestore');
    assert.ok(/Create database/i.test(firestore.explain('5 NOT_FOUND: ')),
        'NOT_FOUND must say the database has not been created');
    assert.ok(/asia-southeast1/.test(firestore.explain('5 NOT_FOUND: ')),
        'and name the region, since it is permanent and must match Render');
    assert.ok(/Datastore User/.test(firestore.explain('7 PERMISSION_DENIED')),
        'PERMISSION_DENIED must name the role to grant');
    assert.ok(/different\s+project|revoked/.test(firestore.explain('16 UNAUTHENTICATED')),
        'UNAUTHENTICATED must point at the credential');
    assert.ok(/nothing about OTP delivery is affected/.test(
            firestore.explain('Firestore read timed out after 3000ms')),
        'a timeout must say plainly that OTPs are unaffected — that is the first '
        + 'question anyone reading this has');
    assert.strictEqual(firestore.explain('something unexpected'), 'something unexpected',
        'an unrecognised error passes through verbatim rather than being guessed at');
    assert.ok(/5 NOT_FOUND/.test(firestore.explain('5 NOT_FOUND: ')),
        'the original text is kept — the explanation adds to it, never replaces it');
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. A FAILED READ MUST NEVER BE MISTAKEN FOR AN EMPTY ONE.
//
// This destroyed real config in production. readConfig() returned null for both
// "the document does not exist" and "the read failed", and the caller's answer
// to "does not exist" is to MIGRATE — writing whatever it currently holds up to
// Firestore. On a fresh container that is the env-default CATCH-ALL. So one slow
// read on a cold start overwrote a saved filter set, silently and permanently,
// because the good copy was the thing being replaced.
//
// Cold Render meeting cold Firestore is exactly when a read is most likely to be
// slow, which is to say: the most likely moment is also the most damaging one.
// ─────────────────────────────────────────────────────────────────────────────
{
    const stateFile = tmpState();
    fs.writeFileSync(stateFile, JSON.stringify({
        globalForwarding: true, autoDeleteMinutes: 30,
        filters: [{ phoneNumber: 'DEFAULT', patterns: ['\\bis\\s+(\\d{4,8})\\b'] }]
    }));

    const out = run({ STATE_FILE: stateFile, OTP_PATTERNS: '(\\d{4,8})' }, PRELUDE + `
        const db = mk({ readThrows: true });
        firestore._setDbForTests(db);
        const store = require(${JSON.stringify(path.join(LIB, "store.js"))});
        store.loadDurableConfig();
        setTimeout(() => {
            console.log('WRITES=' + db.calls.set);
            process.exit(0);
        }, 400);
    `);
    assert.ok(/WRITES=0/.test(out.stdout),
        'A FAILED READ MUST NOT TRIGGER A MIGRATION. Writing here overwrites the very '
        + 'config we failed to read. Got: ' + out.stdout);
    assert.ok(/NOT\s+migrating/i.test(out.stderr),
        'and it must say so, because the alternative is silent data loss');
}

// ─────────────────────────────────────────────────────────────────────────────
// 14. Nor may a fresh container migrate its ENV DEFAULTS over a real config.
//
// Second guard, independent of the first. Even after a genuinely successful
// "document not found", writing the catch-all up is not a migration — it is
// publishing a value nobody chose. The first real save writes the real config.
// ─────────────────────────────────────────────────────────────────────────────
{
    const out = run({ STATE_FILE: tmpState(), OTP_PATTERNS: '(\\d{4,8})' }, PRELUDE + `
        const db = mk({ doc: null });            // read succeeds, document absent
        firestore._setDbForTests(db);
        const store = require(${JSON.stringify(path.join(LIB, "store.js"))});
        store.loadDurableConfig();
        setTimeout(() => { console.log('WRITES=' + db.calls.set); process.exit(0); }, 400);
    `);
    assert.ok(/WRITES=0/.test(out.stdout),
        'a fresh container has nothing worth migrating — it must not publish the catch-all');
    assert.ok(/nothing local worth migrating/i.test(out.stderr),
        'and must say why it did nothing');
}

// ─────────────────────────────────────────────────────────────────────────────
// 15. A FAILED IDENTITY READ MUST NOT DELETE EVERY USER ACCOUNT.
//
// Worse than the config version of this bug. users.load() CLEARS the maps, and
// the caller ran it on a failed read too. Any change afterwards — a device
// registering, which happens by itself with no operator involved — then wrote
// the empty set back to Firestore.
//
// So one failed read at boot did not merely start empty: it PERMANENTLY DELETED
// every user account, because the stored copy was the only one. Observed in
// production.
// ─────────────────────────────────────────────────────────────────────────────
{
    const users = require('../lib/users');
    const firestore = require('../lib/firestore');

    // Fresh process semantics are not available here, so exercise the guard
    // directly: a module that has never had a successful load must refuse to
    // persist, whatever asks it to.
    let wrote = null;
    users.setPersister(snap => { wrote = snap; });

    // A device registering is the realistic trigger — nothing operator-driven.
    users.registerDevice(null, { model: 'Galaxy A14' });
    assert.strictEqual(wrote, null,
        'NOTHING may be persisted before a successful load — writing an empty set '
        + 'here is what deleted the accounts');

    // After a successful load, writes are safe again. An empty stored state is
    // fine: we then KNOW it is empty rather than unknown.
    users.load({ users: [{ id: 'rahim', name: 'Rahim', active: true }], devices: [] });
    assert.strictEqual(users.isLoaded(), true, 'a successful load unblocks writes');
    users.registerDevice(null, { model: 'Redmi 12' });
    assert.ok(wrote && wrote.users.some(u => u.id === 'rahim'),
        'and the write carries the loaded accounts, not an empty set');

    // The read itself must report failure distinctly, exactly like readConfig.
    firestore._setDbForTests({
        collection: () => ({ doc: () => ({ get: async () => { throw new Error('boom'); },
                                           set: async () => {} }) })
    });
    return firestore.readIdentity().then(r => {
        assert.strictEqual(r.ok, false,
            'a failed identity read must be distinguishable from an empty one');
        firestore._setDbForTests(null);
        return midFlightWriteTest().then(done);
    });
}

/**
 * 17. A SAVE LANDING MID-WRITE MUST NOT BE DISCARDED.
 *
 * doFlushWrite cleared the pending slot unconditionally on success. A cold
 * Firestore connection routinely takes seconds, and a second save inside that
 * window was overwritten to null — never written — while pendingConfig flipped
 * to false, so the dashboard reported "saved".
 *
 * Same class as the "Retry now erased a user" bug, through the IN-FLIGHT window
 * instead of the debounce window.
 *
 * CHAINED, not written as another top-level block: the block above ends with a
 * `return` at module scope, which exits the module — so anything after it is
 * dead code. The first version of this test was exactly that, and passed
 * happily against the unfixed write path because it never ran at all.
 */
async function midFlightWriteTest() {
    // Required here: the surrounding blocks each require it in their own scope.
    const firestore = require('../lib/firestore');
    let stored = null;
    firestore._setDbForTests({
        collection: () => ({ doc: () => ({
            get: async () => ({ exists: false }),
            set: async (v) => { await new Promise(r => setTimeout(r, 300)); stored = v; }
        })})
    });

    firestore.writeConfig({ filters: [{ phoneNumber: 'FIRST' }] }, 'save1');
    await new Promise(r => setTimeout(r, 2100));     // debounce fires; write in flight
    firestore.writeConfig({ filters: [{ phoneNumber: 'SECOND' }] }, 'save2');
    await new Promise(r => setTimeout(r, 3000));

    assert.ok(stored, 'something must have been written');
    assert.strictEqual(stored.filters[0].phoneNumber, 'SECOND',
        'the LATER save must win. Clearing the pending slot unconditionally on '
        + 'success discards whatever arrived while the write was in flight, and '
        + 'reports it as saved.');

    firestore._setDbForTests(null);
}

// ─────────────────────────────────────────────────────────────────────────────
// 16. A FIRESTORE OUTAGE MUST NOT LOOK LIKE DELETION.
//
// Four times, config and users "disappeared" after a deploy. Every time the data
// was in Firestore and the boot read had failed. Config has had a state-file
// cache since 4.20.0 and identity had NONE — so a failed identity read left the
// system with no users at all, which is indistinguishable from deletion.
//
// The cache serves; it does not authorise. loadCache leaves the state read-only,
// so a cache we are not sure is current can never overwrite Firestore.
// ─────────────────────────────────────────────────────────────────────────────
{
    const users = require('../lib/users');
    users.load({ users: [{ id: 'a', name: 'A', active: true }], devices: [] });
    assert.strictEqual(users.isLoaded(), true, 'a real load authorises writes');

    users.loadCache({ users: [{ id: 'cached', name: 'Cached', active: true }], devices: [] });
    assert.ok(users.listUsers().some(u => u.id === 'cached'),
        'the cache is SERVED — the dashboard works and people can sign in');
    assert.strictEqual(users.isLoaded(), false,
        'but it does NOT authorise writes: a cache that may be stale must never '
        + 'overwrite Firestore');

    let wrote = null;
    users.setPersister(s => { wrote = s; });
    users.createUser('Nope');
    assert.strictEqual(wrote, null,
        'and a change made while serving from cache is not persisted');
}

function done() {
console.log('ok — Firestore is off the OTP path (0 calls), config loads and falls back, '
    + "migration runs once, and in server.js's own require order the cold-start "
    + 'window cannot extract a wrong code');
}
