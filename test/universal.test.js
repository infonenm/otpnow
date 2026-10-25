/**
 * test/universal.test.js — Universal OTP extraction (server 4.44.0)
 *
 * Verifies that extractUniversal() and the universal fallback in
 * extractDetailed() can read OTP/verification codes from ANY SMS,
 * regardless of sender or format.
 *
 * Run: node test/universal.test.js
 */

const assert = require('assert');
const { extractCode, extractDetailed, extractUniversal, normalizeDigits } = require('../lib/otp');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
    } catch (e) {
        failed++;
        console.error(`✗ ${name}`);
        console.error(`  ${e.message}`);
    }
}

// Helper: run extractUniversal on normalised text (same as extractDetailed does)
function universal(msg) {
    return extractUniversal(normalizeDigits(String(msg)));
}

// Helper: run full extraction pipeline with no rules (universal fallback only)
function fullExtract(msg, sender, recipient) {
    return extractCode(msg, sender || 'UNKNOWN', recipient || '01700000000', []);
}

// Helper: with DEFAULT catch-all rule present (universal should still fire
// when DEFAULT doesn't match)
function withDefault(msg, sender) {
    // Use a pattern that won't match most messages, forcing universal fallback
    const rules = [{ phoneNumber: 'DEFAULT', patterns: ['NOMATCH_PATTERN_XYZ(\\d+)'] }];
    return extractCode(msg, sender || 'UNKNOWN', '01700000000', rules);
}

console.log('\n═══ Tier 1: Labelled digit codes ═══\n');

test('OTP is NNNN', () => {
    assert.strictEqual(universal('Your OTP is 445566'), '445566');
});

test('OTP: NNNN', () => {
    assert.strictEqual(universal('OTP: 778050'), '778050');
});

test('code is NNNN', () => {
    assert.strictEqual(universal('Your verification code is 123456'), '123456');
});

test('code: NNNN', () => {
    assert.strictEqual(universal('code: 998877'), '998877');
});

test('PIN NNNN', () => {
    assert.strictEqual(universal('Your PIN 4455 is ready'), '4455');
});

test('passcode NNNN', () => {
    assert.strictEqual(universal('Your passcode is 667788'), '667788');
});

test('password NNNN', () => {
    assert.strictEqual(universal('Your one-time password is 112233'), '112233');
});

test('security code NNNN', () => {
    assert.strictEqual(universal('Your security code is 554433'), '554433');
});

test('confirmation code', () => {
    assert.strictEqual(universal('Your confirmation code is 887766'), '887766');
});

test('activation code', () => {
    assert.strictEqual(universal('activation code: 334455'), '334455');
});

test('login code', () => {
    assert.strictEqual(universal('Your login code is 998877'), '998877');
});

test('access code', () => {
    assert.strictEqual(universal('access code: 223344'), '223344');
});

test('digits before keyword: NNNN is your OTP', () => {
    assert.strictEqual(universal('445566 is your OTP'), '445566');
});

test('digits before keyword: NNNN is your verification code', () => {
    assert.strictEqual(universal('778050 is your verification code'), '778050');
});

test('digits before keyword: Use NNNN as your code', () => {
    assert.strictEqual(universal('Use 998877 as your code'), '998877');
});

test('OTP with surrounding text', () => {
    assert.strictEqual(universal('Dear customer, your OTP for login is 445566. Valid for 5 min.'), '445566');
});

test('4-digit OTP', () => {
    assert.strictEqual(universal('Your OTP is 4261'), '4261');
});

test('8-digit OTP', () => {
    assert.strictEqual(universal('Your OTP is 12345678'), '12345678');
});

test('10-digit OTP', () => {
    assert.strictEqual(universal('Your OTP is 1234567890'), '1234567890');
});

test('case insensitive: otp / OTP / Otp', () => {
    assert.strictEqual(universal('otp is 445566'), '445566');
    assert.strictEqual(universal('OTP is 445566'), '445566');
    assert.strictEqual(universal('Otp is 445566'), '445566');
});

