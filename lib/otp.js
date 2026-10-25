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

// ═════════════════════════════════════════════════════════════════
// NUMBER WORDS — ONE TOKENIZER FOR EVERY FORMAT (server 4.43.0)
//
// IVAC spells its code out and keeps changing HOW: "Four-Two-Six-One" until
// 2026-10-22, then "Seven_Seven_Eight_Zero_Five_Zero". 4.42.3 matched words
// with \b, and \b does not break on '_', so the second format converted
// nothing and the raw words were served as the OTP.
//
// Words are now found by a TOKENIZER, not by word-boundary regexes: the text
// is split into letter runs and digit runs, and whatever sits between two
// tokens is a separator — any separator: space, '-', '_', '.', '/', '|', '*'.
// A letter run that is several number words glued together
// ("SevenSevenEight") is split; "someone", "eighteen", "seventy" are not
// number words and stay words. English and Bengali words, "double"/"triple".
//
// Used twice: to turn a pattern's CAPTURE into digits (convertTextToNumber),
// and as the built-in @words reader, which needs no pattern at all.
// ═════════════════════════════════════════════════════════════════
const EN_DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
// Escapes, not literals: Bengali has two encodings of য় (U+09DF and
// U+09AF U+09BC). Keys are NFC (which is the decomposed one) and every
// non-ASCII token is NFC'd before lookup, so both spellings match.
const BN_DIGIT_WORDS = [
    ['শূন্য', '0'],    // শূন্য
    ['শুন্য', '0'],    // শুন্য
    ['এক', '1'],                      // এক
    ['দুই', '2'],                // দুই
    ['তিন', '3'],                // তিন
    ['চার', '4'],                // চার
    ['পাঁচ', '5'],          // পাঁচ
    ['ছয়', '6'],                // ছয়
    ['সাত', '7'],                // সাত
    ['আট', '8'],                      // আট
    ['নয়', '9']                 // নয়
];
// Maps, never plain objects: a token such as "constructor" must not find a
// prototype property and become a "number".
const WORD_DIGIT = new Map();
EN_DIGIT_WORDS.forEach((w, i) => WORD_DIGIT.set(w, String(i)));
for (const [w, d] of BN_DIGIT_WORDS) WORD_DIGIT.set(w.normalize('NFC'), d);
const REPEAT_WORDS = new Map([['double', 2], ['triple', 3]]);
/** Glued English words are split greedily; no word here is a prefix of another. */
const SEGMENTS = EN_DIGIT_WORDS.map((w, i) => [w, String(i)])
    .concat([['double', 2], ['triple', 3]]);

const TOKEN_RE    = /[\p{L}\p{M}]+|\p{Nd}+/gu;
const ASCII_RE    = /^[\x00-\x7f]*$/;
const DIGITS_RE   = /^[0-9]+$/;
const NEWLINE_RE  = /[\r\n]/;

/** A code is this many digits. Shorter is a stray "one"; longer is not an OTP. */
const MIN_CODE = 4;
const MAX_CODE = 10;
/** Most separator characters allowed between two words of one spelled code. */
const MAX_GAP = 3;

/** "SevenSevenEight" → units, or null if it is not ENTIRELY number words. */
function segment(s) {
    if (s.length < 6) return null;                 // "onetwo" is the shortest pair
    const out = [];
    let i = 0;
    outer: while (i < s.length) {
        for (const [w, u] of SEGMENTS) {
            if (s.startsWith(w, i)) { out.push(u); i += w.length; continue outer; }
        }
        return null;
    }
    return out.length >= 2 ? out : null;
}

/**
 * A letter token as number units, or null when it is not a number word.
 * A unit is a digit string ('0'–'9') or a repeat count (2 = double, 3 = triple).
 */
function wordUnits(tok) {
    const lower = tok.toLowerCase();
    if (ASCII_RE.test(lower)) {
        const d = WORD_DIGIT.get(lower);
        if (d !== undefined) return [d];
        const r = REPEAT_WORDS.get(lower);
        if (r !== undefined) return [r];
        return segment(lower);
    }
    const d = WORD_DIGIT.get(lower.normalize('NFC'));
    return d !== undefined ? [d] : null;
}

/** Units → digits. A repeat applies to the next digit; a dangling one is dropped. */
function unitsToDigits(units) {
    let out = '';
    let rep = 0;
    for (const u of units) {
        if (typeof u === 'number') { rep = u; continue; }
        out += rep ? u.charAt(0).repeat(rep) + u.slice(1) : u;
        rep = 0;
    }
    return out;
}

/**
 * The captured text reduced to its digits, number words converted.
 * @returns {string|null} the digits, or null when there are none.
 *
 * A capture that holds DIGITS is a digit code: only its digits count, and
 * words in it are ignored ("G-123456" → 123456; "445566 এক বার" → 445566, not
 * 4455661 — এক is also the Bengali article "a", নয় also means "not"). Only a
 * capture with no digits at all is read as words
 * ("Seven_Seven_Eight_Zero_Five_Zero" → 778050).
 *
 * It used to return the ORIGINAL text when no digit came out — so a capture the
 * converter could not read was served to the fetch scripts as the "OTP" and
 * typed into IVAC. Null now; extractDetailed then stops with no code.
 */
