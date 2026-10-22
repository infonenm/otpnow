/**
 * test/teach.test.js — server 4.43.0: smart extraction, Teach from SMS, "SMS not read".
 *
 * What must hold:
 *   1. The number-word engine reads a spelled code with ANY separator (space,
 *      '_', '-', '.', '*', glued "SevenSeven"), "double", single digits, and
 *      Bengali words — and returns NOTHING rather than a wrong code: two
 *      different codes, an amount ("Tk 2,000.00"), a stray "one".
 *   2. convertTextToNumber keeps its contract (digits only, null when none).
 *   3. @words is a valid pattern; an unknown @reader is refused at save.
 *   4. Teach builds a pattern that reads exactly the code, anchored on a word;
 *      refuses DEFAULT, a code not in the SMS, a rule shadowed by another;
 *      moves a pattern that misreads the SMS below @words; and BLOCKS a change
 *      that would break a message taught before.
 *   5. Examples: capped per rule, kept as their own config field, and written
 *      to Firestore only when known (merge otherwise).
 *   6. End to end over HTTP: an unread IVAC SMS is listed and alerted (no text,
 *      no code in the push), Teach applies, the WAITING SMS is re-read and /get
 *      serves it; a stale Test is refused (409); a filter save that breaks an
 *      example warns; everything is admin only.
 *   7. Extraction stays fast.
 *
 * Run: node test/teach.test.js
 */
const assert = require('assert');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

process.env.DASHBOARD_PASSWORD = 'admin-pw';
process.env.API_KEY            = 'test-key';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-teach-'));
process.env.STATE_FILE         = path.join(DIR, 's.json');
process.env.PORT               = '3989';

const fcm = require('../lib/fcm');
const pushes = [];
fcm.send = async (action, ts, topic, extra) => { pushes.push({ action, topic, data: extra || {} }); };

const real = console.log; console.log = () => {};
const otp   = require('../lib/otp');
const teach = require('../lib/teach');
const store = require('../lib/store');
console.log = real;

// ═════════════════════════════════════════════════════════════════
// 1. The reader
// ═════════════════════════════════════════════════════════════════
const IVAC = '(IVACBD) For security, type the following sequence when prompted Seven_Seven_Eight_Zero_Five_Zero .';
const READER = [
    [IVAC, '778050'],
    ['prompted Four-Two-Six-One to continue.', '4261'],
    ['prompted SEVEN SEVEN EIGHT ZERO FIVE ZERO', '778050'],
    ['prompted Seven.Seven.Eight.Zero.Five.Zero', '778050'],
    ['prompted SevenSevenEightZeroFiveZero now', '778050'],
    ['prompted Seven*Seven*Eight*Zero*Five*Zero', '778050'],
    ['prompted Seven / Seven / Eight / Zero', '7780'],
    ['prompted 7_7_8_0_5_0 .', null],                                         // no number WORD: not @words' job
    ['Sequence 2: Seven_Seven_Eight_Zero_Five_Zero .', '778050'],             // a label before it is dropped
    ['Enter the sequence for step one: Seven_Seven_Eight_Zero_Five_Zero', '778050'],
    ['Use one-time code Four Two Six One', '4261'],
    ['prompted Double Seven Eight Zero Five Zero', '778050'],
    ['আপনার কোড সাত সাত আট শূন্য পাঁচ শূন্য', '778050'],
    // য় written as ONE code point (U+09DF) instead of two
    ['কোড \u099B\u09DF \u09A8\u09DF \u098F\u0995 \u09A6\u09C1\u0987', '6912'],
    // Fail safe: nothing rather than something wrong
    ['prompted Seven-Seven-Eight-Zero-Five-Zero . One-time code', '778050'],   // " . " ends the run
    ['Code Seven_Seven_Eight_Zero and also One Two Three Four', null],        // two different codes
    ['Pay Tk 2,000.00 within 10 min', null],                                  // an amount is not a code
    ['someone eighteen seventy one two three', null],
    ['constructor toString valueOf one two', null],                           // no prototype lookups
    ['Your OTP is 778050', null],                                             // plain digits: not @words' job
    ['Seven\nSeven\nEight\nZero', null],                                      // never across lines
    ['Seven Seven-Eight Zero', null],                                         // separator changes mid-run
    // Review 4.43.0: these returned a CUT-OFF code (8050, 1998) before.
    ['Seven-Seven_Eight_Zero_Five_Zero', null],
    ['prompted Seven_Seven__Eight_Zero_Five_Zero .', null],
    ['Four Two Six  One Nine Nine Eight', null],
    ['four two six one one-time', null],                                      // "one-time" is not a digit
    ['prompted Seven_Seven_Eight_Zero_Five_Zero_Thanks', null],
    ['Your IVAC OTP is 445566. Counter 1 2 3 4', null],
    ['Slot 9-1-0-0', null],
    ['Your code is 445566, valid one time. Ref one two three four.', null],   // a DIFFERENT labelled code
    ['Use code 778050 (Seven Seven Eight Zero Five Zero) to log in', '778050'],
    ['prompted Nine_Nine_One_Two_Three_Four. Tk 2000', '991234']             // an unlabelled amount is fine
];
for (const [msg, want] of READER) {
    assert.strictEqual(otp.readWordCode(otp.normalizeDigits(msg)), want, `@words on ${JSON.stringify(msg)}`);
}