console.log('\n═══ Tier 2: Spelled-out codes ═══\n');

test('spelled with hyphens', () => {
    assert.strictEqual(universal('Your code is Four-Two-Six-One'), '4261');
});

test('spelled with underscores', () => {
    assert.strictEqual(universal('Your code is Seven_Seven_Eight_Zero_Five_Zero'), '778050');
});

test('spelled with spaces', () => {
    assert.strictEqual(universal('code: one two three four'), '1234');
});

console.log('\n═══ Tier 3: Keyword context + standalone digits ═══\n');

test('verification keyword with standalone digits', () => {
    assert.strictEqual(universal('Your verification number: 556677'), '556677');
});

test('OTP keyword away from digits', () => {
    assert.strictEqual(universal('We sent an OTP to you. Enter 445566 to proceed.'), '445566');
});

test('one-time keyword with digits', () => {
    assert.strictEqual(universal('Your one-time token: 998877'), '998877');
});

test('login keyword with digits', () => {
    assert.strictEqual(universal('For login, enter 223344'), '223344');
});

test('two-factor keyword with digits', () => {
    assert.strictEqual(universal('2FA code 667788'), '667788');
});

test('session keyword with digits', () => {
    assert.strictEqual(universal('Your session code is 443322'), '443322');
});

test('transaction keyword with digits', () => {
    assert.strictEqual(universal('Transaction OTP: 889900'), '889900');
});

console.log('\n═══ Tier 4: Lone standalone code ═══\n');

test('just a code', () => {
    assert.strictEqual(universal('445566'), '445566');
});

test('minimal message with code', () => {
    assert.strictEqual(universal('Enter 998877'), '998877');
});

test('bare code with newline', () => {
    assert.strictEqual(universal('445566\n'), '445566');
});

console.log('\n═══ Exclusion: should NOT extract ═══\n');

test('currency amount: Tk NNNN', () => {
    assert.strictEqual(universal('Your balance is Tk 5000. Thank you.'), null);
});

test('currency amount: $NNNN', () => {
    assert.strictEqual(universal('You paid $1234 for your order'), null);
});

test('currency amount: Rs NNNN', () => {
    assert.strictEqual(universal('Rs 5000 has been debited'), null);
});

test('phone number with hint', () => {
    assert.strictEqual(universal('Call 01712345678 for help'), null);
});

test('decimal amount', () => {
    assert.strictEqual(universal('Amount: 2000.00 Tk'), null);
});

test('multiple competing numbers, no keyword', () => {
    assert.strictEqual(universal('Ref 445566 Amt 778899'), null);
});

test('amount with balance keyword', () => {
    assert.strictEqual(universal('balance: 50000'), null);
});

test('debit amount', () => {
    assert.strictEqual(universal('debit 9000 from your account'), null);
});

console.log('\n═══ Full pipeline: universal as fallback ═══\n');

test('no rules at all — universal fires', () => {
    assert.strictEqual(fullExtract('Your OTP is 445566'), '445566');
});

test('DEFAULT misses — universal fires', () => {
    assert.strictEqual(withDefault('Your OTP is 445566'), '445566');
});

test('sender-specific rule matches — universal does NOT fire', () => {
    const rules = [{ phoneNumber: 'BKASH', patterns: ['(\\d{4,8})'] }];
    // The sender rule matches and extracts the amount, not the OTP.
    // Universal should NOT override a configured rule's behaviour.
    const result = extractDetailed('Your balance is Tk 5000. OTP 445566', 'bKash-16247', '01700000000', rules);
    // The sender rule claims the sender; its catch-all (\d{4,8}) reads FIRST digits
    assert.strictEqual(result.rule, 'BKASH');
});

test('extractDetailed returns UNIVERSAL rule name', () => {
    const result = extractDetailed('Your OTP is 445566', 'NEWSERVICE', '01700000000', []);
    assert.strictEqual(result.code, '445566');
    assert.strictEqual(result.rule, 'UNIVERSAL');
    assert.strictEqual(result.pattern, '@universal');
});

