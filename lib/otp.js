/**
 * lib/otp.js — OTP extraction logic
 *
 * Exact mirror of the Cloud Function extractOTPOnNewSMS logic.
 * Used by both the server-side listener and the /get fallback path.
 */

const { canonicalizePhone } = require('./phone');

// ── Non-ASCII digits ────────────────────────────────────────────
//
// JavaScript's \d (without the u flag, and even with it) matches ASCII 0-9 ONLY.
// Bangla-language SMS write the code in Bengali digits — "আপনার OTP ৪৪৫৫৬৬" — and
// every filter pattern silently missed it. The app learned this for USSD replies
// in 4.19.2; the server's extraction never did.
//
// Normalised on a COPY used for matching only. The stored and displayed message
// is untouched.
const DIGIT_BLOCKS = [0x09E6 /* Bengali */, 0x0966 /* Devanagari */,
                      0x0660 /* Arabic-Indic */, 0x06F0 /* Extended Arabic-Indic */];
const NON_ASCII_DIGIT = /[\u09E6-\u09EF\u0966-\u096F\u0660-\u0669\u06F0-\u06F9]/g;

function normalizeDigits(text) {
    return String(text).replace(NON_ASCII_DIGIT, ch => {
        const c = ch.charCodeAt(0);
        for (const base of DIGIT_BLOCKS) {
            if (c >= base && c <= base + 9) return String(c - base);
        }
        return ch;
    });
}

// ── Text-to-digit map ───────────────────────────────────────────
const TEXT_TO_NUM = {
    zero: '0', one: '1', two: '2', three: '3', four: '4',
    five: '5', six: '6', seven: '7', eight: '8', nine: '9'
};

// Compiled ONCE at module load, not ten times per call.
//
// convertTextToNumber ran `new RegExp('\\b' + word + '\\b', 'g')` inside a
// ten-iteration loop, so every OTP extraction compiled ten regexes and threw
// them away. The word list is a constant; there was never a reason to.
//
// LETTER-ONLY BOUNDARIES, NOT \b. In a regex "_" is a word character, so
// \bseven\b never matched inside "Two_Six_Three_Seven_Eight_Four" — the form
// IVAC sends — and the words came back unconverted instead of 263784. The
// lookarounds treat anything that is not a letter (_ - space, digits) as a
// separator. The text is lower-cased before replacing, so [a-z] is enough.
const TEXT_TO_NUM_RULES = Object.entries(TEXT_TO_NUM).map(([word, digit]) => ({
    re: new RegExp('(?<![a-z])' + word + '(?![a-z])', 'g'),
    digit
}));

function convertTextToNumber(text) {
    let result = text.toLowerCase();
    for (const rule of TEXT_TO_NUM_RULES) {
        // The 'g' flag makes these regexes stateful via lastIndex, but
        // String.replace() resets lastIndex itself, so reusing them is safe.
        // Never call .test() or .exec() on them without resetting lastIndex.
        result = result.replace(rule.re, rule.digit);
    }
    const digits = result.match(/\d+/g);
    return digits ? digits.join('') : text;
}

// ── Filter pattern cache ────────────────────────────────────────
//
// Filter patterns come from the dashboard and change rarely; every SMS was
// recompiling all of them. Cached by pattern string and cleared whenever the
// filters are replaced (store.setFilters calls clearPatternCache), so the cache
// can never hold a pattern the operator has removed.
//
// A pattern that fails to compile is cached as `null` — an invalid regex is
// still invalid on the next message, and retrying the compile just to throw
// again on every SMS is the same waste in a different place.
const patternCache = new Map();

function compile(pattern) {
    if (patternCache.has(pattern)) return patternCache.get(pattern);
    let re = null;
    try {
        re = new RegExp(pattern, 'i');
    } catch (e) {
        console.warn(`[otp] Ignoring invalid filter pattern ${JSON.stringify(pattern)}: ${e.message}`);
    }
    patternCache.set(pattern, re);
    return re;
}

function clearPatternCache() {
    patternCache.clear();
}

/**
 * Extract OTP code from an SMS message using filter rules.
 *
 * @param {string} message  — raw SMS body
 * @param {string} sender   — SMS sender address
 * @param {string} recipient — SIM number that received the SMS
 * @param {Array}  filterRules — array of {phoneNumber, patterns[]}
 * @returns {string|null} extracted OTP or null
 */