// ═════════════════════════════════════════════════════════════════
// 2. convertTextToNumber — the capture converter
// ═════════════════════════════════════════════════════════════════
assert.strictEqual(otp.convertTextToNumber('G-123456'), '123456');
assert.strictEqual(otp.convertTextToNumber('Seven_Seven_Eight_Zero_Five_Zero'), '778050');
assert.strictEqual(otp.convertTextToNumber('Four-Two-Six-One'), '4261');
assert.strictEqual(otp.convertTextToNumber('one two three four'), '1234');
assert.strictEqual(otp.convertTextToNumber('Seven'), null, 'never a code under 4 digits ("7" was served before)');
assert.strictEqual(otp.convertTextToNumber('Four-Two-Six-One. Pay Tk 2000.00'), null, 'spelled code + other digits: unclear');
assert.strictEqual(otp.convertTextToNumber('double seven one two'), '7712');
// A capture with digits is a digit code: words in it never add digits
// (Bengali এক = "a", নয় = "not"; review 4.43.0).
assert.strictEqual(otp.convertTextToNumber('445566 \u098F\u0995 \u09AC\u09BE\u09B0'), '445566');
assert.strictEqual(otp.convertTextToNumber('One-Time Password 1234'), '1234');
assert.strictEqual(otp.convertTextToNumber('someone'), null);
assert.strictEqual(otp.convertTextToNumber('Hello_World'), null);
assert.strictEqual(otp.convertTextToNumber(''), null);

// ═════════════════════════════════════════════════════════════════
// 3. @words as a pattern
// ═════════════════════════════════════════════════════════════════
assert.strictEqual(otp.validatePattern('@words'), null);
assert.strictEqual(otp.validatePattern(' @Words '), null);
assert.ok(/built-in/.test(otp.validatePattern('@digits')), 'an unknown reader is refused with a reason');
{
    const f = [{ phoneNumber: 'IVACBD', patterns: ['prompted\\s+(\\d{4,8})', '@words'] },
               { phoneNumber: 'DEFAULT', patterns: ['(\\d{4,8})'] }];
    const r = otp.extractDetailed(IVAC, 'IVACBD', '01711111111', f);
    assert.deepStrictEqual(r, { code: '778050', rule: 'IVACBD', pattern: '@words' });
    assert.deepStrictEqual(otp.extractDetailed('Hello there', 'IVACBD', '', f),
        { code: null, rule: 'IVACBD', pattern: null }, 'the claiming rule is reported even with no code');
    assert.strictEqual(otp.extractDetailed('code 4455', 'GP', '', f).rule, 'DEFAULT');
    // @words UNCLEAR stops the rule: a later catch-all never reads the amount.
    const g = [{ phoneNumber: 'IVACBD', patterns: ['@words', '(\\d{4,8})'] }];
    assert.strictEqual(otp.extractCode('Pay Tk 2000. Seven-Seven_Eight_Zero_Five_Zero', 'IVACBD', '', g), null);
    // No spelled code at all: the next pattern still runs.
    assert.strictEqual(otp.extractCode('Your OTP is 445566', 'IVACBD', '', g), '445566');
    // The unread alert needs a code keyword or a spelled code — not just digits.
    assert.strictEqual(otp.looksLikeOtp('Cash In Tk 5,000.00 from 01711111111. Balance Tk 12,345.67'), false);
    assert.strictEqual(otp.looksLikeOtp(IVAC), true);
}