test('@universal as explicit pattern in a rule', () => {
    const rules = [{ phoneNumber: 'DEFAULT', patterns: ['@universal'] }];
    assert.strictEqual(extractCode('Your OTP is 778050', 'NEWSERVICE', '01700000000', rules), '778050');
});

console.log('\n═══ Real-world SMS formats ═══\n');

test('Google verification', () => {
    assert.strictEqual(universal('G-123456 is your Google verification code.'), '123456');
});

test('WhatsApp style', () => {
    assert.strictEqual(universal('Your WhatsApp code is 445-566'), '445566');
});

test('Uber style', () => {
    assert.strictEqual(universal('Your Uber code is 4455. Reply STOP to unsubscribe.'), '4455');
});

test('Facebook style', () => {
    assert.strictEqual(universal('445566 is your Facebook code. Laz+nxCarLW'), '445566');
});

test('Microsoft style', () => {
    assert.strictEqual(universal('Your Microsoft security code is 998877'), '998877');
});

test('Amazon style', () => {
    assert.strictEqual(universal('778899 is your Amazon OTP. Do not share it with anyone.'), '778899');
});

test('Bank OTP style', () => {
    assert.strictEqual(universal('Dear Customer, 445566 is your OTP for transaction of Rs.1500 at Amazon. Valid for 10 mins.'), '445566');
});

test('Generic service', () => {
    assert.strictEqual(universal('Your verification code for MyApp is 667788'), '667788');
});

test('Telegram style', () => {
    assert.strictEqual(universal('Telegram code: 55678'), '55678');
});

test('Signal style (dashed code)', () => {
    assert.strictEqual(universal('Your Signal verification code is: 556-677'), '556677');
    // Dashes between digit groups are collapsed when near a keyword
});

test('Twitter/X style', () => {
    assert.strictEqual(universal('Your Twitter confirmation code is 445566.'), '445566');
});

test('PayPal style', () => {
    assert.strictEqual(universal('PayPal: Your security code is 998877. It expires in 10 minutes.'), '998877');
});

test('LinkedIn style', () => {
    assert.strictEqual(universal('Your LinkedIn verification code is 554433.'), '554433');
});

test('Snapchat style', () => {
    assert.strictEqual(universal('Snapchat code: 667788. Happy Snapping!'), '667788');
});

test('bKash OTP with amount', () => {
    // Should pick the OTP, not the amount
    assert.strictEqual(universal('bKash: Your OTP for Send Money Tk 500.00 is 445566. Do not share.'), '445566');
});

test('Nagad OTP', () => {
    assert.strictEqual(universal('Nagad: আপনার OTP হলো 556677'), '556677');
});

test('Railway booking OTP', () => {
    assert.strictEqual(universal('Your OTP for railway e-ticket booking is 778899. Valid for 5 minutes.'), '778899');
});

test('IVAC style (digit OTP)', () => {
    assert.strictEqual(universal('(IVACBD) For security, enter 8842 when prompted.'), '8842');
});

console.log('\n═══ Bengali/Non-ASCII digit support ═══\n');

test('Bengali digits with OTP keyword', () => {
    assert.strictEqual(universal(normalizeDigits('আপনার OTP ৪৪৫৫৬৬')), '445566');
});

test('Bengali OTP keyword', () => {
    // "আপনার OTP হলো" = "Your OTP is" in Bengali
    assert.strictEqual(universal(normalizeDigits('আপনার OTP হলো ৫৫৬৬৭৭')), '556677');
});

console.log('\n═══ Edge cases ═══\n');

test('empty message', () => {
    assert.strictEqual(universal(''), null);
});

test('message with no digits', () => {
    assert.strictEqual(universal('Welcome to our service. Thank you for signing up.'), null);
});

test('message with only short digits', () => {
    assert.strictEqual(universal('Enter 12 to continue'), null);
});

test('message with only long number', () => {
    assert.strictEqual(universal('Your reference number is 12345678901234'), null);
});

