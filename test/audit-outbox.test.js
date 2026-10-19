/**
 * test/audit-outbox.test.js — server 4.42.1, users/outbox findings of the audit.
 *
 *   1. Cancelling a job that already reached the phone (re-queued only because
 *      nothing was heard) marks it 'unknown', not 'cancelled': the limit is
 *      not refunded and the phone's late reports still count.
 *   2. Cancel before the outbox has loaded is refused (-1), not "0 cancelled".
 *   3. A receipt of our own SMS settles a re-queued job as delivered.
 *   4. One number on BOTH SIMs of one phone is flagged.
 *   5. A purged-then-recreated account does not see the old account's SMS.
 *
 * Run: node test/audit-outbox.test.js
 */
process.env.USERS_ENABLED = 'true';
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.STATE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-aout-')), 's.json');

const store  = require('../lib/store');
const outbox = require('../lib/outbox');
const users  = store.users;

users.load({ users: [], devices: [] });
users.createUser('rahim');
users.setSendPermission('rahim', { enabled: true, dailyLimit: 5 });
const id = 'aaaaaaaaaaaaaaaa';
users.registerDevice(id, { model: 'X', canSendSms: true,
    sims: [{ slot: 1, number: '01711111111', source: 'manual', present: true },
           { slot: 2, number: '', present: false }] });
users.assignDevice(id, 'rahim');
outbox._setLoaded(true);
const rahim = { userId: 'rahim', role: 'user' };
const t = Date.now();
const online = at => { users.getDevice(id).lastSeen = at; };

// ── 1. cancel after it reached the phone ────────────────────────
let r = outbox.createBatch(rahim, { fromDeviceId: id, fromSlot: 1, to: ['01811111111'], message: 'hi' }, t);
assert.ok(r.ok, JSON.stringify(r));
const j = outbox._jobs.get(r.jobs[0].id);
assert.strictEqual(outbox.pull(id, t).length, 1);
online(t + 4 * 60_000);
outbox.sweep(t + 4 * 60_000);
assert.strictEqual(j.status, 'queued', 'precondition: re-queued after nothing was heard');
assert.strictEqual(outbox.cancel(rahim, { jobId: j.id }, t + 4 * 60_000 + 1), 1);
assert.strictEqual(j.status, 'unknown', 'it may have gone out — not "cancelled"');
assert.strictEqual(outbox.usedToday('rahim', t + 5 * 60_000), 1, 'the limit is not refunded');
const late = outbox.report(id, { jobId: j.id, event: 'part_sent', part: 0, parts: 1 }, t + 5 * 60_000);
assert.ok(late.ok && j.status !== 'unknown' && j.status !== 'cancelled', 'a late report still counts: ' + j.status);
// A job that never reached the phone is simply cancelled, as before.
online(t + 6 * 60_000);
r = outbox.createBatch(rahim, { fromDeviceId: id, fromSlot: 1, to: ['01822222222'], message: 'hi 2' }, t + 6 * 60_000);
assert.ok(r.ok, JSON.stringify(r));
const k = outbox._jobs.get(r.jobs[0].id);
assert.strictEqual(outbox.cancel(rahim, { jobId: k.id }, t + 6 * 60_000 + 1), 1);
assert.strictEqual(k.status, 'cancelled');

// ── 2. cancel before the outbox has loaded ──────────────────────
online(t + 7 * 60_000);
r = outbox.createBatch(rahim, { fromDeviceId: id, fromSlot: 1, to: ['01833333333'], message: 'hi 3' }, t + 7 * 60_000);
assert.ok(r.ok, JSON.stringify(r));
outbox._setLoaded(false);
assert.strictEqual(outbox.cancel(rahim, { jobId: r.jobs[0].id }, t + 7 * 60_000 + 1), -1, 'not loaded: refused');
outbox._setLoaded(true);
assert.strictEqual(outbox._jobs.get(r.jobs[0].id).status, 'queued');

// ── 3. our own SMS received settles a re-queued job ─────────────
const q = outbox._jobs.get(r.jobs[0].id);
online(t + 8 * 60_000);
assert.strictEqual(outbox.pull(id, t + 8 * 60_000).length, 1);
online(t + 12 * 60_000);
outbox.sweep(t + 12 * 60_000);
assert.strictEqual(q.status, 'queued', 'precondition: re-queued');
outbox.noteInternal('01711111111', '01833333333', 'hi 3', t + 12 * 60_000 + 5);
assert.strictEqual(q.status, 'delivered', 'received = it went out');
assert.strictEqual(outbox.pull(id, t + 13 * 60_000).length, 0, 'and it is not handed to the phone again');

// ── 4. one number on both SIMs of one phone ─────────────────────
const dup = 'bbbbbbbbbbbbbbbb';
users.registerDevice(dup, { model: 'Y', sims: [{ slot: 1, number: '01799999999', source: 'manual' },
                                               { slot: 2, number: '01799999999', source: 'auto' }] });
const dd = users.listDevices().find(d => d.id === dup);
assert.ok(dd.simConflicts.some(c => c.sameDevice && c.number === '01799999999'),
          'flagged: ' + JSON.stringify(dd.simConflicts));
assert.ok(!users.listDevices().find(d => d.id === id).simConflicts.length, 'a normal phone is not');

// ── 5. a re-created account does not inherit the old one's SMS ──
assert.ok(outbox.list(rahim).length > 0, 'precondition: rahim sees his SMS');
users.setActive('rahim', false);
assert.ok(users.purgeUser('rahim').ok);
users.createUser('rahim');
// (The jobs above carry test times up to t+13 min; the new account is "now"
// in that same timeline.)
users.getUser('rahim').createdAt = t + 20 * 60_000;
assert.strictEqual(outbox.list(rahim).length, 0, 'the new "rahim" sees none of the old one\'s SMS');
assert.strictEqual(outbox.usedToday('rahim', t + 21 * 60_000), 0, 'nor its daily count');

console.log('ok — a cancel never hides a sent SMS, waits for the queue to load, a receipt settles a re-queued job, '
    + 'a number on both SIMs is flagged, and a re-created account starts clean');
process.exit(0);