// ═════════════════════════════════════════════════════════════════
// 4. Teach — analyse
// ═════════════════════════════════════════════════════════════════
const BASE = [
    { phoneNumber: 'DEFAULT', patterns: ['\\bis\\s+(\\d{4,8})\\b', '(\\d{4,8})'] },
    { phoneNumber: 'IVAC_BD', patterns: ['prompted\\s+((?:[A-Za-z]+-?)+)'] },
    { phoneNumber: 'bKash',   patterns: ['\\bOTP\\b[^0-9]{0,25}(\\d{4,8})\\b'] }
];
{
    const a = teach.analyze({ message: IVAC, otpPart: 'Seven_Seven_Eight_Zero_Five_Zero', rule: 'IVACBD',
                              filters: BASE, examples: [] });
    assert.ok(a.ok && a.canApply, JSON.stringify(a.blocked || a.error));
    assert.strictEqual(a.rule, 'IVAC_BD', 'IVACBD is the existing IVAC_BD rule');
    assert.strictEqual(a.code, '778050');
    assert.strictEqual(a.format, 'spelled');
    assert.strictEqual(a.anchor, 'prompted');
    assert.strictEqual(a.nowReads, null, 'today the old pattern reads nothing (4.42.4 served "7")');
    const statuses = a.patterns.map(p => p.status);
    assert.deepStrictEqual(statuses, ['new', 'added', 'moved'],
        'new pattern first, @words added as the net, the pattern that matches but cannot read it moved last');
    assert.ok(/reads no code/.test(a.patterns[2].note), a.patterns[2].note);
    assert.strictEqual(a.patterns[1].pattern, '@words');
    assert.strictEqual(otp.extractCode(IVAC, 'IVACBD', '', a.proposedFilters), '778050');
    // The digits alone as the OTP part find the same place.
    const b = teach.analyze({ message: IVAC, otpPart: '778050', rule: 'IVACBD', filters: BASE, examples: [] });
    assert.strictEqual(b.pattern, a.pattern, 'digits or words — the same pattern');
    // Readable: an English SMS gets English words only.
    assert.ok(!/[\u0980-\u09FF]/.test(a.pattern), a.pattern);

    // A later format change is checked against the first one.
    const ex = teach.addExample([], { rule: a.rule, sender: 'IVACBD', message: IVAC, code: a.code, at: 1 });
    const next = 'IVACBD: Security sequence, enter when asked: Four-Two-Six-One-Nine-Nine';
    const c = teach.analyze({ message: next, otpPart: 'Four-Two-Six-One-Nine-Nine', rule: 'IVACBD',
                              filters: a.proposedFilters, examples: ex });
    assert.ok(c.canApply);
    assert.strictEqual(c.checks.length, 2, 'this SMS + the taught one');
    assert.ok(c.checks.every(x => x.ok));
    assert.strictEqual(otp.extractCode(IVAC, 'IVACBD', '', c.proposedFilters), '778050', 'old format still reads');
    assert.strictEqual(otp.extractCode(next, 'IVACBD', '', c.proposedFilters), '426199');
}
{
    // Digits next to an amount: the anchor makes it the code, never the amount.
    const msg = 'Pay Tk 2000. Your bKash OTP code: 445566 valid 2 min';
    const a = teach.analyze({ message: msg, otpPart: '445566', rule: 'bKash', filters: BASE, examples: [] });
    assert.ok(a.canApply);
    assert.strictEqual(a.format, 'digits');
    assert.strictEqual(otp.extractCode(msg, 'bKash', '', a.proposedFilters), '445566');
    assert.strictEqual(otp.extractCode('Pay Tk 2000 now', 'bKash', '', [{ phoneNumber: 'bKash', patterns: [a.pattern] }]),
        null, 'the taught pattern does not read an amount');
}
{
    // EDGES (review 4.43.0): a taught pattern never reads a digit too many.
    const read = (taught, part, later) => {
        const a = teach.analyze({ message: taught, otpPart: part, rule: 'IVACBD', filters: BASE, examples: [] });
        assert.ok(a.canApply, JSON.stringify(a.error || a.blocked));
        return otp.extractCode(later, 'IVACBD', '', [{ phoneNumber: 'IVACBD', patterns: [a.pattern] }]);
    };
    assert.strictEqual(read('Your IVAC code is four two six one.', 'four two six one',
                            'Your IVAC code is four two six one eighty'), '4261');
    assert.notStrictEqual(read('Your IVAC code is four two six one.', 'four two six one',
                               'Your IVAC code is four two six one one-time'), '42611');
    assert.strictEqual(read('four two six one is the code', 'four two six one',
                            'Phone four two six one is the code'), '4261', 'not 14261 — "one" inside "Phone" is not a digit');
    assert.strictEqual(read('445566 is your IVAC OTP', '445566', '12345678901 is your IVAC OTP'), null);
    // Not asserted: "…Five_Zero_One time" SPELLS seven digits with one separator
    // all through — a person reads it the same way. Glued compounds
    // ("Zero_Thanks", "one-time") are what the edge rules can and do catch.
    assert.strictEqual(read(IVAC, '778050', IVAC.replace('Zero .', 'Zero_Thanks .')), null);
}
{
    // The code twice in one SMS: refused, never anchored on the amount.
    const a = teach.analyze({ message: 'Pay Tk 2000 now. Your IVAC OTP is 2000', otpPart: '2000', rule: 'IVACBD',
                              filters: BASE, examples: [] });
    assert.ok(!a.ok && /appears 2 times/.test(a.error), a.error);
}
{
    // A rule named by SIM number: taught with the receiving SIM.
    const f = [{ phoneNumber: 'DEFAULT', patterns: ['(\\d{4,8})'] }, { phoneNumber: '01711111111', patterns: ['(\\d{6})'] }];
    const a = teach.analyze({ message: 'IVAC: prompted Four_Two_Six_One', otpPart: '4261', rule: '01711111111',
                              sender: 'IVACBD', recipient: '01711111111', filters: f, examples: [] });
    assert.ok(a.ok && a.canApply, a.error);
    assert.strictEqual(otp.extractCode('IVAC: prompted Four_Two_Six_One', 'IVACBD', '01711111111', a.proposedFilters), '4261');
    // Its example keeps the recipient, so later checks still see it.
    const ex = teach.addExample([], { rule: a.rule, sender: 'IVACBD', recipient: '01711111111',
                                      message: 'IVAC: prompted Four_Two_Six_One', code: '4261', at: 1 });
    assert.deepStrictEqual(teach.brokenExamples(a.proposedFilters, ex), []);
}
{
    // Re-teaching the same Bengali-digit message is not blocked by its own example.
    const bn = 'IVAC কোড \u09ea\u09ea\u09eb\u09eb\u09ec\u09ec দিন';
    const f = [{ phoneNumber: 'IVACBD', patterns: ['(\\d{6})'] }];
    const ex = [{ rule: 'IVACBD', sender: 'IVACBD', message: bn, code: '999999', at: 1 }];
    const a = teach.analyze({ message: bn, otpPart: '445566', rule: 'IVACBD', filters: f, examples: ex });
    assert.ok(a.canApply, JSON.stringify(a.blocked));
}
{
    // Refusals, each with a reason.
    const bad = (p, re) => { const a = teach.analyze(Object.assign({ filters: BASE, examples: [] }, p));
                             assert.ok(!a.ok && re.test(a.error), `${JSON.stringify(p)} → ${a.error}`); };
    bad({ message: IVAC, otpPart: '778050', rule: 'DEFAULT' }, /not DEFAULT/);
    bad({ message: IVAC, otpPart: '999999', rule: 'IVACBD' }, /Could not find 999999/);
    bad({ message: IVAC, otpPart: '12', rule: 'IVACBD' }, /4–10 digits/);
    bad({ message: '', otpPart: '1234', rule: 'IVACBD' }, /Paste the full SMS/);
    bad({ message: IVAC, otpPart: '', rule: 'IVACBD' }, /OTP part/);
    bad({ message: IVAC, otpPart: '778050', rule: '' }, /sender rule/);
    // A rule that never runs: "IVAC" comes first and claims IVACBD.
    const shadow = [{ phoneNumber: 'IVAC', patterns: ['(\\d{6})'] }, { phoneNumber: 'IVACBD', patterns: ['(\\d{4})'] }];
    const s = teach.analyze({ message: IVAC, otpPart: '778050', rule: 'IVACBD', filters: shadow, examples: [] });
    assert.ok(!s.ok && /claimed by the rule "IVAC"/.test(s.error), s.error);
}
{
    // BLOCKED: the new pattern would misread a message taught earlier.
    const old = 'IVACBD code A: Four_Four_Five_Five_Six_Six, prompted One_Two_Three_Four_Five_Six';
    const ex = [{ rule: 'IVACBD', sender: 'IVACBD', message: old, code: '445566', at: 5 }];
    const f = [{ phoneNumber: 'IVACBD', patterns: ['A:\\s*((?:[A-Za-z]+_?)+)'] }];
    const a = teach.analyze({ message: 'IVACBD prompted One_Two_Three_Four', otpPart: '1234', rule: 'IVACBD',
                              filters: f, examples: ex });
    assert.ok(a.ok && !a.canApply, 'must be blocked');
    assert.ok(/should read 445566, would read 123456/.test(a.blocked[0]), a.blocked[0]);
}