function convertTextToNumber(text) {
    const s = String(text);
    const digitRuns = s.match(/[0-9]+/g);
    let out;
    if (digitRuns) {
        out = digitRuns.join('');
        // A capture holding a spelled code AND other digits ("Four-Two-Six-One.
        // Pay Tk 2000.00") cannot say which is the code: none (review, 4.43.0).
        const sp = scanSpelled(s);
        if (sp.runs.some(r => r.digits !== out)) return null;
    } else {
        // Words only: they must be ONE clear spelled code, and every number
        // word in the capture must belong to it. Converting every number word
        // anywhere in a greedy capture made "…Five Zero, valid for one minute"
        // 7780501 (review, 4.43.1).
        const units = [];
        for (const m of s.matchAll(TOKEN_RE)) {
            const u = wordUnits(m[0]);
            if (u) units.push(...u);
            else if (units.length && typeof units[units.length - 1] === 'number') units.pop(); // "double the…"
        }
        out = unitsToDigits(units);
        if (out.length >= MIN_CODE) {
            const sp = scanSpelled(s);
            if (sp.unclear || sp.runs.length !== 1 || sp.runs[0].digits !== out) return null;
        }
    }
    // Never a code shorter than MIN_CODE ("7" from "Seven…" by a pattern that
    // stopped at the first separator, "2" from "Valid 2 min") or longer than
    // MAX_CODE (a 31-digit "code" from a run of words; a phone number) —
    // both were served before (reviews, 4.43.0 / 4.43.1).
    return out.length >= MIN_CODE && out.length <= MAX_CODE ? out : null;
}

/** Characters that end a sentence or a label: ". ", ": ", ", " … */
const HARD_BREAK_RE = /[.:;,!?()[\]]/;
/** One hyphen or underscore joining two words: "one-time", "Zero_Thanks". */
const JOINER_RE = /^[-_]$/;
const MAX_PEEL = 2;

/**
 * Every spelled-out code in a text, and whether anything spelled was UNCLEAR.
 *
 * A "loose run" is number tokens (number words, single digits) with at most
 * MAX_GAP separator characters and no line break between them. A run is a
 * code only when:
 *   - it holds at least one number WORD ("Counter 1 2 3 4", "Slot 9-1-0-0"
 *     are not spelled codes);
 *   - every separator in it is the SAME ("Seven_Seven_Eight"). A single token
 *     at either end split off by punctuation is dropped first — "Sequence 2:
 *     Seven_Seven…", "…Five_Zero . One-time" — anything else that mixes
 *     separators is UNCLEAR ("Seven-Seven_Eight", a doubled "__");
 *   - no number word in it is half of a hyphenated word ("one-time",
 *     "Zero_Thanks") — that is UNCLEAR too;
 *   - it is MIN_CODE..MAX_CODE digits.
 * Multi-digit numbers are never part of a run: "Tk 2,000.00" is not a code.
 *
 * Unclear runs of MIN_CODE+ digits set `unclear`, and @words then answers
 * NOTHING: a cut-off code ("8050" from "Seven-Seven_Eight_Zero_Five_Zero")
 * would be a wrong code that looks right.
 *
 * @returns {{runs: Array<{start,end,digits}>, unclear: boolean}}
 */
