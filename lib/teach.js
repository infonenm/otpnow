'use strict';
/**
 * lib/teach.js — "Teach from SMS" (server 4.43.0).
 *
 * =============================================================================
 * WHY THIS EXISTS
 *
 * IVAC changes its OTP SMS wording and format every few days. Each change used
 * to mean: notice the OTP is missing, work out a regex, paste it, hope. The
 * operator now pastes the NEW message and the code part of it, and the server
 * does the rest:
 *
 *   1. finds that code inside the message (as typed, or by its digits);
 *   2. builds a pattern anchored on the word before it ("prompted") with a
 *      capture that fits the format (spelled words with this separator, or
 *      plain digits);
 *   3. VERIFIES it — the whole rule, not the pattern alone — on this message
 *      and on every message taught before, for every rule;
 *   4. shows what changes, and applies it only when the admin says so.
 *
 * WHY THE ADMIN TYPES THE CODE. From the message alone the server cannot know
 * which number is the OTP: "Pay Tk 2000 … code 445566" has two. Guessing is
 * exactly how an amount gets served as an OTP — the failure this codebase has
 * fought hardest. One typed answer removes the guess.
 *
 * WHY TAUGHT EXAMPLES ARE KEPT. Each one is a message with a KNOWN right
 * answer. Every later Teach and every filter save re-checks them, so a new
 * pattern can never silently break a format that was working.
 *
 * Nothing here is on the SMS or /get path. Pure functions over the filters,
 * plus the small in-memory list of messages that were not read.
 * =============================================================================
 */

const crypto = require('crypto');
const otp    = require('./otp');

const MAX_MESSAGE = 1000;
const MAX_PART    = 200;
const MAX_RULE    = 100;
const EXAMPLES_PER_RULE = 10;
const EXAMPLES_TOTAL    = 200;

/**
 * Letters, for word edges and gaps. ASCII only for an English SMS (a readable
 * pattern); with the Bengali block when the SMS has Bengali. Patterns compile
 * without the u flag, so no \p{L}.
 */
const BENGALI_RE = /[ঀ-৿]/;
function letterClass(bengali) { return bengali ? 'A-Za-z\\u0980-\\u09FF' : 'A-Za-z'; }
/** Short words that make a weak anchor alone ("is 1234"): the word before them is added. */
const WEAK_ANCHORS = new Set(['is', 'are', 'was', 'the', 'your', 'you', 'to', 'as', 'be', 'a', 'an', 'of',
    'for', 'in', 'on', 'at', 'and', 'or', 'it', 'this', 'that', 'with', 'by', 'use', 'enter', 'type']);

// ── Spelled-code alternation for generated patterns ─────────────
// Only the words of the script the SMS uses, so an English pattern reads as
// English. Bengali: both encodings of য় (the regex does not normalise).
// Longest first, so no word is cut short by a shorter one.
const BN_ALTS = (() => {
    const set = new Set();
    for (const [w] of otp.BN_DIGIT_WORDS) {
        set.add(w.normalize('NFC'));
        set.add(w.normalize('NFC').replace(/য়/g, 'য়'));
    }
    return Array.from(set).sort((a, b) => b.length - a.length);
})();

/** The number-word group for a spelled code written like `spanText`. */
function wordGroup(spanText) {
    const alts = BENGALI_RE.test(spanText) ? BN_ALTS.slice() : otp.EN_DIGIT_WORDS.slice();
    if (/double|triple/i.test(spanText)) alts.unshift('double', 'triple');
    if (/[0-9]/.test(spanText)) alts.push('[0-9]');
    return `(?:${alts.join('|')})`;
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); }

function str(v) { return v == null ? '' : String(v); }

// ═════════════════════════════════════════════════════════════════
//  Taught examples
// ═════════════════════════════════════════════════════════════════

/**
 * Keep only well-formed examples, newest EXAMPLES_PER_RULE per rule, at most
 * EXAMPLES_TOTAL. Used on every load (state file, Firestore) and every write.
 */