// ═════════════════════════════════════════════════════════════════
// 5. Examples: caps and Firestore
// ═════════════════════════════════════════════════════════════════
{
    let ex = [];
    for (let i = 0; i < 14; i++) ex = teach.addExample(ex, { rule: 'IVACBD', message: 'm' + i, code: '1234', at: i + 1 });
    assert.strictEqual(ex.length, teach.EXAMPLES_PER_RULE, 'capped per rule');
    assert.strictEqual(ex[0].message, 'm4', 'oldest dropped first');
    ex = teach.addExample(ex, { rule: 'IVAC_BD', message: 'm13', code: '9999', at: 99 });
    assert.strictEqual(ex.filter(e => e.message === 'm13').length, 1, 'same message, same rule: replaced');
    assert.strictEqual(teach.sanitizeExamples([{ rule: 'DEFAULT', message: 'x', code: '1234' },
        { rule: 'A', message: 'x', code: '12' }, { rule: 'A', message: '', code: '1234' }, null]).length, 0);
    assert.deepStrictEqual(teach.removeExample(ex, 'ivac bd', 99).removed, 1);
}
// ═════════════════════════════════════════════════════════════════
// 7. Speed
// ═════════════════════════════════════════════════════════════════
{
    const f = [{ phoneNumber: 'IVACBD', patterns: ['prompted\\s+(\\d{4,8})', '@words'] },
               { phoneNumber: 'DEFAULT', patterns: ['(\\d{4,8})'] }];
    for (let i = 0; i < 2000; i++) otp.extractCode(IVAC, 'IVACBD', '01711111111', f);
    const N = 20000, t = process.hrtime.bigint();
    for (let i = 0; i < N; i++) otp.extractCode(IVAC, 'IVACBD', '01711111111', f);
    const us = Number(process.hrtime.bigint() - t) / N / 1000;
    assert.ok(us < 100, `extraction took ${us.toFixed(1)} µs — must stay well under 0.1 ms`);
    const adv = 'prompted ' + 'seven_'.repeat(20000) + 'x';
    const t2 = Date.now();
    otp.extractCode(adv, 'IVACBD', '', f);
    assert.ok(Date.now() - t2 < 200, 'a hostile 120 KB message cannot stall extraction');
}