test('OTP with newlines in message', () => {
    assert.strictEqual(universal('Dear User,\nYour OTP is 445566.\nThank you.'), '445566');
});

test('OTP in URL-like context excluded properly', () => {
    // Should still find OTP even with URL in message
    assert.strictEqual(universal('Your OTP is 445566. Visit https://example.com/verify'), '445566');
});

console.log('\n═══ Tier 1b: Labelled alphanumeric codes ═══\n');

// ── Mixed alphanumeric (letter + digit) with keyword ──

test('code: Ab3Xy9 (mixed alphanum after keyword)', () => {
    assert.strictEqual(universal('Your code: Ab3Xy9'), 'Ab3Xy9');
});

test('OTP is E4H7n0 (mixed alphanum after OTP keyword)', () => {
    assert.strictEqual(universal('Your OTP is E4H7n0'), 'E4H7n0');
});

test('verification code R5t2Wp (mixed alphanum)', () => {
    assert.strictEqual(universal('Your verification code is R5t2Wp'), 'R5t2Wp');
});

test('pin A1b2C3 (mixed alphanum after pin)', () => {
    assert.strictEqual(universal('Your pin is A1b2C3'), 'A1b2C3');
});

test('security code 3kF9mN (mixed alphanum)', () => {
    assert.strictEqual(universal('Your security code is 3kF9mN'), '3kF9mN');
});

test('token X4y7Z2 (mixed alphanum)', () => {
    assert.strictEqual(universal('Your token is X4y7Z2'), 'X4y7Z2');
});

test('passcode p3Q8r1 (mixed alphanum)', () => {
    assert.strictEqual(universal('passcode: p3Q8r1'), 'p3Q8r1');
});

test('4-char mixed alphanum: code A1b2', () => {
    assert.strictEqual(universal('code: A1b2'), 'A1b2');
});

test('10-char mixed alphanum: code Ab3Xy9Wz1K', () => {
    assert.strictEqual(universal('Your code is Ab3Xy9Wz1K'), 'Ab3Xy9Wz1K');
});

test('mixed alphanum BEFORE keyword: E4H7n0 is your code', () => {
    assert.strictEqual(universal('E4H7n0 is your code'), 'E4H7n0');
});

test('mixed alphanum BEFORE keyword: R5t2Wp is your OTP', () => {
    assert.strictEqual(universal('R5t2Wp is your OTP'), 'R5t2Wp');
});

// ── "enter X to verify" tight-slot patterns ──

test('enter E4H7n0 to verify (tight slot)', () => {
    assert.strictEqual(universal('please enter E4H7n0 to verify'), 'E4H7n0');
});

test('to verify please enter E4H7n0 (reversed tight slot)', () => {
    assert.strictEqual(universal('to verify please enter E4H7n0'), 'E4H7n0');
});

test('enter parot to verify (pure alpha in tight slot)', () => {
    assert.strictEqual(universal('to verify please enter parot'), 'parot');
});

test('use Xk4Tn to confirm (tight slot)', () => {
    assert.strictEqual(universal('use Xk4Tn to confirm'), 'Xk4Tn');
});

test('type R5t2Wp to authenticate (tight slot)', () => {
    assert.strictEqual(universal('type R5t2Wp to authenticate'), 'R5t2Wp');
});

test('enter A1b2C3 to log in (tight slot)', () => {
    assert.strictEqual(universal('enter A1b2C3 to log in'), 'A1b2C3');
});

test('to activate enter Mk9Pq2 (reversed)', () => {
    assert.strictEqual(universal('to activate enter Mk9Pq2'), 'Mk9Pq2');
});

test('submit Q7w3Er to register (tight slot)', () => {
    assert.strictEqual(universal('submit Q7w3Er to register'), 'Q7w3Er');
});

// ── Real-world service formats ──

test('IVAC alphanumeric code', () => {
    assert.strictEqual(universal('(IVACBD) Your verification code is Xk4Tn7. Enter to proceed.'), 'Xk4Tn7');
});