function sanitizeExamples(list) {
    if (!Array.isArray(list)) return [];
    const ok = [];
    for (const e of list) {
        if (!e || typeof e !== 'object') continue;
        const rule = str(e.rule).trim().slice(0, MAX_RULE);
        const message = str(e.message).slice(0, MAX_MESSAGE);
        const code = str(e.code);
        if (!rule || rule === 'DEFAULT' || !otp.ruleKey(rule) || !message.trim()) continue;
        if (!/^[0-9]{4,10}$/.test(code)) continue;
        ok.push({ rule, sender: str(e.sender).slice(0, MAX_RULE), recipient: str(e.recipient).slice(0, MAX_RULE),
                  message, code, at: Number(e.at) || 0 });
    }
    // Newest first per rule, then restore oldest-first order.
    ok.sort((a, b) => b.at - a.at);
    const perRule = new Map();
    const kept = [];
    for (const e of ok) {
        const k = otp.ruleKey(e.rule);
        const n = perRule.get(k) || 0;
        if (n >= EXAMPLES_PER_RULE || kept.length >= EXAMPLES_TOTAL) continue;
        perRule.set(k, n + 1);
        kept.push(e);
    }
    return kept.reverse();
}

/** examples + one more. The same message for the same rule replaces the older copy. */
function addExample(examples, ex) {
    const k = otp.ruleKey(ex.rule);
    const rest = (examples || []).filter(e => !(otp.ruleKey(e.rule) === k && e.message === ex.message));
    return sanitizeExamples(rest.concat([ex]));
}

function removeExample(examples, rule, at) {
    const k = otp.ruleKey(rule);
    const before = (examples || []).length;
    const after = (examples || []).filter(e => !(otp.ruleKey(e.rule) === k && Number(e.at) === Number(at)));
    return { examples: after, removed: before - after.length };
}

/**
 * Taught examples the given filters read WRONG. Used to warn on a filter save
 * — never to refuse one: removing a format on purpose must stay possible.
 * @returns {string[]} one line per broken example
 */
function brokenExamples(filters, examples) {
    const out = [];
    for (const e of examples || []) {
        const got = otp.extractDetailed(e.message, e.sender || e.rule, e.recipient || '', filters);
        if (got.code !== e.code) {
            out.push(`${e.rule}: the message taught ${when(e.at)} would now read `
                + (got.code ? `as ${got.code}` : 'as no code') + ` — it should be ${e.code}`);
        }
    }
    return out;
}

function when(at) {
    if (!at) return 'earlier';
    const d = new Date(Number(at) + 6 * 3600_000);           // Asia/Dhaka, for the operator
    return 'on ' + d.toISOString().slice(0, 16).replace('T', ' ');
}

// ═════════════════════════════════════════════════════════════════
//  Finding the code in the message
// ═════════════════════════════════════════════════════════════════

/** The digits the operator means. "Seven_Seven_Eight…" or "778050" — both work. */
function codeOfPart(part) {
    return otp.convertTextToNumber(otp.normalizeDigits(part));
}

/**
 * Where the code sits in the message.
 *
 * First the text exactly as the operator pasted it (any case), at a word edge,
 * whose digits are the code. Then — when they typed the digits of a spelled
 * code, or the other way round — every spelled run and every plain number in
 * the message, by value.
 *
 * @returns {{start,end,text,occurrences}|null}
 */