// ═════════════════════════════════════════════════════════════════
// 6. End to end
// ═════════════════════════════════════════════════════════════════
console.log = () => {};
require('../server.js');

function req(method, p, { body, token, apiKey } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        if (token)  headers.Authorization = 'Bearer ' + token;
        if (apiKey) headers['X-Api-Key'] = apiKey;
        const r = http.request({ host: '127.0.0.1', port: 3989, method, path: p, headers }, res => {
            let raw = ''; res.on('data', c => raw += c);
            res.on('end', () => { let b = null; try { b = JSON.parse(raw); } catch (e) { /* */ }
                                  resolve({ status: res.statusCode, body: b }); });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SIM = '01719749470';

(async () => {
    await sleep(300);
    const admin = (await req('POST', '/api/login', { body: { password: 'admin-pw' } })).body.token;
    assert.ok(admin);

    // Admin only.
    assert.strictEqual((await req('GET', '/api/teach')).status, 401);
    assert.strictEqual((await req('POST', '/api/teach/test', { body: {} })).status, 401);

    // A rule that does not read the new format at all.
    const save = await req('POST', '/api/filters', { token: admin, body: { filters: [
        { phoneNumber: 'DEFAULT', patterns: ['(\\d{4,8})'] },
        { phoneNumber: 'IVACBD', patterns: ['prompted\\s+(\\d{4,8})'] }] } });
    assert.strictEqual(save.status, 200);
    assert.deepStrictEqual(save.body.warnings, []);

    // The new-format SMS arrives: no code.
    const sms = await req('POST', '/sms', { apiKey: 'test-key',
        body: { sender: 'IVACBD', recipient: SIM, message: IVAC, msgId: 'teach-1' } });
    assert.strictEqual(sms.status, 200);
    assert.ok(!(await req('GET', '/get?number=' + SIM)).body.otp, 'nothing to serve yet');

    // A few seconds later it is reported: listed for Teach, and pushed.
    await sleep(4600);
    const st = (await req('GET', '/api/teach', { token: admin })).body;
    assert.strictEqual(st.unread.length, 1);
    assert.strictEqual(st.unread[0].rule, 'IVACBD');
    assert.strictEqual(st.unread[0].message, IVAC, 'the admin sees the full message in Teach');
    const alert = pushes.filter(p => p.action === 'admin_alert' && p.topic === 'admin_alert_unread');
    assert.strictEqual(alert.length, 1, 'one alert');
    const pushed = JSON.stringify(alert[0].data);
    assert.ok(!/Seven|778050|prompted|019/.test(pushed), 'the push carries no message, code or number: ' + pushed);

    // Test, then Add.
    const t = await req('POST', '/api/teach/test', { token: admin,
        body: { message: IVAC, otpPart: 'Seven_Seven_Eight_Zero_Five_Zero', rule: 'IVACBD', sender: 'IVACBD' } });
    assert.strictEqual(t.status, 200);
    assert.ok(t.body.canApply);
    assert.strictEqual(t.body.proposedFilters, undefined, 'the full filter set is not sent to the client');

    // Add without a Test: refused.
    assert.strictEqual((await req('POST', '/api/teach/apply', { token: admin,
        body: { message: IVAC, otpPart: '778050', rule: 'IVACBD' } })).status, 400);

    // Stale: the filters change between Test and Add.
    const stale = await req('POST', '/api/teach/apply', { token: admin,
        body: { message: IVAC, otpPart: '778050', rule: 'IVACBD', basedOn: 'not-the-same' } });
    assert.strictEqual(stale.status, 409);

    const ap = await req('POST', '/api/teach/apply', { token: admin,
        body: { message: IVAC, otpPart: 'Seven_Seven_Eight_Zero_Five_Zero', rule: 'IVACBD', sender: 'IVACBD',
                basedOn: t.body.basedOn } });
    assert.strictEqual(ap.status, 200, JSON.stringify(ap.body));
    assert.strictEqual(ap.body.waitingNowReads, '778050', 'the SMS already waiting was re-read');
    assert.strictEqual(ap.body.resolvedUnread, 1);

    // THE POINT: the OTP someone is waiting for is now served.
    assert.deepStrictEqual((await req('GET', '/get?number=' + SIM)).body, { success: true, otp: '778050' });

    const st2 = (await req('GET', '/api/teach', { token: admin })).body;
    assert.strictEqual(st2.unread.length, 0, 'resolved');
    assert.strictEqual(st2.examples.length, 1);
    assert.strictEqual(st2.examples[0].code, '778050');
    const disk = JSON.parse(fs.readFileSync(process.env.STATE_FILE, 'utf8'));
    assert.strictEqual(disk.filterExamples.length, 1, 'examples persisted with the filters');
    assert.ok(disk.filters.find(r => r.phoneNumber === 'IVACBD').patterns.includes('@words'));

    // A manual save that breaks the taught message WARNS (and still saves).
    const breaking = await req('POST', '/api/filters', { token: admin, body: { filters: [
        { phoneNumber: 'DEFAULT', patterns: ['(\\d{4,8})'] },
        { phoneNumber: 'IVACBD', patterns: ['prompted\\s+(\\d{4,8})'] }] } });
    assert.strictEqual(breaking.status, 200);
    assert.strictEqual(breaking.body.warnings.length, 1);
    assert.ok(/would now read as no code — it should be 778050/.test(breaking.body.warnings[0]), breaking.body.warnings[0]);

    // An unknown built-in is refused at save.
    const unk = await req('POST', '/api/filters', { token: admin, body: { filters: [
        { phoneNumber: 'IVACBD', patterns: ['@digits'] }] } });
    assert.strictEqual(unk.status, 400);

    // Delete the example.
    const del = await req('POST', '/api/teach/example/delete', { token: admin,
        body: { rule: 'IVACBD', at: st2.examples[0].at } });
    assert.strictEqual(del.status, 200);
    assert.strictEqual((await req('GET', '/api/teach', { token: admin })).body.examples.length, 0);
    assert.strictEqual((await req('POST', '/api/teach/example/delete', { token: admin,
        body: { rule: 'IVACBD', at: 1 } })).status, 404);

    // A notice from the sender with no code-like content: listed, NOT pushed.
    const before = pushes.length;
    alertsReset();
    await req('POST', '/sms', { apiKey: 'test-key',
        body: { sender: 'IVACBD', recipient: SIM, message: 'Thank you for visiting the centre', msgId: 'teach-2' } });
    await sleep(4600);
    assert.strictEqual((await req('GET', '/api/teach', { token: admin })).body.unread.length, 1);
    assert.strictEqual(pushes.length, before, 'a plain notice does not push');

    await firestoreCase();

    console.log = real;
    console.log('ok — any-separator reader, safe Teach with verified patterns and examples, unread alert, '
        + 'the waiting OTP served after Teach');
    process.exit(0);
})().catch(e => { console.log = real; console.error(e); process.exit(1); });

async function firestoreCase() {
    const firestore = require('../lib/firestore');
    const writes = [];
    firestore._setDbForTests({ collection: () => ({ doc: () => ({
        set: async (v, opts) => { writes.push({ v, opts }); }, get: async () => ({ exists: false }) }) }) });
    await firestore.writeConfigNow({ filters: [], globalForwarding: true, autoDeleteMinutes: 30,
                                     filterExamples: [{ rule: 'A' }] }, 't1');
    await firestore.writeConfigNow({ filters: [], globalForwarding: true, autoDeleteMinutes: 30 }, 't2');
    assert.deepStrictEqual(writes[0].v.filterExamples, [{ rule: 'A' }]);
    assert.strictEqual(writes[0].opts, undefined, 'known examples: a full write');
    assert.ok(!('filterExamples' in writes[1].v), 'unknown examples are never written as empty');
    assert.deepStrictEqual(writes[1].opts, { merge: true }, '…and the write merges, keeping the saved ones');
    firestore._setDbForTests(null);
}


function alertsReset() { require('../lib/alerts')._reset(); }
