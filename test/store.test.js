/**
 * test/store.test.js — the recipient index must never drift from smsMap.
 *
 * The index is a derived structure. If it ever disagrees with smsMap, a new OTP
 * stops superseding the previous one for the affected number — which surfaces
 * as "/get returned an old code", intermittently, for one number, which is
 * about the worst diagnostic experience the system can produce.
 *
 * So: run a randomised workload through every path that mutates the store, and
 * after each step re-derive the index by brute force and compare.
 *
 * Run: node test/store.test.js       (no test framework, no dependencies)
 */

const assert = require('assert');

process.env.AUTO_DELETE_MINUTES = '30';
// The store logs a line per message; 5,000+ of them would bury the result.
const realLog = console.log;
console.log = () => {};
const store = require('../lib/store');
const { smsMap, byRecipient } = store._internals;

let step = 0;

/** Re-derive the index the slow, obviously-correct way and compare. */
function assertIndexConsistent(what) {
    step++;
    const expected = new Map();
    for (const sms of smsMap.values()) {
        if (!expected.has(sms.recipient)) expected.set(sms.recipient, new Set());
        expected.get(sms.recipient).add(sms.id);
    }

    assert.strictEqual(byRecipient.size, expected.size,
        `step ${step} (${what}): index has ${byRecipient.size} recipients, expected ${expected.size}`);

    for (const [recipient, ids] of expected) {
        const actual = byRecipient.get(recipient);
        assert.ok(actual, `step ${step} (${what}): missing index entry for ${recipient}`);
        assert.deepStrictEqual([...actual].sort(), [...ids].sort(),
            `step ${step} (${what}): index mismatch for ${recipient}`);
    }

    // No empty sets left behind — they would leak one entry per number forever.
    for (const [recipient, ids] of byRecipient) {
        assert.ok(ids.size > 0, `step ${step} (${what}): empty index set for ${recipient}`);
    }
}

// Deterministic pseudo-random so a failure is reproducible.
let seed = 12345;
function rnd(n) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
}

const NUMBERS = ['01711111111', '01822222222', '01933333333', 'Unknown'];

// ── 1. Randomised add / fetch workload ───────────────────────────
for (let i = 0; i < 400; i++) {
    const to = NUMBERS[rnd(NUMBERS.length)];
    switch (rnd(4)) {
        case 0:
            store.addSms('IVAC', to, `Your OTP is ${100000 + rnd(900000)}`, Date.now());
            assertIndexConsistent('addSms with code');
            break;
        case 1:
            // No extractable code: must still be indexed, must not supersede.
            store.addSms('PROMO', to, 'Recharge now and win!', Date.now());
            assertIndexConsistent('addSms without code');
            break;
        case 2:
            store.getOtp(to);
            assertIndexConsistent('getOtp');
            break;
        default:
            // The +880 form must resolve to the same bucket as the 01 form.
            store.getOtp(to === 'Unknown' ? 'Unknown' : '+880' + to.substring(1));
            assertIndexConsistent('getOtp (880 form)');
    }
}

// ── 2. Supersede semantics still hold with the indexed loop ──────
store.clearAll();
store.addSms('IVAC', '01711111111', 'Code 111111', Date.now());
store.addSms('IVAC', '01711111111', 'Code 222222', Date.now());
assert.strictEqual(store.getOtp('01711111111'), '222222', 'newest code must win');
assert.strictEqual(store.getOtp('01711111111'), null, 'consume-on-read: spent after one fetch');
const superseded = store.getAllSms().filter(s => s.status === 'superseded');
assert.strictEqual(superseded.length, 1, 'the older pending message must be superseded');
assertIndexConsistent('supersede');

// A different recipient must be untouched by another's supersede.
store.addSms('IVAC', '01822222222', 'Code 333333', Date.now());
store.addSms('IVAC', '01711111111', 'Code 444444', Date.now());
assert.strictEqual(store.getOtp('01822222222'), '333333',
    'supersede must not cross recipients');
assertIndexConsistent('cross-recipient isolation');

// ── 2b. unconsume: a fetch that never delivered gives the OTP back ──
//
// getOtp() spends the code the instant it hands it over. For a plain fetch that
// is the same act; for a long-poll parked twenty seconds it is not — the client
// can vanish between the two. Without this the code is gone: consumed, never
// received, unfetchable. Tested here rather than over HTTP because the window
// is a few microseconds wide and any HTTP-level test of it is a race.
store.clearAll();
store.addSms('IVAC', '01744444444', 'Code 313131', Date.now());

assert.strictEqual(store.getOtp('01744444444'), '313131', 'fetched');
assert.strictEqual(store.getOtp('01744444444'), null, 'and spent');