function locate(message, part, code) {
    const hits = [];
    const p = part.trim();
    if (p) {
        const re = new RegExp(escapeRe(p), 'gi');
        let m;
        while ((m = re.exec(message)) !== null) {
            const start = m.index, end = start + m[0].length;
            if (m[0].length === 0) { re.lastIndex++; continue; }
            const before = message.charAt(start - 1), after = message.charAt(end);
            const edge = c => !c || !/[A-Za-z0-9ঀ-৿]/.test(c);
            if (edge(before) && edge(after) && codeOfPart(m[0]) === code) hits.push({ start, end });
        }
    }
    if (hits.length === 0) {
        for (const r of otp.spelledRuns(message)) if (r.digits === code) hits.push({ start: r.start, end: r.end });
        const numRe = /[0-9]+/g;
        let m;
        while ((m = numRe.exec(message)) !== null) {
            if (m[0] === code) hits.push({ start: m.index, end: m.index + m[0].length });
        }
        hits.sort((a, b) => a.start - b.start);
    }
    if (hits.length === 0) return null;
    const h = hits[0];
    return { start: h.start, end: h.end, text: message.slice(h.start, h.end), occurrences: hits.length };
}

// ═════════════════════════════════════════════════════════════════
//  Building the pattern
// ═════════════════════════════════════════════════════════════════

/** Tokens of a text, with positions: letters or digits, as the extractor sees them. */
function tokens(text) {
    const out = [];
    for (const m of String(text).matchAll(/[\p{L}\p{M}]+|\p{Nd}+/gu)) {
        out.push({ s: m[0], start: m.index, end: m.index + m[0].length });
    }
    return out;
}

/**
 * The capture for this code as it is written in the message — with EDGES on
 * both sides (review, 4.43.0): without them "…four two six one eighty" read
 * 42618 and "12345678901 is your OTP" read 45678901.
 */
function captureFor(spanText, code, bengali) {
    const L = letterClass(bengali);
    if (/^[0-9]+$/.test(spanText)) {
        const n = code.length;
        const q = n >= 4 && n <= 8 ? '{4,8}' : `{${n}}`;
        return { format: 'digits', capture: `(?<![0-9])([0-9]${q})(?![0-9])` };
    }
    // Spelled: how many words, and what sits between them.
    const toks = tokens(spanText);
    let words = 0;
    const gaps = new Set();
    let glued = false;
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        const u = /^[0-9]+$/.test(t.s) ? t.s.split('') : (otp.wordUnits(t.s) || []);
        words += u.length;
        if (u.length > 1 && !/^[0-9]+$/.test(t.s)) glued = true;      // SevenSeven
        if (i > 0) gaps.add(spanText.slice(toks[i - 1].end, t.start));
    }
    let sep;
    const list = Array.from(gaps);
    if (list.length === 0) sep = '';
    else if (list.length === 1 && !glued) {
        sep = /^[ \t]+$/.test(list[0]) ? '[ \\t]{1,3}' : (list[0] === '' ? '' : escapeRe(list[0]));
    } else {
        const chars = new Set(list.join('').split(''));
        const cls = Array.from(chars).map(c => (c === ' ' || c === '\t') ? (c === ' ' ? ' ' : '\\t')
            : escapeRe(c).replace(/^-$/, '\\-')).join('');
        sep = cls ? `[${cls}]{${(glued || list.includes('')) ? 0 : 1},3}` : '';
    }
    if (glued && sep && !/\{0,/.test(sep)) sep = `(?:${sep})?`;
    // Room for the code to grow or shrink by two, within 4..10 digits.
    const lo = Math.max(otp.MIN_CODE, words - 2) - 1;
    const hi = Math.min(otp.MAX_CODE, words + 2) - 1;
    const W = wordGroup(spanText);
    // Not inside a word on either side, and not followed by a word glued on
    // with '-'/'_' ("one-time", "Zero_Thanks"): then the run backs off, or
    // does not match at all — never a digit too many.
    return { format: 'spelled',
             capture: `(?<![${L}0-9])(${W}(?:${sep}${W}){${lo},${hi}})(?![-_]?[${L}0-9])` };
}

/**
 * Pattern candidates, best first. Each is verified on the message before use.
 *   1. the word before the code (two words when that one is weak: "is", "your")
 *   2. two words before the code
 *   3. the word after the code
 *   4. a spelled code alone (a spelled run is itself a strong signal)
 */
