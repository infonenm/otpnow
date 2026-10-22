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
const BUILTINS = new Map([['@words', { builtin: 'words' }]]);
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
    if (!message || !filterRules || filterRules.length === 0) return NOTHING;

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

    // 3. Try each pattern in order — a regex, or a built-in reader (@words)
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
        return 'is not a built-in reader — the only one is @words (a spelled-out code: '
             + '"Seven_Seven_Eight…", "four-two-six-one", "1 2 3 4")';
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

module.exports = { extractCode, extractDetailed, convertTextToNumber, clearPatternCache, validatePattern,
                   validateRule, normalizeDigits, senderClaimedBy, readWordCode, spelledRuns, looksLikeOtp,
                   builtinOf, ruleKey, wordUnits, scanSpelled, readWords,
                   EN_DIGIT_WORDS, BN_DIGIT_WORDS, MIN_CODE, MAX_CODE };