function scanSpelled(text) {
    const s = String(text);
    // Tokens with their kind: 'num' (units), 'multi' (multi-digit), 'word'.
    const toks = [];
    for (const m of s.matchAll(TOKEN_RE)) {
        const tok = m[0];
        let kind, units = null, isWord = false;
        if (DIGITS_RE.test(tok)) {
            if (tok.length === 1) { kind = 'num'; units = [tok]; } else kind = 'multi';
        } else {
            units = wordUnits(tok);
            if (units) { kind = 'num'; isWord = true; } else kind = 'word';
        }
        toks.push({ start: m.index, end: m.index + tok.length, kind, units, isWord });
    }
    // A number word glued to an ordinary word by '-' or '_' is part of THAT
    // word ("one-time"). It cannot be a digit of a code.
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (t.kind !== 'num' || !t.isWord) continue;
        const prev = toks[i - 1], next = toks[i + 1];
        if ((prev && prev.kind === 'word' && JOINER_RE.test(s.slice(prev.end, t.start)))
         || (next && next.kind === 'word' && JOINER_RE.test(s.slice(t.end, next.start)))) {
            t.kind = 'compound';
        }
    }
    const linked = (a, b) => {
        const gap = s.slice(a.end, b.start);
        return gap.length <= MAX_GAP && !NEWLINE_RE.test(gap);
    };
    const runs = [];
    let unclear = false;
    let i = 0;
    while (i < toks.length) {
        if (toks[i].kind !== 'num') { i++; continue; }
        let j = i;
        while (j + 1 < toks.length && toks[j + 1].kind === 'num' && linked(toks[j], toks[j + 1])) j++;
        let run = toks.slice(i, j + 1);
        // A hyphenated number word right next to the run, NOT across a
        // sentence break, could be read as one more digit: unclear.
        const joins = (a, b) => linked(a, b) && !HARD_BREAK_RE.test(s.slice(a.end, b.start));
        const touchesCompound = (i > 0 && toks[i - 1].kind === 'compound' && joins(toks[i - 1], toks[i]))
            || (j + 1 < toks.length && toks[j + 1].kind === 'compound' && joins(toks[j], toks[j + 1]));
        i = j + 1;

        const total = unitsToDigits([].concat(...run.map(t => t.units))).length;
        if (!run.some(t => t.isWord)) continue;                 // digits only: not a spelled code
        let gaps = run.slice(1).map((t, k) => s.slice(run[k].end, t.start));
        let peelHead = 0, peelTail = 0, clear = true;
        while (gaps.length && !gaps.every(g => g === gaps[0])) {
            const n = gaps.length;
            if (peelHead < MAX_PEEL && HARD_BREAK_RE.test(gaps[0]) && (n < 2 || gaps[0] !== gaps[1])) {
                run = run.slice(1); gaps = gaps.slice(1); peelHead++;
            } else if (peelTail < MAX_PEEL && HARD_BREAK_RE.test(gaps[n - 1]) && (n < 2 || gaps[n - 1] !== gaps[n - 2])) {
                run = run.slice(0, -1); gaps = gaps.slice(0, -1); peelTail++;
            } else { clear = false; break; }
        }
        if (!clear || touchesCompound) {
            if (total >= MIN_CODE) unclear = true;
            continue;
        }
        if (!run.some(t => t.isWord)) continue;
        const digits = unitsToDigits([].concat(...run.map(t => t.units)));
        if (digits.length >= MIN_CODE && digits.length <= MAX_CODE) {
            runs.push({ start: run[0].start, end: run[run.length - 1].end, digits });
        } else if (digits.length > MAX_CODE) {
            unclear = true;
        }
    }
    return { runs, unclear };
}

/** The clear spelled-out codes in a text (see scanSpelled). */
function spelledRuns(text) { return scanSpelled(text).runs; }

/**
 * The built-in @words reader: the ONE spelled-out code in the message.
 *
 * @returns {{code: string|null, unclear: boolean}} code null when there is
 *   none, when anything spelled is unclear, or when there are two DIFFERENT
 *   codes — never a guess. `unclear` tells extractDetailed to STOP (no code)
 *   rather than let a later pattern read, say, an amount.
 */
/** "code is 445566", "OTP: 445566" — the message itself NAMES a digit code. */
const LABELLED_DIGITS_RE = /\b(?:otp|code|pin|passcode|password)\b[^0-9\n]{0,25}?(?<![0-9])([0-9]{4,10})(?![0-9])/gi;

function readWords(text) {
    const s = String(text);
    const { runs, unclear } = scanSpelled(s);
    if (unclear) return { code: null, unclear: true };
    if (runs.length === 0) return { code: null, unclear: false };
    const first = runs[0].digits;
    for (let i = 1; i < runs.length; i++) if (runs[i].digits !== first) return { code: null, unclear: true };
    // "Your code is 445566 … Ref one two three four": the message names a
    // DIFFERENT digit code — the spelled run is not it (review, 4.43.0).
    // The same value written both ways ("778050 (Seven Seven …)") is fine.
    for (const m of s.matchAll(LABELLED_DIGITS_RE)) {
        if (m[1] !== first) return { code: null, unclear: true };
    }
    return { code: first, unclear: false };
}

/** @words as a plain answer: the code, or null. */
function readWordCode(text) { return readWords(text).code; }

/** Built-in readers usable in place of a regex in any rule. */
const BUILTINS = new Map([
    ['@words',     { builtin: 'words' }],
    ['@universal', { builtin: 'universal' }]
]);
function builtinOf(pattern) {
    return typeof pattern === 'string' ? (BUILTINS.get(pattern.trim().toLowerCase()) || null) : null;
}

/**
 * Does this message plausibly carry a code? Used ONLY to decide whether an
 * unread message is worth a push alert — never to extract anything.
 */
const CODE_HINT_RE = /\b(?:otp|code|pin|password|passcode|verification|verify|sequence|prompted|one[\s-]?time|token)\b/i;
function looksLikeOtp(message) {
    const m = normalizeDigits(String(message == null ? '' : message));
    // NOT "any 4+ digits": every bank and bKash receipt has a balance or a
    // number, and a sender rule that also gets receipts would alert all day.
    const sp = scanSpelled(m);
    return CODE_HINT_RE.test(m) || sp.runs.length > 0 || sp.unclear;
}

