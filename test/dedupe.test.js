/**
 * test/dedupe.test.js — two holes on the device→server boundary.
 *
 * =============================================================================
 * 1. THE SAME SMS PUSHED TWICE MUST BE STORED ONCE
 *
 * Every defence against a double-send lived on the PHONE: the row claim, the
 * stale window, the forward log. None of them covers the case that actually
 * happens — the server stored the message and the REPLY was lost, so the phone
 * cannot know it succeeded and pushes again.
 *
 * And a duplicate is not harmless. addSms mints a fresh id and supersedes, so a
 * re-push of a code that has ALREADY BEEN FETCHED reinstalls it with
 * consumed:false — the same OTP handed out twice, with the first copy filed as
 * "superseded" in the archive.
 *
 * 2. AN UNRESOLVED SIM MADE THE OTP UNFETCHABLE
 *
 * A carrier that never writes EF_MSISDN leaves the phone unable to read its own
 * number, so the store files under a per-device key. That is correct — two such
 * phones must not collide — but every script asks GET /get?number=01XXXXXXXXX,
 * so the message sat on the dashboard, looked delivered, and could not be
 * reached. Indistinguishable from "the SMS never came".
 *
 * The number is nowhere in the system to be found, so the admin supplies it once
 * per device and the store files under it from then on.
 * =============================================================================
 *
 * Run: node test/dedupe.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

process.env.STATE_FILE       = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-dd-')), 'state.json');
process.env.OTP_PATTERNS     = '(\\d{4,8})';
process.env.USERS_ENABLED    = 'true';
process.env.FIRESTORE_ENABLED = 'false';

const store = require('../lib/store');
const users = require('../lib/users');

// USERS_ENABLED with Firestore off loads an empty, writable identity — see
// store.loadIdentity. Without this, isLoaded() is false and setDeviceSim would
// correctly refuse to persist.
store.loadIdentity();

// ─────────────────────────────────────────────────────────────────────────────
// 1. A duplicate msgId is answered with the ORIGINAL result and stores nothing.
// ─────────────────────────────────────────────────────────────────────────────
{
    const first = store.addSms('IVAC', '01711111111', 'Your OTP is 445566', Date.now(),
                               null, 'msg-aaa');
    const again = store.addSms('IVAC', '01711111111', 'Your OTP is 445566', Date.now(),
                               null, 'msg-aaa');

    assert.strictEqual(again.id, first.id,
        'a duplicate must be answered with the id the message ALREADY has, so the '
        + 'phone marks its row delivered and stops');
    assert.strictEqual(again.duplicate, true, 'and must say so');
    assert.strictEqual(store.getAllSms().filter(m => m.recipient === '01711111111').length, 1,
        'nothing may be stored a second time');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE DAMAGE THE DEDUP PREVENTS: a re-push after a fetch must not resurrect
//    a spent code. This is the reason `duplicate` is not merely tidy.
// ─────────────────────────────────────────────────────────────────────────────
{
    store.addSms('bKash', '01722222222', 'Your OTP is 111222', Date.now(), null, 'msg-bbb');
    assert.strictEqual(store.getOtp('01722222222'), '111222', 'first fetch gets the code');
    assert.strictEqual(store.getOtp('01722222222'), null,
        'consume-on-read: the second fetch gets nothing');

    // The reply to the original push was lost, so the phone sends it again.
    store.addSms('bKash', '01722222222', 'Your OTP is 111222', Date.now(), null, 'msg-bbb');
    assert.strictEqual(store.getOtp('01722222222'), null,
        'a duplicate push must NOT hand a spent OTP out a second time — without the '
        + 'msgId check addSms would reinstall it with consumed:false');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. A DIFFERENT message is not swallowed. The dedup must be exact.
// ─────────────────────────────────────────────────────────────────────────────
{
    const a = store.addSms('IVAC', '01733333333', 'Your OTP is 333444', Date.now(), null, 'msg-ccc');
    const b = store.addSms('IVAC', '01733333333', 'Your OTP is 555666', Date.now(), null, 'msg-ddd');
    assert.notStrictEqual(b.id, a.id, 'two real messages must both be stored');
    assert.strictEqual(store.getOtp('01733333333'), '555666',
        'and the newer one must supersede, exactly as before');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. An older app sends no msgId and is simply not deduplicated — today's
//    behaviour, unchanged. Backwards compatibility is not optional here.
// ─────────────────────────────────────────────────────────────────────────────
{
    const a = store.addSms('IVAC', '01744444444', 'Your OTP is 777888', Date.now());
    const b = store.addSms('IVAC', '01744444444', 'Your OTP is 777888', Date.now());
    assert.notStrictEqual(b.id, a.id,
        'with no msgId there is nothing to match on, and refusing the message would '
        + 'be far worse than storing it twice');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. UNRESOLVED SIM, NO NUMBER SET: filed under the device key, as before.
//    This is the collision protection and it must survive the fix.
// ─────────────────────────────────────────────────────────────────────────────
const devA = users.registerDevice('aaaaaaaaaaaaaaaa', { model: 'Phone A' });
const devB = users.registerDevice('bbbbbbbbbbbbbbbb', { model: 'Phone B' });
{
    store.addSms('IVAC', 'Unknown', 'Your OTP is 900001', Date.now(), devA.id, 'u1');
    store.addSms('IVAC', 'Unknown', 'Your OTP is 900002', Date.now(), devB.id, 'u2');

    const keys = store.getAllSms().filter(m => String(m.recipient).indexOf('Unknown-') === 0)
                      .map(m => m.recipient);
    assert.strictEqual(new Set(keys).size, 2,
        'two phones with an unresolved SIM must NOT share one key — that is one '
        + "person's OTP superseding another's");
    assert.strictEqual(store.getOtp('01799999999'), null,
        'and an unfiled message is, correctly, not reachable by some other number');
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. THE FIX: with a SIM number set, the same message becomes FETCHABLE.
// ─────────────────────────────────────────────────────────────────────────────
{
    // Stored CANONICAL, so a +880 form has to work — otherwise the number is
    // "set" and the messages are still unfetchable, which is the same bug one
    // layer in.
    const r = users.setDeviceSim(devA.id, '+8801755555555');
    assert.strictEqual(r.ok, true, 'the number must save: ' + JSON.stringify(r));
    assert.strictEqual(users.simFor(devA.id), '01755555555',
        'and must be stored in the form /get looks up');

    store.addSms('IVAC', 'Unknown', 'Your OTP is 424242', Date.now(), devA.id, 'u3');

    const sms = store.getAllSms().find(m => m.code === '424242');
    assert.strictEqual(sms.recipient, '01755555555',
        'a message the phone could not file must be filed under the number the '
        + 'admin supplied');
    assert.strictEqual(sms.recipientFromDevice, true,
        'and must SAY the number came from the device record, so the dashboard can too');
    assert.strictEqual(store.getOtp('+88 01755555555'), '424242',
        'THE WHOLE POINT: a script asking by number now reaches it, in any format');
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Long-poll works on an inferred recipient too — it is an ordinary key now,
//    so waiters, supersede and expiry all apply with no special case anywhere.
// ─────────────────────────────────────────────────────────────────────────────
{
    users.setDeviceSim(devB.id, '01766666666');
    const parked = store.waitForOtp('01766666666', 2000, () => {});
    setTimeout(() => store.addSms('IVAC', 'Unknown', 'Your OTP is 131313',
                                  Date.now(), devB.id, 'u4'), 20);

    parked.then(otp => {
        assert.strictEqual(otp, '131313',
            'a parked fetch must be woken by a message that arrived with no resolvable SIM');
        finish();
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Two devices may not claim one number — that would recreate, by hand, the
//    exact collision the device key exists to prevent.
// ─────────────────────────────────────────────────────────────────────────────
{
    const clash = users.setDeviceSim(devA.id, '01766666666');
    assert.strictEqual(clash.ok, false,
        'a number already set on another phone must be refused, not silently shared');
    assert.ok(/already set/.test(clash.error), 'and must say why: ' + clash.error);

    assert.strictEqual(users.setDeviceSim(devA.id, 'not-a-number').ok, false,
        'a value that could never be a recipient key must be refused at the door');

    assert.strictEqual(users.setDeviceSim(devA.id, '').ok, true, 'clearing must work');
    assert.strictEqual(users.simFor(devA.id), null, 'and must actually clear');
}

function finish() {
    console.log('ok — the same SMS pushed twice is stored once and cannot resurrect a '
        + 'spent code, and a phone that cannot read its own SIM number is fetchable '
        + 'once someone says what that number is');
    process.exit(0);
}
