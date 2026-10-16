/**
 * test/revoke.test.js — "Remove" means removed until the app is reinstalled,
 * and devices nobody uses leave the list by themselves (server 4.39.0).
 *
 * =============================================================================
 * WHAT MUST HOLD
 *
 *   1. A removal is a standing block: remembered, survives a reload, refuses
 *      the registration the app makes on every start, and stops forwarding
 *      server-side whatever the phone believes.
 *   2. There is NO way back except a reinstall: no username, no "Allow back".
 *   3. A reinstall (same device id, a DIFFERENT installId) lifts it, and the
 *      phone comes back as a NEW, UNASSIGNED device — owner, SIM number and
 *      name of the removed row are not kept.
 *   4. A removal recorded without an installId (an older app) is never lifted
 *      by an installId.
 *   5. A device silent for more than 7 days is flagged inactive (hidden on the
 *      dashboard); after 15 days the hourly sweep deletes it. The activity
 *      clock survives a reload, and an upgrade does not mass-delete.
 * =============================================================================
 *
 * Run: node test/revoke.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

process.env.STATE_FILE        = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-rv-')), 'state.json');
process.env.OTP_PATTERNS      = '(\\d{4,8})';
process.env.USERS_ENABLED     = 'true';
process.env.FIRESTORE_ENABLED = 'false';
process.env.FORWARDING_DEFAULT = 'on';

const store = require('../lib/store');
const users = require('../lib/users');

store.loadIdentity();
assert.ok(users.createUser('Rahim').ok, 'setup: user created');

const DAY = 86_400_000;
const ID        = 'cccccccccccccccc';
const INSTALL_A = 'aaaaaaaaaaaaaaaa';
const INSTALL_B = 'bbbbbbbbbbbbbbbb';

users.registerDevice(ID, { model: 'Galaxy A14', installId: INSTALL_A });
assert.ok(users.assignDevice(ID, 'rahim').ok, 'setup: assigned');
users.setDeviceSim(ID, '01788888888');
users.renameDevice(ID, "Rahim's phone");
assert.strictEqual(store.forwardingFor(ID), true, 'a registered device forwards');
assert.strictEqual(users.ownerOf(ID), 'rahim', 'setup: owned by Rahim before removal');
assert.strictEqual(users.getDevice(ID).installId, INSTALL_A, 'the install is recorded');

// ─── 1. Removal is a standing block ─────────────────────────────────────────
assert.strictEqual(users.removeDevice(ID).ok, true, 'removal succeeds');
assert.strictEqual(users.isRevoked(ID), true, 'and is remembered');
assert.strictEqual(users.getDevice(ID), null, 'and the row is gone from the list');
assert.strictEqual(store.forwardingFor(ID), false,
    'a removed device must stop forwarding immediately, whatever it believes');

// ─── 2. No way back for the same install: not by restart, not by username ──
{
    let r = users.registerDevice(ID, { model: 'Galaxy A14', installId: INSTALL_A });
    assert.strictEqual(r.revoked, true, 'the same install re-registering is refused');
    assert.strictEqual(r.needsUsername, false, 'and no username is asked for');
    assert.ok(/reinstall/i.test(r.error), 'the message says how to come back: ' + r.error);
    r = users.registerDevice(ID, { claimedUser: 'Rahim', installId: INSTALL_A });
    assert.strictEqual(r.revoked, true, 'a valid username does NOT bring it back any more');
    r = users.registerDevice(ID, {});
    assert.strictEqual(r.revoked, true, 'nor a registration that carries no installId');
    users.noteInstall(ID, INSTALL_A);
    assert.strictEqual(users.isRevoked(ID), true, 'the same install on /sms or the poll lifts nothing');
    users.noteInstall(ID, 'not-hex');
    assert.strictEqual(users.isRevoked(ID), true, 'a malformed installId lifts nothing');
    assert.strictEqual(users.getDevice(ID), null, 'and no row was created by any of it');
    assert.strictEqual(typeof users.restoreDevice, 'undefined', '"Allow back" is gone');
}

// ─── 3. Survives a reload ───────────────────────────────────────────────────
{
    const snap = JSON.parse(JSON.stringify(users.snapshot()));
    assert.strictEqual(snap.revokedDevices.length, 1, 'the removal is in the durable snapshot');
    assert.strictEqual(snap.revokedDevices[0].installId, INSTALL_A, 'with the install it removed');
    users.load(snap);
    assert.strictEqual(users.isRevoked(ID), true, 'and comes back from it');
    assert.strictEqual(users.registerDevice(ID, { installId: INSTALL_A }).revoked, true,
        'still unable to re-register itself after a reload');
}

// ─── 4. A reinstall lifts it — as a NEW, UNASSIGNED device ──────────────────
{
    const r = users.registerDevice(ID, { model: 'Galaxy A14', installId: INSTALL_B });
    assert.ok(r && r.id === ID, 'a new install of the same phone registers: ' + JSON.stringify(r));
    assert.strictEqual(users.isRevoked(ID), false, 'the removal is lifted');
    assert.strictEqual(store.forwardingFor(ID), true, 'and it forwards again');
    const d = users.getDevice(ID);
    assert.strictEqual(d.userId, null, 'NOT assigned to the old owner');
    assert.strictEqual(users.simFor(ID), null, 'and the old SIM number is not kept');
    assert.strictEqual(d.name, 'Galaxy A14', 'nor the old name');
    assert.strictEqual(d.installId, INSTALL_B, 'the new install is recorded');
    assert.ok(users.snapshot().revokedDevices.every(x => x.id !== ID), 'and the record is gone');
}

// ─── 5. The first contact after a reinstall may be an SMS ───────────────────
{
    users.removeDevice(ID);
    assert.strictEqual(store.forwardingFor(ID), false, 'removed again');
    users.noteInstall(ID, 'dddddddddddddddd');      // what /sms does before deciding
    assert.strictEqual(users.isRevoked(ID), false,
        'a reinstalled phone\'s first SMS must not be declined as if it were still removed');
    assert.strictEqual(store.forwardingFor(ID), true, 'it forwards');
    assert.strictEqual(users.getDevice(ID), null, 'and it is a new device once it registers');
    users.registerDevice(ID, { model: 'Galaxy A14', installId: 'dddddddddddddddd' });
}

// ─── 6. A removal that did not know its install BINDS the first one to call ─
//
// A phone removed while offline (or whose row predates 4.39.0) has no confirmed
// install. The first install to make contact is bound to the removal and stays
// removed; a later, different install is a reinstall and lifts it. Without the
// binding such a removal could never be lifted: the stable id survives the
// reinstall (review finding).
{
    const OLD = 'eeeeeeeeeeeeeeee';
    users.registerDevice(OLD, { model: 'Old app phone' });     // no installId: app < 4.34
    users.removeDevice(OLD);
    assert.strictEqual(users.snapshot().revokedDevices.find(r => r.id === OLD).installId, null,
        'recorded without an install');
    users.noteInstall(OLD, INSTALL_B);
    assert.strictEqual(users.isRevoked(OLD), true, 'the first install to call is bound, and stays removed');
    assert.strictEqual(users.snapshot().revokedDevices.find(r => r.id === OLD).installId, INSTALL_B,
        'and the binding is durable');
    assert.strictEqual(users.registerDevice(OLD, { installId: INSTALL_B }).revoked, true,
        'registering from that install is refused');
    users.noteInstall(OLD, INSTALL_A);
    assert.strictEqual(users.isRevoked(OLD), false, 'a different install afterwards is a reinstall');

    // A legacy record (4.36–4.38 shape) loads, stays blocked, and binds the same way.
    const snap = JSON.parse(JSON.stringify(users.snapshot()));
    snap.revokedDevices.push({ id: 'ffffffffffffffff', at: 1, device: { name: 'X', model: 'Y', userId: 'rahim' } });
    users.load(snap);
    assert.strictEqual(users.isRevoked('ffffffffffffffff'), true, 'a legacy record is still a removal');
    users.noteInstall('ffffffffffffffff', INSTALL_A);
    assert.strictEqual(users.isRevoked('ffffffffffffffff'), true, 'its first caller is bound, not let in');
}

// ─── 6b. A STALE stored install must not let the same install lift itself ───
//
// The review's repro: a reinstall seen while running from the cache is never
// saved, the Firestore load puts the OLD installId back, and a removal that
// recorded that stale value was lifted by the very install it removed.
{
    const S = '4444444444444444';
    users.registerDevice(S, { model: 'Stale', installId: INSTALL_A });
    const snap = JSON.parse(JSON.stringify(users.snapshot()));
    snap.devices.find(d => d.id === S).installId = 'cccccccccccccccc';   // what the store still holds
    users.load(snap);
    assert.strictEqual(users.getDevice(S).installId, INSTALL_A,
        'the install actually talking to us outranks the stale stored one');
    users.removeDevice(S);
    users.noteInstall(S, INSTALL_A);
    assert.strictEqual(users.isRevoked(S), true, 'so the same install stays removed');

    // After a restart nothing is confirmed: the removal records no install and binds.
    users.noteInstall(S, INSTALL_B);                     // a reinstall: lifts
    users.registerDevice(S, { model: 'Stale', installId: INSTALL_B });
    delete users.getDevice(S).liveInstallId;             // as after a restart
    users.removeDevice(S);
    users.noteInstall(S, INSTALL_B);
    assert.strictEqual(users.isRevoked(S), true, 'unconfirmed: the caller is bound, still removed');
    users.noteInstall(S, INSTALL_A);
    assert.strictEqual(users.isRevoked(S), false, 'and a different install lifts it');
    // Unconfirmed but with a stored install: a REINSTALL as the first contact is
    // recognised by the hint, not bound (it would have needed a second reinstall).
    users.registerDevice(S, { model: 'Stale', installId: INSTALL_A });
    delete users.getDevice(S).liveInstallId;             // restart; stored install is A
    users.removeDevice(S);
    users.load(JSON.parse(JSON.stringify(users.snapshot())));
    assert.strictEqual(users.isRevoked(S), true, 'setup: removal survives a reload');
    users.registerDevice(S, { model: 'Stale', installId: INSTALL_B });
    assert.strictEqual(users.isRevoked(S), false, 'a reinstall first is let back in by the hint');
    delete users.getDevice(S).liveInstallId;
    users.removeDevice(S);
    users.noteInstall(S, INSTALL_B);
    assert.strictEqual(users.isRevoked(S), true, 'while the hinted install itself stays removed');
}

// ─── 6c. A reinstall that lifted a removal during the load is kept ──────────
{
    const L = '5555555555555555';
    users.registerDevice(L, { model: 'Lifted', installId: INSTALL_A });
    users.removeDevice(L);
    const stored = JSON.parse(JSON.stringify(users.snapshot()));   // the removal, as saved
    users.registerDevice(L, { model: 'Lifted', installId: INSTALL_B });   // reinstall, unsaved
    assert.strictEqual(users.isRevoked(L), false, 'setup: lifted in memory');
    users.load(stored);
    assert.strictEqual(users.isRevoked(L), false,
        'the load must not put back a removal that a reinstall lifted meanwhile');
    assert.ok(users.getDevice(L), 'and the new device row is kept');
}

// ─── 6d. Two phones on one ANDROID_ID are flagged, not written every poll ───
{
    const T = '6666666666666666';
    users.registerDevice(T, { model: 'Clone', installId: INSTALL_A });
    users.noteInstall(T, INSTALL_B);
    users.noteInstall(T, INSTALL_A);
    const row = users.listDevices().find(d => d.id === T);
    assert.strictEqual(row.sharedId, true, 'alternating installs are flagged for the dashboard');
    assert.strictEqual(row.liveInstallId, undefined, 'and the bookkeeping is not published');
}

// ─── 7. An ordinary (not removed) reinstall keeps the device as it is ───────
{
    const P = '1111111111111111';
    users.registerDevice(P, { model: 'Pixel', installId: INSTALL_A });
    users.setDeviceSim(P, '01799999999');
    users.registerDevice(P, { model: 'Pixel', installId: INSTALL_B });
    assert.strictEqual(users.simFor(P), '01799999999',
        'a reinstall of a phone nobody removed is the same device — it keeps its SIM');
    assert.strictEqual(users.getDevice(P).installId, INSTALL_B, 'with the new install recorded');
}

// ─── 8. Inactivity: hidden after 7 days, deleted after 15 ───────────────────
{
    const Q = '2222222222222222';
    users.registerDevice(Q, { model: 'Quiet phone', installId: INSTALL_A });
    const row = () => users.listDevices().find(d => d.id === Q);
    assert.strictEqual(row().inactive, false, 'a device just seen is active');

    const d = users.getDevice(Q);
    d.lastSeen = 0;
    d.seenAt = Date.now() - 8 * DAY;
    assert.strictEqual(row().inactive, true, 'silent for 8 days: flagged inactive (hidden)');
    assert.strictEqual(users.sweepInactive(), 0, 'but NOT deleted yet');

    // Inactivity survives a reload: seenAt is persisted.
    users.load(JSON.parse(JSON.stringify(users.snapshot())));
    assert.strictEqual(row().inactive, true, 'still inactive after a reload');

    // Checking in makes it active again (the poll calls touchDevice).
    users.touchDevice(Q);
    assert.strictEqual(row().inactive, false, 'a poll brings it back into the list');

    const d2 = users.getDevice(Q);
    d2.lastSeen = 0;
    d2.seenAt = Date.now() - 16 * DAY;
    assert.strictEqual(users.sweepInactive(), 1, 'silent for 16 days: the sweep deletes it');
    assert.strictEqual(users.getDevice(Q), null, 'gone');
    assert.strictEqual(users.isRevoked(Q), false,
        'deleted is not removed: if it ever checks in again it registers as a new device');
    const back = users.registerDevice(Q, { model: 'Quiet phone', installId: INSTALL_A });
    assert.ok(back && back.id === Q && back.userId === null, 'and does, unassigned');
}

// ─── 9. Upgrading from before 4.39.0 deletes nothing ────────────────────────
{
    const snap = JSON.parse(JSON.stringify(users.snapshot()));
    for (const d of snap.devices) { delete d.seenAt; d.createdAt = Date.now() - 300 * DAY; }
    users.load(snap);
    assert.strictEqual(users.sweepInactive(), 0,
        'stored devices with no seenAt get a fresh clock, not a mass deletion');
    assert.ok(users.listDevices().every(d => !d.inactive), 'and none is hidden');
}

// ─── 10. Removing an unknown id is not a way to pre-block a phone ───────────
assert.strictEqual(users.removeDevice('3333333333333333').ok, false, 'nothing to remove');
assert.strictEqual(users.isRevoked('3333333333333333'), false, 'and nothing is recorded');

console.log('ok — Remove lasts until a reinstall, which brings the phone back as a new '
    + 'unassigned device; inactive devices are hidden after 7 days and deleted after 15');
