/**
 * test/revoke.test.js — "Remove" has to mean removed.
 *
 * =============================================================================
 * THE BUTTON USED TO DO NOTHING, AND THAT IS THE WHOLE POINT OF THIS FILE
 *
 * The phone generates its own id and re-registers on every process start — an
 * FCM wake, the 4-minute alarm chain, a reboot. So removing a device deleted a
 * row that the same phone put straight back, unassigned, within minutes. It
 * looked like a revocation and was a refresh.
 *
 * A removal is now remembered, survives a reload, refuses registration, and
 * stops the device forwarding server-side. The only way back is a registration
 * that names an active user — or the admin allowing it back.
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
const rahim = users.createUser('Rahim');
assert.ok(rahim.ok, 'setup: user created');

const ID = 'cccccccccccccccc';
users.registerDevice(ID, { model: 'Galaxy A14' });

// ─────────────────────────────────────────────────────────────────────────────
// 1. Before removal: an ordinary device, forwarding, re-registering freely.
// ─────────────────────────────────────────────────────────────────────────────
assert.strictEqual(store.forwardingFor(ID), true, 'a registered device forwards');

// ─────────────────────────────────────────────────────────────────────────────
// 2. REMOVAL IS A STANDING BLOCK, not a deletion.
//
// Enforced server-side, which is the only place it can be enforced: the phone
// may be asleep, offline, or force-stopped by a battery manager and will never
// have heard. That is precisely the phone you are removing.
// ─────────────────────────────────────────────────────────────────────────────
assert.strictEqual(users.removeDevice(ID).ok, true, 'removal succeeds');
assert.strictEqual(users.isRevoked(ID), true, 'and is remembered');
assert.strictEqual(store.forwardingFor(ID), false,
    'a removed device must stop forwarding immediately, whatever it believes');
assert.strictEqual(users.listRevoked().length, 1,
    'and must be visible on the dashboard — a device that vanishes without trace '
    + 'is indistinguishable from one that was never installed');

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE BUG THIS FIXES: a bare re-registration must NOT bring it back.
// ─────────────────────────────────────────────────────────────────────────────
{
    const r = users.registerDevice(ID, { model: 'Galaxy A14' });
    assert.strictEqual(r.revoked, true,
        'the exact call the app makes on every process start must be refused');
    assert.strictEqual(r.needsUsername, true, 'and must say what would lift it');
    assert.ok(/username/i.test(r.error), 'in words a phone holder can act on: ' + r.error);
    assert.strictEqual(users.getDevice(ID), null, 'no row may be created');
    assert.strictEqual(store.forwardingFor(ID), false, 'and it still may not forward');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. A WRONG OR UNKNOWN USERNAME LIFTS NOTHING.
// ─────────────────────────────────────────────────────────────────────────────
{
    assert.strictEqual(users.registerDevice(ID, { claimedUser: 'nobody' }).revoked, true,
        'an unknown user must not reactivate');
    users.setActive('rahim', false);
    assert.strictEqual(users.registerDevice(ID, { claimedUser: 'Rahim' }).revoked, true,
        'and neither must a DEACTIVATED one — deactivating is how you take someone '
        + 'out of the system, so it cannot be a way back in');
    users.setActive('rahim', true);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE WAY BACK: a registration naming an active user.
//
// Reactivation IS a registration that carries a claim — one path, one set of
// rules — and succeeding at it assigns the phone to that user in the same act.
// ─────────────────────────────────────────────────────────────────────────────
{
    const back = users.registerDevice(ID, { model: 'Galaxy A14', claimedUser: 'Rahim' });
    assert.ok(back && back.id === ID, 'a valid username brings the device back: '
        + JSON.stringify(back));
    assert.strictEqual(users.isRevoked(ID), false, 'and clears the block');
    assert.strictEqual(store.forwardingFor(ID), true, 'and forwarding resumes');
    assert.strictEqual(users.ownerOf(ID), 'rahim',
        'and records WHO brought it back, which is half the value of asking');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5b. THE ASSIGNMENT MUST SURVIVE THE ROUND TRIP.
//
// The phone forgets its claimed username the moment it is revoked — it is the
// key to the gate, and a handset that still holds it is not a gate. So the
// phone can no longer say who it belongs to, and if the server did not remember
// then every device coming back would arrive as an unassigned stranger needing
// to be re-linked by hand. Both ways back must be a true undo.
// ─────────────────────────────────────────────────────────────────────────────
{
    users.setDeviceSim(ID, '01788888888');
    users.renameDevice(ID, "Rahim's phone");
    assert.strictEqual(users.ownerOf(ID), 'rahim', 'setup: assigned before removal');

    users.removeDevice(ID);
    assert.strictEqual(users.listRevoked()[0].userId, 'rahim',
        'the removed list must say who it belonged to, so Allow back is an informed '
        + 'click and not a hex string you have to recognise');

    // Back via the username, with NO claim carried by the phone — which is
    // exactly what a real reactivation looks like now.
    const back = users.registerDevice(ID, { claimedUser: 'Rahim' });
    assert.ok(back && back.id === ID, 'reactivation succeeds');
    assert.strictEqual(users.ownerOf(ID), 'rahim', 'and the assignment is intact');
    assert.strictEqual(users.getDevice(ID).name, "Rahim's phone", 'and the name');
    assert.strictEqual(users.simFor(ID), '01788888888',
        'and the SIM number — losing that would silently make this phone\'s OTPs '
        + 'unfetchable again');
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. A REVOCATION MUST SURVIVE A RELOAD. One that a redeploy undoes is not one.
// ─────────────────────────────────────────────────────────────────────────────
{
    users.removeDevice(ID);
    const snap = JSON.parse(JSON.stringify(users.snapshot()));
    assert.ok(Array.isArray(snap.revokedDevices) && snap.revokedDevices.length === 1,
        'the removal must be in the durable snapshot');

    users.load(snap);
    assert.strictEqual(users.isRevoked(ID), true, 'and must come back from it');
    assert.strictEqual(store.forwardingFor(ID), false, 'still blocked after a reload');
    assert.strictEqual(users.registerDevice(ID, {}).revoked, true,
        'and still unable to re-register itself');
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. THE ADMIN CAN UNDO IT WITHOUT ANYONE TOUCHING THE PHONE.
//
// A mis-click must not cost a trip to wherever that device is.
// ─────────────────────────────────────────────────────────────────────────────
{
    assert.strictEqual(users.restoreDevice(ID).ok, true, 'restore succeeds');
    assert.strictEqual(users.isRevoked(ID), false, 'and lifts the block');
    assert.strictEqual(users.restoreDevice(ID).ok, false,
        'restoring something that is not removed must be refused, not silently "fine"');

    assert.strictEqual(users.ownerOf(ID), 'rahim',
        'Allow back must restore the device as it was, not as a stranger');
    assert.strictEqual(users.simFor(ID), '01788888888', 'SIM number included');

    const r = users.registerDevice(ID, {});
    assert.ok(r && r.id === ID, 'and the phone re-registers by itself, with no username');
    assert.strictEqual(users.ownerOf(ID), 'rahim',
        'and registering with no claim must not undo the restored assignment');
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Removing a device that does not exist is not a way to pre-block an id.
// ─────────────────────────────────────────────────────────────────────────────
assert.strictEqual(users.removeDevice('dddddddddddddddd').ok, false,
    'there is nothing to remove, and inventing a revocation for an unknown id '
    + 'would let a typo silently block a phone that has not registered yet');
assert.strictEqual(users.isRevoked('dddddddddddddddd'), false, 'and nothing is recorded');

console.log('ok — Remove is a standing block: it survives a reload, refuses the '
    + 'registration the app makes on every start, stops forwarding server-side, and '
    + 'is lifted only by an active username or by the admin');
