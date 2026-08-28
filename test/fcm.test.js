/**
 * test/fcm.test.js — the push channel's delivery window.
 *
 * `ttl` was 60000 for every action. It is MILLISECONDS in firebase-admin, so a
 * command was discarded by Google if the phone was not reachable within sixty
 * seconds — dozing, screen off, briefly off data. It never arrived at all, and
 * the device fell back to the 30s poller (only alive while forwarding is on) or
 * the 15-minute worker. That was the "toggling takes time" symptom.
 *
 * Run: node test/fcm.test.js
 */

const assert = require('assert');
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const real = console.log;
console.log = () => {};
const fcm = require('../lib/fcm');
fcm.init();
console.log = real;

const s = fcm.getStatus();

// ── The window must cover a sleeping phone ───────────────────────
assert.strictEqual(s.ttlSeconds.enable, 900,
    'enable must survive a phone that is asleep or briefly offline');
assert.strictEqual(s.ttlSeconds.disable, 900,
    'disable must survive the same');

// Bounded on purpose: beyond ControlSyncWorker's 15-minute period the worker
// reconciles anyway, so a longer push adds nothing and only widens the window
// in which a stale "enable" could clear a deliberate local opt-out.
assert.ok(s.ttlSeconds.enable <= 900,
    'on/off TTL must not exceed the worker period that would reconcile it anyway');

// One-shots stay short — a test message landing 20 minutes late is noise.
assert.ok(s.ttlSeconds.test <= 300 && s.ttlSeconds.clear_log <= 300,
    'one-shot commands must not be deliverable long after they were pressed');

// The regression itself.
for (const [action, ttl] of Object.entries(s.ttlSeconds)) {
    assert.notStrictEqual(ttl, 60,
        `${action} is back on the 60-second TTL that dropped commands`);
}

// ── A misconfigured FCM must be visible, not silent ──────────────
assert.strictEqual(s.configured, false, 'unset service account reports as unconfigured');

(async () => {
    await fcm.send('enable', Date.now());
    const after = fcm.getStatus();
    assert.strictEqual(after.lastOk, false, 'a send with no credentials must record a failure');
    assert.ok(after.lastError && after.lastError.includes('not configured'),
        'and must say why — this used to be a log line nobody reads');
    assert.strictEqual(after.lastAction, 'enable', 'and which action it was');

    console.log('ok — on/off pushes live 15 min, one-shots 2 min, failures are visible');
    process.exit(0);
})();