function extractCode(message, sender, recipient, filterRules) {
    if (!message || !filterRules || filterRules.length === 0) return null;

    // COERCE EVERY INPUT TO A STRING FIRST.
    //
    // A JSON body is not a type system: sender, recipient or message can arrive
    // as a number, a boolean, an array or an object. `message.match(...)` then
    // throws "message.match is not a function", which used to propagate out of
    // addSms and — before the async wrapper existed — off the end of the
    // process. Found by fuzzing, not by reasoning about it.
    //
    // Coercing is the right answer rather than rejecting: an SMS that arrives
    // in an odd shape should still have its OTP read if one is in there.
    message   = normalizeDigits(String(message));
    sender    = sender    == null ? '' : String(sender);
    recipient = recipient == null ? '' : String(recipient);

    let patterns = [];

    // 1. Try specific sender/number match
    for (const rule of filterRules) {
        if (!rule || typeof rule !== 'object') continue;
        if (rule.phoneNumber === 'DEFAULT') continue;
        if (rule.phoneNumber == null || !Array.isArray(rule.patterns)) continue;

        const normRule      = String(rule.phoneNumber).toUpperCase().replace(/[\s_-]/g, '');

        // ═════════════════════════════════════════════════════════
        // A BLANK RULE NAME CLAIMED EVERY SENDER.
        //
        // "ANYTHING".includes("") is true, so a rule whose phoneNumber was ''
        // or whitespace matched every message and shadowed every rule after it,
        // DEFAULT included. Verified: a blank rule with pattern `Tk (\d{4,8})`
        // extracted 2000 — the payment amount — from a real IVAC OTP message.
        //
        // That is the wrong-code failure the deferred-extraction block exists to
        // prevent, arriving through a different door. Skipped here, and refused
        // at both write paths so it cannot be stored in the first place.
        // ═════════════════════════════════════════════════════════
        if (normRule === '') continue;

        // ═════════════════════════════════════════════════════════
        // MATCHING IS ONE-DIRECTIONAL: does the SENDER contain the RULE.
        //
        // "BKASH-16247".includes("BKASH") is the case this is for — a rule named
        // for the brand claiming the numbered gateway.
        //
        // The reverse — rule.includes(sender) — only ever fires when the rule is
        // LONGER than the sender, i.e. a rule named "BKASH-16247" claiming the
        // plain sender "bKash". And because a claimed sender does NOT fall back
        // to DEFAULT, if that rule's patterns then miss, the OTP is lost.
        // Verified: sender bKash, a BKASH-16247 rule with a non-matching
        // pattern, and DEFAULT sitting right there — extraction returned null.
        //
        // The fallback is deliberately NOT added: falling through to DEFAULT
        // means falling through to the catch-all, which is how an amount gets
        // served as a code. A sender rule should end with `(\d{4,8})` if that is
        // what you want — see FILTERS.md.
        // ═════════════════════════════════════════════════════════
        if (ruleMatches(rule.phoneNumber, normRule, sender, recipient)) {
            patterns = rule.patterns;
            break;
        }
    }

    // 2. Fall back to DEFAULT patterns
    if (patterns.length === 0) {
        const def = filterRules.find(r => r && r.phoneNumber === 'DEFAULT');
        if (def && Array.isArray(def.patterns)) patterns = def.patterns;
    }

    // 3. Try each regex pattern
    for (const pattern of Array.isArray(patterns) ? patterns : []) {
        if (typeof pattern !== 'string') continue;
        const re = compile(pattern);
        if (!re) continue;                      // invalid pattern, already logged once
        const match = message.match(re);
        if (match && match[1]) return convertTextToNumber(match[1].trim());
    }

    return null;
}

/**
 * Does this rule claim this message?
 *
 * =============================================================================
 * THE RECIPIENT WAS MATCHED BY SUBSTRING, AND A NUMBER RULE CLAIMED STRANGERS.
 *
 * The rule name was tested with includes() against the receiving SIM number as
 * well as the sender. A Rocket rule named "16216" therefore claimed EVERY SMS to
 * a SIM such as 01716216555 — IVAC included — and because a claimed sender does
 * not fall back to DEFAULT, the IVAC code came out null. Verified.
 *
 * A digits-only rule name is a NUMBER, and numbers are matched as numbers:
 *   - against the recipient: the whole canonical number, so "01711111111" and
 *     "+8801711111111" both name that SIM, and nothing else does;
 *   - against the sender: the whole canonical number, or one complete run of
 *     digits in it — so "16247" still claims "bKash-16247", but not a phone
 *     number that happens to contain those five digits.
 * A name with letters ("bKash", "IVAC") keeps the old substring match against
 * the sender, which is what makes "bkash" claim "BKASH-16247". It never matched
 * a recipient meaningfully — recipients are numbers — so it no longer tries.
 * =============================================================================
 */