// ═════════════════════════════════════════════════════════════════
// UNIVERSAL OTP EXTRACTION (server 4.44.0)
//
// Extracts a verification/OTP code from ANY SMS, regardless of sender,
// without needing a configured filter rule. Uses a tiered strategy:
//
//   Tier 1a — LABELLED DIGIT CODE: keyword + 4-10 digits.
//             "Your OTP is 445566", "code: 778050", "445566 is your OTP".
//
//   Tier 1b — LABELLED ALPHANUMERIC CODE: keyword + 4-10 mixed alphanum.
//             "please enter E4H7n0 to verify", "code: Ab3Xy9".
//             ONLY when directly adjacent to a keyword. Must have at least one
//             letter AND one digit (or be in a clear code slot). Common English
//             words are excluded.
//
//   Tier 2 — SPELLED-OUT CODE: the existing @words reader.
//            "Four-Two-Six-One", "Seven_Seven_Eight_Zero_Five_Zero".
//
//   Tier 3 — CONTEXT + DIGITS: OTP keywords + standalone 4-8 digit number,
//            avoiding amounts, phone numbers, dates.
//
//   Tier 4 — LONE DIGIT CODE: exactly ONE standalone 4-8 digit number in the
//            entire message, no competitors.
//
// The universal extractor runs AFTER all sender-specific rules AND the DEFAULT
// rule have been tried. It is a LAST-RESORT fallback — it never overrides
// configured behaviour.
// ═════════════════════════════════════════════════════════════════

/**
 * Extended keyword regex for universal extraction. Broader than CODE_HINT_RE
 * because here we NEED high recall — false positives are filtered by the
 * digit-proximity and exclusion rules below, not by the keyword alone.
 *
 * Includes English and Bengali keywords commonly found in OTP messages.
 */
const UNIVERSAL_KEYWORD_RE = /\b(?:otp|o\.t\.p|code|pin|passcode|password|verification|verify|verified|verif[iy]|confirma?t?ion|confirm|validat(?:e|ion)|authenti(?:cate|cation)|security|secure|secret|one[\s-]?time|token|log[\s-]?in|login|sign[\s-]?in|signin|register|registration|activation|activate|access|session|trans(?:action)?|2fa|mfa|two[\s-]?factor|multi[\s-]?factor)\b/i;

/**
 * Labels that directly precede digits, broader than LABELLED_DIGITS_RE.
 * Each regex must have exactly one capture group for the digit code.
 *
 * Three shapes:
 *   1. keyword ... digits  ("Your OTP is 445566", "code: 778050")
 *   2. digits ... keyword  ("445566 is your OTP", "Use 778050 as your code")
 *   3. keyword-digits      ("G-123456", "#445566")
 */
const LABEL_BEFORE_DIGITS = /\b(?:otp|o\.t\.p|code|pin|passcode|password|verification[\s-]?code|security[\s-]?code|confirm(?:ation)?[\s-]?code|one[\s-]?time[\s-]?(?:code|password|pin)|token|activation[\s-]?code|login[\s-]?code|access[\s-]?code)\b[^0-9\n]{0,30}?(?<![0-9])([0-9]{4,10})(?![0-9])/gi;

const DIGITS_BEFORE_LABEL = /(?<![0-9])([0-9]{4,10})(?![0-9])[^0-9\n]{0,30}?\b(?:is[\s]+(?:your|the|a)[\s]+)?(?:otp|o\.t\.p|code|pin|passcode|password|verification[\s-]?code|security[\s-]?code|one[\s-]?time[\s-]?(?:code|password|pin)|token)\b/gi;

/** "G-123456", "#556677" — a letter/symbol prefix glued to digits. */
const PREFIX_CODE_RE = /(?:^|[\s])([A-Z][-.]?([0-9]{4,10}))(?![0-9])/gi;

/**
 * ── Tier 1b: LABELLED ALPHANUMERIC CODES ───────────────────────
 *
 * Matches codes like "E4H7n0", "Ab3Xy9", "4h7E2k" that sit right next to an
 * OTP keyword. These are MIXED alphanumeric — at least one letter AND at least
 * one digit, 4-10 characters total. Pure-alpha tokens like "parot" are also
 * accepted but ONLY in very tight keyword slots ("enter X to verify", "code: X")
 * and ONLY if they don't look like a common English word, URL fragment, or
 * common abbreviation.
 *
 * Shape 1: keyword ... alphanumcode   ("code: Ab3Xy9", "enter E4H7n0 to verify")
 * Shape 2: alphanumcode ... keyword   ("E4H7n0 is your code")
 */

// keyword → short gap (connectors like "is", ":", etc.) → alphanum token (4-10 chars)
// The gap allows: English connectors (is, for, was), Bengali connectors (হলো, হল, হচ্ছে),
// punctuation (:, =), and surrounding spaces.
const ALPHANUM_AFTER_KEYWORD = /\b(?:otp|o\.t\.p|code|pin|passcode|password|verification[\s-]?code|security[\s-]?code|confirm(?:ation)?[\s-]?code|one[\s-]?time[\s-]?(?:code|password|pin)|token|activation[\s-]?code|login[\s-]?code|access[\s-]?code)\b(?:\s*[:=]\s*|\s+(?:is|for|was|হলো|হল|হচ্ছে)?\s*)([A-Za-z0-9]{4,10})\b/gi;