function candidates(message, span, capture, format) {
    const out = [];
    const LETTER = letterClass(BENGALI_RE.test(message));
    const NOT_ALNUM = `[^${LETTER}0-9]`;
    const prefix = message.slice(0, span.start);
    const pt = tokens(prefix);
    const isWord = t => t && !/^[0-9]+$/.test(t.s) && !otp.wordUnits(t.s);
    const t1 = pt[pt.length - 1], t0 = pt[pt.length - 2];
    const gapLen = s => Math.max(6, s.length + 3);
    if (isWord(t1) && !/[\r\n]/.test(prefix.slice(t1.end))) {
        const g1 = prefix.slice(t1.end);
        const gap = `${NOT_ALNUM}{0,${gapLen(g1)}}`;
        const one = `(?<![${LETTER}])${escapeRe(t1.s)}${gap}${capture}`;
        let two = null;
        if (isWord(t0)) {
            const g0 = prefix.slice(t0.end, t1.start);
            if (g0.length <= 4 && !/[\r\n]/.test(g0)) {
                two = `(?<![${LETTER}])${escapeRe(t0.s)}${NOT_ALNUM}{1,4}${escapeRe(t1.s)}${gap}${capture}`;
            }
        }
        const weak = WEAK_ANCHORS.has(t1.s.toLowerCase()) || t1.s.length < 3;
        if (weak && two) out.push({ pattern: two, anchor: `${t0.s} ${t1.s}` });
        out.push({ pattern: one, anchor: t1.s });
        if (!weak && two) out.push({ pattern: two, anchor: `${t0.s} ${t1.s}` });
    }
    const suffix = message.slice(span.end);
    const st = tokens(suffix);
    const n1 = st[0], n2 = st[1];
    if (isWord(n1) && !/[\r\n]/.test(suffix.slice(0, n1.start))) {
        const g = suffix.slice(0, n1.start);
        const head = `${capture}${NOT_ALNUM}{0,${gapLen(g)}}${escapeRe(n1.s)}`;
        const weak = WEAK_ANCHORS.has(n1.s.toLowerCase()) || n1.s.length < 3;
        const g2 = n2 ? suffix.slice(n1.end, n2.start) : '';
        if (weak && isWord(n2) && g2.length <= 4 && !/[\r\n]/.test(g2)) {
            out.push({ pattern: `${head}${NOT_ALNUM}{1,4}${escapeRe(n2.s)}(?![${LETTER}])`, anchor: `${n1.s} ${n2.s}` });
        }
        out.push({ pattern: `${head}(?![${LETTER}])`, anchor: n1.s });
    }
    if (format === 'spelled') out.push({ pattern: `(?<![${LETTER}])${capture}`, anchor: null });
    return out;
}

/** The code ONE pattern alone reads from this message (null = no match). */
function readWith(pattern, message) {
    return outcomeOf(pattern, message).code;
}

/** What ONE pattern does with this message: {code, stopped}. */
function outcomeOf(pattern, message) {
    const r = otp.extractDetailed(message, 'X', '', [{ phoneNumber: 'DEFAULT', patterns: [pattern] }]);
    return { code: r.code, stopped: !!r.stopped };
}

// ═════════════════════════════════════════════════════════════════
//  Analyse
// ═════════════════════════════════════════════════════════════════

function fingerprint(filters, examples) {
    return crypto.createHash('sha1').update(JSON.stringify([filters || [], examples || []]))
        .digest('hex').slice(0, 16);
}

function findRule(filters, rule) {
    const k = otp.ruleKey(rule);
    return (filters || []).find(r => r && r.phoneNumber !== 'DEFAULT' && otp.ruleKey(r.phoneNumber) === k) || null;
}

/** filters with this rule's patterns replaced (or the rule added at the end). */
function withRule(filters, ruleName, patterns) {
    const k = otp.ruleKey(ruleName);
    let found = false;
    const out = (filters || []).map(r => {
        if (r && r.phoneNumber !== 'DEFAULT' && otp.ruleKey(r.phoneNumber) === k) {
            found = true;
            return Object.assign({}, r, { patterns: patterns.slice() });
        }
        return r;
    });
    if (!found) out.push({ phoneNumber: ruleName, patterns: patterns.slice() });
    return out;
}