assert.strictEqual(store.unconsume('01744444444', '313131'), true, 'restored');
assert.strictEqual(store.getOtp('01744444444'), '313131', 'fetchable again');
assert.strictEqual(store.getOtp('01744444444'), null, 'and spent again');
assertIndexConsistent('unconsume');

// It must restore ONLY the exact code that is still current. These guards are
// what stop it being a way to serve something stale.
assert.strictEqual(store.unconsume('01744444444', '999999'), false,
    'a different code must not be restored');

store.addSms('IVAC', '01755555555', 'Code 111222', Date.now());
assert.strictEqual(store.getOtp('01755555555'), '111222', 'fetched');
store.addSms('IVAC', '01755555555', 'Code 333444', Date.now());   // supersedes it
assert.strictEqual(store.unconsume('01755555555', '111222'), false,
    'a superseded code must not come back');
assert.strictEqual(store.getOtp('01755555555'), '333444',
    'and the newest one is unaffected');

// The +880 form must reach the same entry, as everywhere else.
store.addSms('IVAC', '01766666666', 'Code 777888', Date.now());
assert.strictEqual(store.getOtp('+8801766666666'), '777888', 'fetched via 880 form');
assert.strictEqual(store.unconsume('+8801766666666', '777888'), true,
    'unconsume must canonicalize the number too');
assert.strictEqual(store.getOtp('01766666666'), '777888', 'fetchable again via 01 form');
assertIndexConsistent('unconsume canonicalization');

// ── 3. clearAll leaves nothing behind ────────────────────────────
store.clearAll();
assert.strictEqual(smsMap.size, 0, 'clearAll must empty smsMap');
assert.strictEqual(byRecipient.size, 0, 'clearAll must empty the index');
assertIndexConsistent('clearAll');

// ── 4. Size cap evicts the oldest and keeps the index in step ────
const CAP = store._internals.MAX_MESSAGES;
for (let i = 0; i < CAP + 50; i++) {
    store.addSms('BULK', NUMBERS[i % NUMBERS.length], `filler ${i}`, Date.now());
}
assert.ok(smsMap.size <= CAP, `size cap must hold: ${smsMap.size} > ${CAP}`);
assertIndexConsistent('size cap eviction');

console.log = realLog;

// ─────────────────────────────────────────────────────────────────────────────
// A STALE REPLAY MUST NOT TAKE OVER THE LIVE OTP.
//
// QueueFlusher replays a message for up to 5 minutes on purpose, so one delayed
// by a cold start still arrives. The server had no matching guard: addSms
// superseded unconditionally and stamped a fresh receivedAt, so a 4-minute-old
// replay became the live code AND got another 2 minutes of life as the current
// one. Verified before the fix: /get returned the replay, not the real code.
// ─────────────────────────────────────────────────────────────────────────────
{
    const N = '01799001122';
    store.addSms('IVAC', N, 'Your OTP is 445566', Date.now());
    store.addSms('IVAC', N, 'Your OTP is 111111', Date.now() - 4 * 60 * 1000);
    assert.strictEqual(store.getOtp(N), '445566',
        'a 4-minute-old replay must not supersede the code that just arrived');

    const mine = store.getAllSms().filter(m => m.recipient === N);
    assert.strictEqual(mine.length, 2, 'the replay is still STORED — it is evidence');
    assert.ok(mine.some(m => m.stale), 'and marked stale');

    // ...but a stale message on its own IS still delivered. Excluding it
    // entirely (4.29.0) turned "cannot overwrite a fresher code" into "cannot be
    // delivered at all", in exactly the case QueueFlusher's 5-minute replay
    // window exists for: a cold start delayed the push and nothing else came.
    const LONE = '01799005566';
    store.addSms('IVAC', LONE, 'Your OTP is 778899', Date.now() - 3 * 60 * 1000);
    assert.strictEqual(store.getOtp(LONE), '778899',
        'a delayed replay with nothing to compete against must still be served — '
        + 'refusing it is a missed OTP, which is the failure this system exists to avoid');

    // A device clock skewed into the past must not silence a real message — the
    // same fail-open rule SmsReceiver applies to the SMSC timestamp.
    const N2 = '01799003344';
    store.addSms('IVAC', N2, 'Your OTP is 222222', Date.now() - 40 * 3600 * 1000);
    assert.strictEqual(store.getOtp(N2), '222222',
        'an implausible device timestamp is not trusted, so the message still counts');
}

console.log(`ok — index consistent across ${step} checks; cap, supersede and `
            + `unconsume verified`);
process.exit(0);