// alphanum token → gap → keyword
const ALPHANUM_BEFORE_KEYWORD = /\b([A-Za-z0-9]{4,10})\b\s+(?:is\s+(?:your|the|a)\s+)?(?:otp|o\.t\.p|code|pin|passcode|password|verification[\s-]?code|security[\s-]?code|one[\s-]?time[\s-]?(?:code|password|pin)|token)\b/gi;

// "enter/use X to verify/confirm" — very tight slot, the code sits between
// an action verb and a verification verb.
const ENTER_X_TO_VERIFY = /\b(?:enter|use|type|input|submit|provide)\s+([A-Za-z0-9]{4,10})\s+(?:to\s+)?(?:verify|confirm|validate|authenticate|log\s*in|sign\s*in|activate|register|complete)\b/gi;

// "to verify/confirm enter/use X" — reversed order
const TO_VERIFY_ENTER_X = /\b(?:to\s+)?(?:verify|confirm|validate|authenticate|log\s*in|sign\s*in|activate|register|complete)\s+(?:please\s+)?(?:enter|use|type|input|submit|provide)\s+([A-Za-z0-9]{4,10})\b/gi;

/**
 * Common English words that should NEVER be extracted as codes.
 * Kept as a Set for O(1) lookups. All lowercase.
 * Covers: articles, prepositions, pronouns, conjunctions, common verbs,
 * common nouns, adverbs, adjectives, and words that appear in OTP messages.
 */
const COMMON_WORDS = new Set([
    // Articles, prepositions, conjunctions
    'that', 'this', 'with', 'from', 'your', 'have', 'been', 'will', 'more',
    'they', 'than', 'each', 'them', 'then', 'when', 'what', 'some', 'were',
    'also', 'into', 'only', 'just', 'over', 'such', 'much', 'very', 'most',
    'both', 'here', 'well', 'back', 'even', 'upon', 'like', 'near', 'once',
    'else', 'ever', 'last', 'long', 'next', 'till', 'down',
    // Common verbs
    'make', 'made', 'take', 'took', 'come', 'came', 'give', 'gave', 'know',
    'knew', 'find', 'keep', 'kept', 'help', 'call', 'send', 'sent', 'read',
    'need', 'work', 'want', 'does', 'done', 'said', 'goes', 'gone', 'tell',
    'told', 'left', 'used', 'open', 'move', 'live', 'turn', 'play', 'show',
    'save', 'stop', 'wait', 'fail', 'pass', 'test', 'copy', 'book', 'pick',
    'paid', 'sold', 'look', 'feel', 'stay', 'miss', 'lose', 'lost', 'hold',
    'held', 'pull', 'push', 'drop', 'plan', 'note', 'mark', 'link', 'load',
    'view', 'edit', 'scan', 'join', 'vote', 'hope', 'wish',
    // Common nouns
    'time', 'year', 'days', 'date', 'name', 'home', 'page', 'site', 'user',
    'data', 'info', 'list', 'item', 'type', 'text', 'file', 'form', 'bank',
    'card', 'cash', 'bill', 'free', 'team', 'case', 'area', 'part', 'line',
    'side', 'head', 'body', 'life', 'kind', 'sort', 'size', 'rate', 'cost',
    'deal', 'rule', 'role', 'step', 'fact', 'news', 'post', 'mail', 'shop',
    'sale', 'gift', 'food', 'good', 'best', 'high', 'real', 'full', 'easy',
    'safe', 'sure', 'fast', 'late', 'able',
    // OTP message words that could look like codes
    'code', 'enter', 'share', 'valid', 'reply', 'check', 'reset', 'click',
    'login', 'above', 'below', 'never', 'about', 'after', 'again', 'being',
    'could', 'first', 'given', 'great', 'shall', 'since', 'still', 'their',
    'there', 'these', 'thing', 'those', 'three', 'today', 'under', 'until',
    'using', 'where', 'which', 'while', 'would', 'other', 'right', 'start',
    'thank', 'total', 'value', 'visit', 'write',
    // Service names that appear in SMS
    'bkash', 'nagad', 'uber', 'grab',
    // Common abbreviations/short words that could match 4-char threshold
    'mins', 'secs', 'hour', 'okay', 'dear', 'http', 'https', 'smtp', 'imap',
    'null', 'true', 'false', 'auto', 'plus', 'zero', 'half', 'dont', 'wont',
    'cant', 'hire', 'fire', 'wire',
]);

/**
 * Is this token a pure number (all digits)?
 * Pure digit tokens are handled by Tier 1a, not here.
 */
function isAllDigits(s) { return /^[0-9]+$/.test(s); }

/**
 * Is this token mixed alphanumeric? (has at least 1 letter AND 1 digit)
 */
