/**
 * test/resilience.test.js — the four failures that were silent.
 *
 * Each of these had the same shape: something went wrong, nothing said so, and
 * the system carried on in a degraded state that looked identical to a healthy
 * one. Tests, not reasoning, because three of them are load-time behaviour that
 * only happens in a fresh process.
 *
 * Run: node test/resilience.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { execFileSync } = require('child_process');

const STORE = path.join(__dirname, '..', 'lib', 'store.js');

/** Run a snippet in a FRESH node process — load-time behaviour needs one. */
function inFreshProcess(env, code) {
    const res = execFileSync(process.execPath,
        ['-e', `const store = require(${JSON.stringify(STORE)});\n${code}\nprocess.exit(0);`],
        { env: Object.assign({}, process.env, env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return res;
}
function stderrOf(env, code) {
    try {
        execFileSync(process.execPath,
            ['-e', `const store = require(${JSON.stringify(STORE)});\n${code}\nprocess.exit(0);`],
            { env: Object.assign({}, process.env, env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return String(e.stderr || ''); }
    return '';
}
function bothStreams(env, code) {
    const out = { stdout: '', stderr: '' };
    const r = require('child_process').spawnSync(process.execPath,
        ['-e', `const store = require(${JSON.stringify(STORE)});\n${code}\nprocess.exit(0);`],
        { env: Object.assign({}, process.env, env), encoding: 'utf8' });
    out.stdout = r.stdout || '';
    out.stderr = r.stderr || '';
    return out;
}

const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-t-')), 'state.json');


// ─────────────────────────────────────────────────────────────────────────────
// 1. unconsume() must WAKE a parked long-poll, not just restore the code.
//
// It exists for one situation — a long-poll whose client hung up between being
// handed the code and the response being written — and that client's very next
// act is another long-poll for the same number. Restoring without notifying
// left it parked on a code that was already sitting there available, for its
// full wait window. Measured before the fix: waiter got null, and a plain fetch
// straight afterwards returned the code.
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
    const store = require('../lib/store');
    const NUM = '01711111111';

    const first = store.waitForOtp(NUM, 3000, () => {});
    await new Promise(r => setTimeout(r, 30));
    store.addSms('bKash', NUM, 'Your OTP is 123456', Date.now());
    const a = await first;
    assert.strictEqual(a, '123456', 'the first waiter should get the code');

    // Second client parks; the first turns out to have gone away.
    const second = store.waitForOtp(NUM, 2000, () => {});
    await new Promise(r => setTimeout(r, 30));

    const started = Date.now();
    assert.strictEqual(store.unconsume(NUM, a), true, 'the code should be restorable');
    const b = await second;
    const waited = Date.now() - started;

    assert.strictEqual(b, '123456',
        'unconsume must wake the parked waiter — it used to sit out its whole window');
    assert.ok(waited < 500,
        `the waiter must be woken immediately, not on timeout (waited ${waited}ms)`);
    assert.strictEqual(store.getOtp(NUM), null,
        'and the woken waiter must have CONSUMED it — no second delivery');

    // Saturation is a different fact from a timeout.
    assert.strictEqual(typeof store.waitersFull, 'function',
        '/get needs to be able to ask whether every long-poll slot is taken');
    assert.strictEqual(store.waitersFull(), false, 'no waiters are parked at this point');

    runProcessTests();
})();


function runProcessTests() {
    // ─────────────────────────────────────────────────────────────────────────
    // 2. Filters that can never match must be dropped LOUDLY at load.
    //
    // POST /api/filters refuses them. The state file and OTP_PATTERNS were
    // never checked — the two doors where you would NOT notice the mistake.
    // ─────────────────────────────────────────────────────────────────────────
    const doubleEscaped = bothStreams(
        { OTP_PATTERNS: JSON.stringify([
            { phoneNumber: 'DEFAULT', patterns: ['(\\\\d{4,8})', '(\\d{4,8})'] },
            { phoneNumber: 'IVAC',    patterns: ['\\d{4}'] }
          ]), STATE_FILE: tmpState() },
        `console.log('ACTIVE=' + JSON.stringify(store.getSettings().filters));`);

    assert.ok(/dropping unusable pattern for DEFAULT/.test(doubleEscaped.stderr),
        'a double-escaped pattern must be reported, not silently cached as dead');
    assert.ok(/dropping unusable pattern for IVAC/.test(doubleEscaped.stderr),
        'a pattern with no capture group can never yield match[1]');
    assert.ok(/dropping rule IVAC entirely/.test(doubleEscaped.stderr),
        'a sender rule with nothing usable left must GO — it does not fall back to '
        + 'DEFAULT, so leaving it would lose every OTP from that sender');

    const active = JSON.parse(/ACTIVE=(.*)/.exec(doubleEscaped.stdout)[1]);
    assert.deepStrictEqual(active, [{ phoneNumber: 'DEFAULT', patterns: ['(\\d{4,8})'] }],
        'the usable pattern survives untouched; only the dead ones go');

    // The pipe-split path splits a regex ALTERNATION into two broken halves.
    // That used to compile to nothing in silence.
    const split = bothStreams(
        { OTP_PATTERNS: '(?:OTP|PIN)[^0-9]{0,9}(\\d{4,8})', STATE_FILE: tmpState() },
        `console.log('ACTIVE=' + JSON.stringify(store.getSettings().filters));`);
    assert.ok(/not a valid regular expression/.test(split.stderr),
        'OTP_PATTERNS is split on "|", which breaks alternation — say so');
    assert.ok(/NO USABLE FILTER RULES/.test(split.stderr),
        'losing every rule is the loudest thing that can happen here');

    // A healthy configuration must stay completely quiet.
    const healthy = bothStreams(
        { OTP_PATTERNS: '(\\d{4,8})', STATE_FILE: tmpState() },
        `console.log('ACTIVE=' + JSON.stringify(store.getSettings().filters));`);
    assert.ok(!/dropping|NO USABLE/.test(healthy.stderr),
        'a valid pattern must produce no warning at all');


    // ─────────────────────────────────────────────────────────────────────────
    // 3. The state file is written atomically, and an unusable one is LOUD.
    //
    // writeFileSync truncates then writes. A crash in that window left a
    // truncated file, readState() swallowed the parse error, and forwarding
    // silently reverted to FORWARDING_DEFAULT while the filters reverted to the
    // catch-all — the exact pair of bugs the file exists to prevent.
    // ─────────────────────────────────────────────────────────────────────────
    const stateFile = tmpState();
    bothStreams({ STATE_FILE: stateFile },
        `store.setFilters([{ phoneNumber: 'DEFAULT', patterns: ['\\\\bis\\\\s+(\\\\d{4,8})\\\\b'] }]);
         store.setGlobalForwarding(false);`);

    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.strictEqual(saved.globalForwarding, false, 'the off switch must persist');
    assert.strictEqual(saved.filters[0].patterns[0], '\\bis\\s+(\\d{4,8})\\b');
    assert.ok(!fs.existsSync(stateFile + '.tmp'),
        'the temp file must be renamed away, never left behind');

    // It comes back on the next boot.
    const restored = bothStreams({ STATE_FILE: stateFile, FORWARDING_DEFAULT: 'on' },
        `console.log('FWD=' + store.isForwardingEnabled());`);
    assert.ok(/FWD=false/.test(restored.stdout),
        'a persisted OFF must beat FORWARDING_DEFAULT=on');

    // Now corrupt it the way a half-write would.
    fs.writeFileSync(stateFile, '{"globalForwarding":false,"filt');
    const corrupt = bothStreams({ STATE_FILE: stateFile, FORWARDING_DEFAULT: 'on' },
        `console.log('FWD=' + store.isForwardingEnabled());`);
    assert.ok(/STATE FILE UNUSABLE/.test(corrupt.stderr),
        'a corrupt state file must be reported — it silently reverts BOTH the off '
        + 'switch and the filters, and used to do it without a word');
    assert.ok(/FWD=true/.test(corrupt.stdout),
        'the documented fallback still applies; the point is that it now says so');

    // A missing file is the normal first boot and must stay silent.
    const fresh = bothStreams({ STATE_FILE: tmpState() }, `void 0;`);
    assert.ok(!/UNUSABLE/.test(fresh.stderr),
        'no file on first boot is not an error');

    console.log('ok — unconsume wakes waiters, state is written atomically, '
        + 'unusable filters are dropped loudly at load');
    process.exit(0);
}
