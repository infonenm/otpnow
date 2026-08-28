/**
 * lib/phone.js — BD phone-number canonicalization.
 *
 * =============================================================================
 * THIS FILE HAS A TWIN: app/src/main/java/com/getotp/app/PhoneUtils.java
 *
 * The server stores messages under the canonical recipient and /get looks them
 * up the same way, so if the two implementations ever disagree by one branch,
 * OTPs become unfetchable for the numbers that fall into the gap — silently,
 * and only for some numbers, which is the hardest kind of bug to notice.
 *
 * They were duplicated with no shared spec and nothing enforcing agreement.
 * The rules below are now the spec, the vectors in test/phone.test.js are the
 * enforcement on this side, and PhoneUtilsTest.java holds the SAME vector
 * table on the Android side. Change one, change all three.
 *
 * RULES (first match wins, applied to the digits-only form of the input):
 *   00880XXXXXXXXXX  (15 digits) -> 0XXXXXXXXXX
 *   880XXXXXXXXXX    (13 digits) -> 0XXXXXXXXXX
 *   0XXXXXXXXXX      (11 digits) -> unchanged
 *   1XXXXXXXXX       (10 digits) -> 0 + input
 *   anything else                -> the TRIMMED ORIGINAL, not the digits.
 *
 * That last rule is what lets alphanumeric sender IDs ("IVAC", "bKash") pass
 * through intact instead of collapsing to "".
 * =============================================================================
 */

function canonicalizePhone(raw) {
    if (raw === null || raw === undefined) return '';
    if (typeof raw !== 'string') raw = String(raw);
    const trimmed = raw.trim();
    if (trimmed === '') return '';

    const digits = trimmed.replace(/[^0-9]/g, '');
    if (digits.startsWith('00880') && digits.length === 15) return '0' + digits.substring(5);
    if (digits.startsWith('880')   && digits.length === 13) return '0' + digits.substring(3);
    if (digits.startsWith('0')     && digits.length === 11) return digits;
    if (digits.length === 10 && digits.startsWith('1'))     return '0' + digits;
    return trimmed;
}

module.exports = { canonicalizePhone };