function isMixedAlphanum(s) {
    return /[A-Za-z]/.test(s) && /[0-9]/.test(s);
}

/**
 * Check if a token looks like a URL/domain fragment, email part, or
 * other non-code string.
 */
function looksLikeNonCode(token, text, matchIndex) {
    const lower = token.toLowerCase();
    // Common English word
    if (COMMON_WORDS.has(lower)) return true;
    // Part of a URL or email — check surrounding chars
    const before = text.slice(Math.max(0, matchIndex - 10), matchIndex);
    const after  = text.slice(matchIndex + token.length, matchIndex + token.length + 10);
    // Slash or @ adjacent — definitely URL/email
    if (/[/@]$/.test(before) || /^[/@]/.test(after)) return true;
    // Dot BEFORE the token (domain.token) — URL/domain fragment
    if (/\.$/.test(before)) return true;
    // Dot AFTER the token — only reject if it's a domain-like continuation
    // (e.g., "token.com"), NOT a sentence-ending period ("token. Next sentence")
    if (/^\./.test(after) && /^\.[A-Za-z]/.test(after)) return true;
    return false;
}

/**
 * Things that look like digit codes but are NOT OTPs. Currency amounts, phone
 * numbers, dates, reference/account numbers, balances.
 */
const AMOUNT_PREFIX_RE    = /(?:tk|taka|bdt|rs|inr|usd|\$|₹|৳|£|€|amt|amount|balance|charge|fee|paid|debit|credit|received|sent|total|ref|reference|a\/c|account|acc|acct|txn|trxn|id|#)\s*[:.]?\s*$/i;
const AMOUNT_SUFFIX_RE    = /^\s*(?:tk|taka|bdt|rs|rupees?|dollars?)/i;
const PHONE_LIKE_RE       = /(?:call|contact|dial|phone|mobile|helpline|whatsapp|wa)\s*[:.]?\s*$/i;

/**
 * Find ALL standalone digit groups (4-10 digits, not part of a longer number)
 * in the text, with their positions.
 */
const STANDALONE_DIGITS_RE = /(?<![0-9.+])([0-9]{4,10})(?![0-9])/g;

/**
 * Is this digit group likely an amount, phone number, date or reference — NOT
 * an OTP? Checks the surrounding context.
 */
function isLikelyNotOtp(text, matchIndex, matchLength) {
    const before = text.slice(Math.max(0, matchIndex - 40), matchIndex);
    const after  = text.slice(matchIndex + matchLength, matchIndex + matchLength + 20);
    // Currency amount: "Tk 2000", "$500", "balance: 50000"
    if (AMOUNT_PREFIX_RE.test(before)) return true;
    if (AMOUNT_SUFFIX_RE.test(after))  return true;
    // Phone number hint: "call 01712345678"
    if (PHONE_LIKE_RE.test(before))    return true;
    // Decimal number: "2000.00" or "2,000"
    if (/\.\d/.test(after) || /\d[,.]$/.test(before)) return true;
    // Date-like: "25/10/2024", "2024-10-25", "25-10-24"
    if (/[/-]$/.test(before) && /^[/-]/.test(after)) return true;
    if (/\d[/-]$/.test(before) || /^[/-]\d/.test(after)) return true;
    // Part of a URL/domain/email: digits embedded inside a word (letters on BOTH
    // sides, e.g. "site1234com") or glued to URL-specific chars (@, /)
    // "site1234.com" → before ends with "site", after starts with ".com"
    if (/[A-Za-z]$/.test(before) && /^[.@/A-Za-z]/.test(after)) return true;
    // Digits next to @ or /
    if (/@$/.test(before) || /^@/.test(after)) return true;
    if (/\/$/.test(before) || /^\//.test(after)) return true;
    // Digits preceded by a dot (URL path segment: ".1234")
    if (/\.$/.test(before)) return true;
    // Digits followed by a dot + letters (domain: "1234.com") but NOT sentence end
    if (/^\.[A-Za-z]/.test(after)) return true;
    return false;
}

/**
 * Universal OTP extraction — the ONE function that tries to read a code from
 * any SMS, without any configured rule.
 *
 * @param {string} message — the SMS body (already normalizeDigits'd)
 * @returns {string|null} the extracted code, or null
 */
function extractUniversal(message) {
    const text = String(message);

    // ── Tier 1: labelled digits ─────────────────────────────────
    // The message explicitly puts a keyword next to a digit code.
    // Try "keyword ... digits" first, then "digits ... keyword".
    let candidates = [];
    for (const re of [LABEL_BEFORE_DIGITS, DIGITS_BEFORE_LABEL]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
            const digits = m[1] || m[2];
            if (digits && digits.length >= MIN_CODE && digits.length <= MAX_CODE) {
                // Double check it's not an amount
                const idx = text.indexOf(digits, m.index);
                if (!isLikelyNotOtp(text, idx, digits.length)) {
                    candidates.push(digits);
                }
            }
        }
    }
    // If labelled digits found, return the first one (closest to the keyword).
    if (candidates.length > 0) return candidates[0];

    // Dashed/spaced digit groups near keywords: "445-566", "44 55 66"
    // Some services split the code with dashes or spaces. Try collapsing them.
    {
        const DASHED_CODE_RE = /\b(?:otp|o\.t\.p|code|pin|passcode|password|verification[\s-]?code|security[\s-]?code|one[\s-]?time[\s-]?(?:code|password|pin)|token)\b[^0-9\n]{0,30}?([0-9]{1,5}[\s-][0-9]{1,5}(?:[\s-][0-9]{1,5})?)(?![0-9])/gi;
        DASHED_CODE_RE.lastIndex = 0;
        let dm;
        while ((dm = DASHED_CODE_RE.exec(text)) !== null) {
            const raw = dm[1];
            const collapsed = raw.replace(/[\s-]/g, '');
            if (collapsed.length >= MIN_CODE && collapsed.length <= MAX_CODE) {
                return collapsed;
            }
        }
    }

    // Also try the prefix pattern: "G-123456"
    PREFIX_CODE_RE.lastIndex = 0;
    let pm;
    while ((pm = PREFIX_CODE_RE.exec(text)) !== null) {
        const digits = pm[2];
        if (digits && digits.length >= MIN_CODE && digits.length <= MAX_CODE) {
            // Only if there's an OTP keyword somewhere in the message
            if (UNIVERSAL_KEYWORD_RE.test(text)) return digits;
        }
    }

    // ── Tier 1b: labelled alphanumeric codes ───────────────────
    // Mixed alphanumeric codes (at least 1 letter + 1 digit) adjacent to a
    // keyword. Example: "code: Ab3Xy9", "enter E4H7n0 to verify".
    // Pure-alpha tokens are accepted ONLY from the tight "enter X to verify"
    // / "to verify enter X" patterns, and only if they aren't common words.
    {
        // First: tight "enter X to verify" / "to verify enter X" slots —
        // these accept BOTH mixed AND pure-alpha tokens.
        for (const re of [ENTER_X_TO_VERIFY, TO_VERIFY_ENTER_X]) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(text)) !== null) {
                const token = m[1];
                if (isAllDigits(token)) continue; // digits handled by Tier 1a
                if (!looksLikeNonCode(token, text, m.index + m[0].indexOf(token))) {
                    return token;
                }
            }
        }

        // Second: keyword ... alphanum / alphanum ... keyword patterns —
        // these require MIXED alphanumeric (at least 1 letter + 1 digit).
        for (const re of [ALPHANUM_AFTER_KEYWORD, ALPHANUM_BEFORE_KEYWORD]) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(text)) !== null) {
                const token = m[1];
                if (isAllDigits(token)) continue; // digits handled by Tier 1a
                if (!isMixedAlphanum(token)) continue; // pure alpha rejected here
                if (!looksLikeNonCode(token, text, m.index + m[0].indexOf(token))) {
                    return token;
                }
            }
        }
    }

    // ── Tier 2: spelled-out code ────────────────────────────────
    // Already handled by @words reader; try it here too.
    const spelled = readWords(text);
    if (spelled.code) return spelled.code;
    // If spelled was unclear, stop — no guessing.
    if (spelled.unclear) return null;

    // ── Tier 3: keyword context + standalone digit ──────────────
    // The message has an OTP keyword AND standalone digits. Pick the digit
    // group most likely to be the OTP (closest to keyword, not an amount).
    if (UNIVERSAL_KEYWORD_RE.test(text)) {
        const digitGroups = [];
        STANDALONE_DIGITS_RE.lastIndex = 0;
        let dm;
        while ((dm = STANDALONE_DIGITS_RE.exec(text)) !== null) {
            const d = dm[1];
            if (d.length >= MIN_CODE && d.length <= MAX_CODE
                && !isLikelyNotOtp(text, dm.index, d.length)) {
                digitGroups.push(d);
            }
        }
        // Exactly one candidate after filtering — confident.
        if (digitGroups.length === 1) return digitGroups[0];
        // Multiple candidates: pick the shortest (OTPs are typically 4-6 digits,
        // amounts are larger). If tied, pick the first.
        if (digitGroups.length > 1) {
            digitGroups.sort((a, b) => a.length - b.length || 0);
            return digitGroups[0];
        }
    }

    // ── Tier 4: lone standalone code ────────────────────────────
    // No keyword at all, but the message has exactly ONE standalone 4-8 digit
    // number. Common for terse OTP messages: just "123456" or "Your code 556677".
    // Slightly lower max (8, not 10) to avoid matching account/reference numbers.
    const allDigits = [];
    STANDALONE_DIGITS_RE.lastIndex = 0;
    let am;
    while ((am = STANDALONE_DIGITS_RE.exec(text)) !== null) {
        const d = am[1];
        if (d.length >= MIN_CODE && d.length <= 8
            && !isLikelyNotOtp(text, am.index, d.length)) {
            allDigits.push(d);
        }
    }
    if (allDigits.length === 1) return allDigits[0];

    return null;
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
    // A built-in reader is cached like a regex; extractCode tells them apart
    // by `.builtin`, which a RegExp does not have.
    const builtin = builtinOf(pattern);
    if (builtin) { patternCache.set(pattern, builtin); return builtin; }
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
    return extractDetailed(message, sender, recipient, filterRules).code;
}