/**
 * Teach: what WOULD change. Applies nothing.
 *
 * @param {object} p
 * @param {string} p.message  the full SMS
 * @param {string} p.otpPart  the code as written in it, or its digits
 * @param {string} p.rule     the sender rule to teach ("IVACBD")
 * @param {string} [p.sender] the real sender, when known (from an unread message)
 * @param {Array}  p.filters  the running filters
 * @param {Array}  p.examples the taught examples
 * @param {Array}  [p.recent] recent messages {sender, recipient, message, code}
 */
function analyze(p) {
    const message = otp.normalizeDigits(str(p.message)).replace(/\r\n/g, '\n');
    const part = str(p.otpPart);
    const ruleIn = str(p.rule).trim();
    const filters = Array.isArray(p.filters) ? p.filters : [];
    const recipient = str(p.recipient).trim();
    const examples = Array.isArray(p.examples) ? p.examples : [];
    const fail = error => ({ ok: false, canApply: false, error, basedOn: fingerprint(filters, examples) });

    if (!message.trim()) return fail('Paste the full SMS.');
    if (message.length > MAX_MESSAGE) return fail(`The SMS is longer than ${MAX_MESSAGE} characters.`);
    if (!part.trim()) return fail('Paste the OTP part — the code as it is written in the SMS, or its digits.');
    if (part.length > MAX_PART) return fail('The OTP part is too long.');
    if (!ruleIn) return fail('Choose the sender rule this SMS comes from (e.g. IVACBD).');
    if (ruleIn.length > MAX_RULE) return fail('The sender name is too long.');
    if (ruleIn === 'DEFAULT' || otp.ruleKey(ruleIn) === 'DEFAULT') {
        return fail('Teach a sender rule, not DEFAULT — DEFAULT reads every sender, and a pattern taught '
            + 'for one sender would run on all of them.');
    }
    if (otp.validateRule({ phoneNumber: ruleIn })) return fail('That sender name is blank.');

    const code = codeOfPart(part);
    if (!code || code.length < otp.MIN_CODE || code.length > otp.MAX_CODE) {
        return fail(`"${part.trim()}" is not a code of ${otp.MIN_CODE}–${otp.MAX_CODE} digits. Paste the `
            + 'code part exactly as it is in the SMS ("Seven_Seven_Eight_Zero_Five_Zero"), or its digits.');
    }

    const span = locate(message, part, code);
    if (!span) {
        return fail(`Could not find ${code} in this SMS. Paste the code part exactly as it appears in the `
            + 'message, or check the digits.');
    }

    const existing = findRule(filters, ruleIn);
    const ruleName = existing ? String(existing.phoneNumber) : ruleIn;
    const sender = str(p.sender).trim() || ruleName;
    const warnings = [];
    // Twice in one SMS ("Pay Tk 2000 … OTP 2000"): which one is the OTP is a
    // guess, and a pattern anchored on the wrong one reads the amount from then
    // on (review, 4.43.0). Refused, not guessed.
    if (span.occurrences > 1) {
        return fail(`${code} appears ${span.occurrences} times in this SMS, so it is not clear which one is the `
            + 'OTP. Teach it from a message where the code appears once.');
    }

    // What the running filters read from it today.
    const nowRead = otp.extractDetailed(message, sender, recipient, filters);
    if (existing && nowRead.rule && otp.ruleKey(nowRead.rule) !== otp.ruleKey(ruleName)) {
        return fail(`Messages from "${sender}" are claimed by the rule "${nowRead.rule}", which comes first — `
            + `a pattern on "${ruleName}" would never run. Teach "${nowRead.rule}" instead.`);
    }

    // The pattern: first candidate that reads exactly this code.
    const { format, capture } = captureFor(span.text, code, BENGALI_RE.test(message));
    let chosen = null;
    for (const c of candidates(message, span, capture, format)) {
        if (otp.validatePattern(c.pattern)) continue;
        if (readWith(c.pattern, message) === code) { chosen = c; break; }
    }
    if (!chosen) {
        return fail('No reliable pattern could be built from this SMS: the code has no word next to it '
            + 'that could anchor it. Add a pattern by hand under Number-specific rules.');
    }
    if (!chosen.anchor) warnings.push('No word next to the code to anchor on — the pattern reads the spelled code alone.');

    // The whole rule, reordered so a pattern that MISREADS this message can
    // only run after everything that reads it right (and after @words).
    const before = existing ? existing.patterns.filter(x => typeof x === 'string') : [];
    const keep = [], demote = [];
    const seen = new Set([chosen.pattern]);
    for (const pat of before) {
        if (seen.has(pat)) continue;
        seen.add(pat);
        // Moved below everything that reads it right when it READS IT WRONG,
        // or when it MATCHES and stops with nothing — a stop ends the rule, so
        // above @words it would switch the safety net off.
        const o = outcomeOf(pat, message);
        const bad = (o.code && o.code !== code) || o.stopped;
        (bad ? demote : keep).push({ pattern: pat, reads: o.code, stopped: o.stopped });
    }
    const list = [{ pattern: chosen.pattern, status: 'new' }]
        .concat(keep.map(k => ({ pattern: k.pattern, status: 'kept' })));
    if (format === 'spelled' && !seen.has('@words') && !before.some(x => otp.builtinOf(x))) {
        list.push({ pattern: '@words', status: 'added',
                    note: 'Built-in reader for spelled codes — any separator. Catches the next format change.' });
    }
    for (const d of demote) {
        list.push({ pattern: d.pattern, status: 'moved', note: (d.reads
            ? `Reads this SMS as ${d.reads} (wrong)` : 'Matches this SMS but reads no code')
            + ' — moved last, so it only runs when everything above finds nothing.' });
    }
    const patterns = list.map(x => x.pattern);
    const proposed = withRule(filters, ruleName, patterns);

    // ── Checks: this SMS, and every taught example, with the WHOLE new filter set.
    const checks = [];
    const got = otp.extractDetailed(message, sender, recipient, proposed);
    checks.push({ kind: 'sample', label: 'This SMS', expected: code, got: got.code, ok: got.code === code });
    if (got.code === code && got.rule && otp.ruleKey(got.rule) !== otp.ruleKey(ruleName)) {
        checks[0].ok = false;
        checks[0].note = `read by "${got.rule}", not by "${ruleName}"`;
    }
    for (const e of examples) {
        // The same message taught again (compared as the extractor sees it —
        // Bengali digits and line ends normalised) is replaced, not checked.
        if (otp.ruleKey(e.rule) === otp.ruleKey(ruleName)
            && otp.normalizeDigits(e.message).replace(/\r\n/g, '\n') === message) continue;
        const g = otp.extractDetailed(e.message, e.sender || e.rule, e.recipient || '', proposed);
        checks.push({ kind: 'example', label: `${e.rule} — taught ${when(e.at)}`, rule: e.rule, at: e.at,
                      expected: e.code, got: g.code, ok: g.code === e.code });
    }

    // ── Recent messages from this sender: what changes (information only).
    const changes = [];
    let recentSame = 0;
    for (const r of (Array.isArray(p.recent) ? p.recent : []).slice(-200)) {
        const was = otp.extractDetailed(r.message, r.sender, r.recipient, filters);
        const now = otp.extractDetailed(r.message, r.sender, r.recipient, proposed);
        const mine = [was.rule, now.rule].some(x => x && otp.ruleKey(x) === otp.ruleKey(ruleName));
        if (!mine) continue;
        if (was.code === now.code) { recentSame++; continue; }
        changes.push({ sender: str(r.sender), at: Number(r.receivedAt) || 0,
                       was: was.code, now: now.code, snippet: str(r.message).slice(0, 120) });
    }

    // A recent SMS that read a code today and would read a DIFFERENT code after
    // Add is not proof of a mistake (today's code may be the wrong one) — but
    // it must never pass unnoticed.
    const flipped = changes.filter(c => c.was && c.now && c.was !== c.now
        && otp.normalizeDigits(c.snippet) !== message.slice(0, 120));
    if (flipped.length) {
        warnings.push(`${flipped.length} recent SMS would read a DIFFERENT code than today — check them below `
            + 'before you Add.');
    }
    if (!existing && changes.some(c => !c.was && c.now)) {
        warnings.push(`The new rule "${ruleName}" also takes messages that went to DEFAULT until now — check `
            + 'the recent SMS below.');
    }

    const failed = checks.filter(c => !c.ok);
    return {
        ok: true,
        canApply: failed.length === 0,
        rule: ruleName,
        ruleExists: !!existing,
        sender,
        recipient,
        code,
        format,
        found: span,
        anchor: chosen.anchor,
        pattern: chosen.pattern,
        nowReads: nowRead.code,
        patterns: list,
        checks,
        changes,
        recentSame,
        warnings,
        blocked: failed.length ? failed.map(c => `${c.label}: should read ${c.expected}, would read `
            + (c.got || 'no code') + (c.note ? ` (${c.note})` : '')) : [],
        basedOn: fingerprint(filters, examples),
        proposedFilters: proposed
    };
}

