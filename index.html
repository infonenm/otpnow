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

function convertTextToNumber(text) {
    let result = text.toLowerCase();
    for (const [word, digit] of Object.entries(TEXT_TO_NUM)) {
        result = result.replace(new RegExp('\\b' + word + '\\b', 'g'), digit);
    }
    const digits = result.match(/\d+/g);
    return digits ? digits.join('') : text;
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
        try {
            const match = message.match(new RegExp(pattern, 'i'));
            if (match && match[1]) return convertTextToNumber(match[1].trim());
        } catch (e) { /* bad regex — skip */ }
    }

    return null;
}

module.exports = { extractCode, convertTextToNumber };
