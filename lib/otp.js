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

    let patterns = [];

    // 1. Try specific sender/number match
    for (const rule of filterRules) {
        if (rule.phoneNumber === 'DEFAULT') continue;
        const normSender    = (sender    || '').toUpperCase().replace(/[\s_-]/g, '');
        const normRecipient = (recipient || '').toUpperCase().replace(/[\s_-]/g, '');
        const normRule      = rule.phoneNumber.toUpperCase().replace(/[\s_-]/g, '');

        if (normSender.includes(normRule) || normRule.includes(normSender) ||
            normRecipient.includes(normRule) || normRule.includes(normRecipient)) {
            patterns = rule.patterns;
            break;
        }
    }

    // 2. Fall back to DEFAULT patterns
    if (patterns.length === 0) {
        const def = filterRules.find(r => r.phoneNumber === 'DEFAULT');
        if (def) patterns = def.patterns;
    }

    // 3. Try each regex pattern
    for (const pattern of patterns) {
        const re = compile(pattern);
        if (!re) continue;                      // invalid pattern, already logged once
        const match = message.match(re);
        if (match && match[1]) return convertTextToNumber(match[1].trim());
    }

    return null;
}

module.exports = { extractCode, convertTextToNumber, clearPatternCache };