function ruleMatches(rawRule, normRule, sender, recipient) {
    if (isNumberToken(normRule)) {
        const ruleNum = numberOf(rawRule);
        if (recipient && canonicalizePhone(recipient) === ruleNum) return true;
    }
    return senderClaimedBy(rawRule, sender);
}

const normToken = v => String(v == null ? '' : v).toUpperCase().replace(/[\s_-]/g, '');
const isNumberToken = norm => /^\+?\d+$/.test(norm);
/** A number in canonical digits: "+8801711111111" and "01711111111" agree. */
const numberOf = raw => canonicalizePhone(String(raw)).replace(/\D/g, '');

/**
 * Does `token` name this sender? The ONE sender rule — used by filter rules
 * here and by the gateway aliases' sender scope (store.senderMatches), which had
 * the same substring problem: /rocket scoped to "16216" accepted any phone-number
 * sender that happened to contain those digits.
 *
 *   letters in the token -> substring, case/space/_/- insensitive
 *                           ("bkash" claims "BKASH-16247")
 *   digits only          -> the whole canonical number, or one complete run of
 *                           digits ("16247" claims "bKash-16247", not
 *                           "01716247555")
 */
function senderClaimedBy(token, sender) {
    const t = normToken(token);
    if (t === '') return false;
    if (!isNumberToken(t)) return normToken(sender).includes(t);
    const num = numberOf(token);
    if (sender && canonicalizePhone(String(sender)) === num) return true;
    const runs = String(sender || '').match(/\d+/g) || [];
    return runs.includes(num) || runs.includes(t.replace(/\D/g, ''));
}

/**
 * Why a pattern would never produce an OTP.
 *
 * =============================================================================
 * THE FAILURE THIS PREVENTS IS SILENT AND EXPENSIVE
 *
 * A pattern pasted out of a JSON example arrives double-escaped: the stored
 * string is `(\\d{4,8})`, which as a regex means "a literal backslash followed
 * by four to eight letter d". It matches nothing, ever. Nothing errors. The
 * dashboard shows the rule sitting there looking correct, and every OTP from
 * that sender is quietly lost — worse, a sender rule does NOT fall back to
 * DEFAULT, so one bad paste silently kills that sender entirely.
 *
 * A pattern with no capture group is the same story: extractCode reads group 1,
 * so `\d{4,8}` returns nothing while looking perfectly reasonable.
 *
 * Both are caught here and reported, because a filter that cannot work should
 * fail when you save it, not the next time you need an OTP.
 * =============================================================================
 *
 * @returns {string|null} an explanation, or null if the pattern is usable
 */
/**
 * Why a rule could never work, independent of its patterns.
 * @returns {string|null}
 */
function validateRule(rule) {
    if (!rule || typeof rule !== 'object') return 'not a rule object';
    const name = rule.phoneNumber == null ? '' : String(rule.phoneNumber).trim();
    if (name === '') {
        return 'has a blank sender/number. A blank name matches EVERY message and '
             + 'shadows every rule below it, including DEFAULT — use "DEFAULT" if '
             + 'that is what you meant';
    }
    return null;
}

function validatePattern(pattern) {
    if (typeof pattern !== 'string' || pattern.trim() === '') return 'empty pattern';

    if (/\\\\[dswbDSWB]/.test(pattern)) {
        return 'looks double-escaped (contains \\\\d, \\\\s or \\\\b). '
             + 'Type it as you would write a regex: (\\d{4,8}), not (\\\\d{4,8})';
    }
    let re;
    try {
        re = new RegExp(pattern, 'i');
    } catch (e) {
        return 'not a valid regular expression: ' + e.message;
    }
    // extractCode reads match[1]; without a capture group there is nothing to read.
    if (new RegExp(pattern + '|').exec('').length - 1 === 0) {
        return 'has no capture group — wrap the code part in brackets, e.g. (\\d{4,8})';
    }
    return null;
}

module.exports = { extractCode, convertTextToNumber, clearPatternCache, validatePattern, validateRule,
                   normalizeDigits, senderClaimedBy };