// ═════════════════════════════════════════════════════════════════
//  Messages that were not read
// ═════════════════════════════════════════════════════════════════
//
// A message a SENDER RULE claimed and could not read. The likeliest reason is
// that the sender changed its format — so the list is what Teach offers to
// fill itself from, and the alert says it happened. In memory: a restart
// forgets it, and the next unread SMS starts it again.

const UNREAD_MAX = 20;
const UNREAD_MS  = 24 * 3600_000;
const unread = [];

function pruneUnread(now) {
    const cutoff = (now || Date.now()) - UNREAD_MS;
    while (unread.length && (unread.length > UNREAD_MAX || unread[0].at < cutoff)) unread.shift();
}

/**
 * @returns {{entry, fresh}} fresh = first time this message text was seen.
 */
function noteUnread(sms, rule, now) {
    now = now || Date.now();
    const message = str(sms.message).slice(0, MAX_MESSAGE);
    const k = otp.ruleKey(rule);
    const same = unread.find(u => otp.ruleKey(u.rule) === k && u.message === message);
    if (same) {
        same.at = now; same.count++;
        unread.splice(unread.indexOf(same), 1); unread.push(same);
        return { entry: same, fresh: false };
    }
    const entry = { ref: crypto.randomBytes(6).toString('hex'), rule: String(rule), sender: str(sms.sender),
                    recipient: str(sms.recipient), message, at: now, count: 1, smsId: sms.id || null };
    unread.push(entry);
    pruneUnread(now);
    return { entry, fresh: true };
}

function listUnread(now) { pruneUnread(now); return unread.map(u => Object.assign({}, u)).reverse(); }

function dismissUnread(ref) {
    const i = unread.findIndex(u => u.ref === ref);
    if (i < 0) return false;
    unread.splice(i, 1);
    return true;
}

/** Drop the unread messages these filters now read. @returns how many. */
function resolveUnread(filters) {
    let n = 0;
    for (let i = unread.length - 1; i >= 0; i--) {
        const u = unread[i];
        if (otp.extractDetailed(u.message, u.sender, u.recipient, filters).code) { unread.splice(i, 1); n++; }
    }
    return n;
}

function _reset() { unread.length = 0; }

module.exports = {
    analyze, sanitizeExamples, addExample, removeExample, brokenExamples, fingerprint,
    noteUnread, listUnread, dismissUnread, resolveUnread, codeOfPart, locate, captureFor,
    EXAMPLES_PER_RULE, MAX_MESSAGE, _reset
};