const NOTHING = Object.freeze({ code: null, rule: null, pattern: null });

/**
 * extractCode, plus WHICH rule claimed the message and which pattern read it.
 *
 * @returns {{code: string|null, rule: string|null, pattern: string|null}}
 *   rule: the claiming rule's phoneNumber, 'DEFAULT', or null (no rules).
 *   stopped: a pattern MATCHED but could not read a code (unclear spelling,
 *   no digits, under 4 digits) — extraction ended there on purpose; `pattern`
 *   names it.
 *   Teach and the "SMS not read" alert need the rule; /get never does.
 */
function extractDetailed(message, sender, recipient, filterRules) {
    if (!message) return NOTHING;
    // filterRules may be empty or absent — the universal fallback (step 4)
    // still runs, so we do NOT bail here for an empty array.

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
    let ruleName = null;

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
            ruleName = String(rule.phoneNumber);
            break;
        }
    }

    // 2. Fall back to DEFAULT patterns
    if (patterns.length === 0) {
        const def = filterRules.find(r => r && r.phoneNumber === 'DEFAULT');
        if (def && Array.isArray(def.patterns)) patterns = def.patterns;
        ruleName = def ? 'DEFAULT' : null;
    }

    // 3. Try each pattern in order — a regex, or a built-in reader (@words / @universal)
    for (const pattern of Array.isArray(patterns) ? patterns : []) {
        if (typeof pattern !== 'string') continue;
        const re = compile(pattern);
        if (!re) continue;                      // invalid pattern, already logged once
        let code;
        if (re.builtin === 'words') {
            const w = readWords(message);
            // Spelled content that is unclear: STOP. Falling through could let
            // a later pattern (a catch-all) read an amount as the code.
            if (w.unclear) return { code: null, rule: ruleName, pattern, stopped: true };
            if (!w.code) continue;
            code = w.code;
        } else if (re.builtin === 'universal') {
            code = extractUniversal(message);
            if (!code) continue;
        } else {
            const match = message.match(re);
            if (!match || !match[1]) continue;
            code = convertTextToNumber(match[1].trim());
            // The pattern RECOGNISED this message but its capture holds no
            // digits and no number words: the format changed under it. STOP
            // with no code (the "SMS not read" alert follows) — falling
            // through to a catch-all is how an amount gets served (review,
            // 4.43.0; 4.42.4 fell through).
            if (!code) return { code: null, rule: ruleName, pattern, stopped: true };
        }
        return { code, rule: ruleName, pattern };
    }

    // ═════════════════════════════════════════════════════════════
    // 4. UNIVERSAL FALLBACK (server 4.44.0)
    //
    // Every configured rule — sender-specific AND DEFAULT — has been tried and
    // none produced a code. The universal extractor is the LAST resort: it uses
    // keyword detection, labelled-digit patterns, and context-aware filtering
    // to read an OTP from ANY message format.
    //
    // This is what makes GetOTP work for unknown senders without needing a
    // filter rule for every service. A user who gets an OTP from a new service
    // does not have to go to the dashboard and add a pattern first.
    //
    // It runs unconditionally — no sender match needed — but AFTER everything
    // configured, so it never overrides an operator's rules.
    // ═════════════════════════════════════════════════════════════
    {
        const code = extractUniversal(message);
        if (code) return { code, rule: ruleName || 'UNIVERSAL', pattern: '@universal' };
    }

    return { code: null, rule: ruleName, pattern: null };
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
    if (builtinOf(pattern)) return null;
    if (/^\s*@[A-Za-z]\w*\s*$/.test(pattern)) {
        return 'is not a built-in reader — available readers are @words (a spelled-out code: '
             + '"Seven_Seven_Eight…", "four-two-six-one", "1 2 3 4") and @universal '
             + '(auto-detect OTP from any message format)';
    }

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

/**
 * The identity of a rule: two names with the same key are the same sender
 * (IVAC_BD = IVACBD = "ivac bd"). The same normalisation as sender matching
 * and store.mergeFilterRules.
 */
function ruleKey(name) {
    if (name === 'DEFAULT') return 'DEFAULT';
    return String(name == null ? '' : name).toUpperCase().replace(/[\s_-]/g, '');
}

module.exports = { extractCode, extractDetailed, extractUniversal, convertTextToNumber, clearPatternCache,
                   validatePattern, validateRule, normalizeDigits, senderClaimedBy, readWordCode, spelledRuns,
                   looksLikeOtp, builtinOf, ruleKey, wordUnits, scanSpelled, readWords,
                   EN_DIGIT_WORDS, BN_DIGIT_WORDS, MIN_CODE, MAX_CODE };
