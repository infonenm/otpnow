/**
 * lib/otp.js — OTP extraction logic
 *
 * Exact mirror of the Cloud Function extractOTPOnNewSMS logic.
 * Used by both the server-side listener and the /get fallback path.
 */

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
const TEXT_TO_NUM_RULES = Object.entries(TEXT_TO_NUM).map(([word, digit]) => ({
    re: new RegExp('\\b' + word + '\\b', 'g'),
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
    message   = String(message);
    sender    = sender    == null ? '' : String(sender);
    recipient = recipient == null ? '' : String(recipient);

    let patterns = [];

    // 1. Try specific sender/number match
    for (const rule of filterRules) {
        if (!rule || typeof rule !== 'object') continue;
        if (rule.phoneNumber === 'DEFAULT') continue;
        if (rule.phoneNumber == null || !Array.isArray(rule.patterns)) continue;
        const normSender    = (sender    || '').toUpperCase().replace(/[\s_-]/g, '');
        const normRecipient = (recipient || '').toUpperCase().replace(/[\s_-]/g, '');
        const normRule      = String(rule.phoneNumber).toUpperCase().replace(/[\s_-]/g, '');

        if (normSender.includes(normRule) || normRule.includes(normSender) ||
            normRecipient.includes(normRule) || normRule.includes(normRecipient)) {
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

module.exports = { extractCode, convertTextToNumber, clearPatternCache, validatePattern };