test('Railway booking alphanumeric', () => {
    assert.strictEqual(universal('Your e-ticket confirmation code is R5t2Wp. Valid for 10 minutes.'), 'R5t2Wp');
});

test('bKash alphanumeric OTP', () => {
    assert.strictEqual(universal('bKash: Your OTP is A3b7Xp for Send Money Tk 500.00'), 'A3b7Xp');
});

test('Rocket alphanumeric verification', () => {
    assert.strictEqual(universal('Rocket: Your verification code is M4n8Kp. Do not share.'), 'M4n8Kp');
});

test('dgepay alphanumeric', () => {
    assert.strictEqual(universal('dgepay: Your security code is P9q2Rt for payment verification.'), 'P9q2Rt');
});

test('Nagad alphanumeric OTP', () => {
    assert.strictEqual(universal('Nagad: আপনার OTP হলো K7m3Np'), 'K7m3Np');
});

// ── Case preservation ──

test('preserves original case of alphanum code', () => {
    assert.strictEqual(universal('code: AbCdE1'), 'AbCdE1');
});

// ── Priority: digit codes still win over alphanum ──

test('digit code found first, alphanum code ignored', () => {
    // Tier 1a (labelled digits) runs before Tier 1b (alphanum)
    assert.strictEqual(universal('Your OTP is 445566. Token: Ab3Xy9'), '445566');
});

// ── SAFETY: should NOT extract ──

test('common English word after keyword rejected', () => {
    // "code" followed by "please" — "please" is a common word
    assert.strictEqual(universal('Your code will arrive. please wait.'), null);
});

test('common word "enter" not extracted as code', () => {
    // "code" followed by common English
    assert.strictEqual(universal('Your code: check your email for details'), null);
});

test('URL fragment not extracted', () => {
    assert.strictEqual(universal('verify at https://example.com/verify'), null);
});

test('email fragment not extracted', () => {
    assert.strictEqual(universal('code sent to user@example.com'), null);
});

test('pure alpha without tight slot rejected', () => {
    // "code: abcdef" — pure alpha, not in "enter X to verify" slot
    // This should NOT extract because pure-alpha needs the tight slot
    assert.strictEqual(universal('Your code is abcdef'), null);
});

test('pure alpha common word in tight slot rejected', () => {
    // "enter share to verify" — "share" is a common English word
    assert.strictEqual(universal('enter share to verify'), null);
});

test('service name bkash not extracted as code', () => {
    assert.strictEqual(universal('code from bkash for payment'), null);
});

test('3-char token rejected (too short)', () => {
    assert.strictEqual(universal('code: A1b'), null);
});

test('11-char token rejected (too long)', () => {
    assert.strictEqual(universal('code: Ab3Xy9Wz1Kp'), null);
});

test('standalone alphanum without keyword — not extracted', () => {
    // No keyword in message, alphanum token present — must NOT extract
    assert.strictEqual(universal('Please pay Ab3Xy9 for the item'), null);
});

// ── Full pipeline with alphanum ──

test('full pipeline: alphanum code with no rules', () => {
    assert.strictEqual(fullExtract('Your verification code is Xk4Tn7'), 'Xk4Tn7');
});

test('full pipeline: alphanum with DEFAULT miss', () => {
    assert.strictEqual(withDefault('Your OTP is R5t2Wp. Do not share.'), 'R5t2Wp');
});

test('full pipeline: enter X to verify with no rules', () => {
    assert.strictEqual(fullExtract('to verify please enter parot'), 'parot');
});

test('extractDetailed returns UNIVERSAL for alphanum', () => {
    const result = extractDetailed('code: Ab3Xy9', 'NEWSERVICE', '01700000000', []);
    assert.strictEqual(result.code, 'Ab3Xy9');
    assert.strictEqual(result.rule, 'UNIVERSAL');
    assert.strictEqual(result.pattern, '@universal');
});

// ── Summary ──────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
    process.exit(1);
} else {
    console.log('All tests passed ✓');
}
