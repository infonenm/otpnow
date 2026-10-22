/**
 * lib/outbox.js — sending real SMS from the dashboard (server 4.41.0).
 *
 * =============================================================================
 * THE SHAPE, AND WHY
 *
 *   dashboard ──POST /api/send──▶ outbox (one JOB per recipient, status queued)
 *                                   │  FCM "send_sms" to device_<id>: a SIGNAL only
 *                                   ▼
 *   phone ──GET /api/send/pull──▶ due jobs, marked dispatched (never handed out twice)
 *   phone: SmsManager on the chosen SIM, part by part
 *   phone ──POST /api/send/report──▶ sending / part_sent / part_failed /
 *                                    part_delivered / part_undelivered / refused
 *
 * The message text NEVER rides on FCM. FCM is a hint that work is waiting; the
 * phone fetches the job with its API key. Same rule as set_username: a stale or
 * misdirected push can make a phone ask, never make it act.
 *
 * NEVER SENT TWICE. A job leaves 'queued' exactly once, when a phone pulls it.
 * If that phone then goes quiet, the job becomes 'unknown' — it is never put
 * back in the queue, because the phone may well have sent it, and a customer
 * receiving the same SMS twice is worse than an operator seeing "check the
 * phone's Sent folder".
 *
 * PACED. Android asks the user to confirm once an app sends more than ~30 SMS
 * in 30 minutes. Each phone is handed at most DEVICE_WINDOW_MAX jobs per
 * DEVICE_WINDOW_MS; the rest wait in the queue and go out as the window frees.
 * One phone's queue never holds up another's.
 *
 * NOTHING HERE IS ON THE OTP PATH. /sms and /get never call into this module;
 * the only link is store.addSms calling noteInternal() for an SMS that is
 * already known to be internal — a Map scan bounded by the recipient.
 * =============================================================================
 */

const crypto    = require('crypto');
const store     = require('./store');
const firestore = require('./firestore');
const fcm       = require('./fcm');
const { canonicalizePhone } = require('./phone');
const smserrors = require('./smserrors');

const users = store.users;

const COLLECTION         = 'getotp_outbox';
const MAX_RECIPIENTS     = 100;
const MAX_PARTS          = 3;
const ONLINE_MS          = 120_000;          // two polls and change
const DEVICE_WINDOW_MS   = 30 * 60_000;
// In SMS PARTS, not messages: Android's own check counts every part of a
// multipart SMS against ~30 per 30 minutes (review finding #5), so 25 two-part
// Bangla messages would be 50 and stop the phone at its own prompt.
const DEVICE_WINDOW_MAX  = 25;
const PULL_BATCH         = 10;
const QUEUE_MAX_AGE_MS   = 6 * 3600_000;     // a paced bulk send can take hours
const SILENT_EXPIRE_MS   = 30 * 60_000;      // phone gone that long: stop waiting
const DISPATCH_TIMEOUT_MS = 15 * 60_000;     // pulled, never reported: 'unknown'
// Pulled but NOTHING heard back — not even "sending" — for this long: the pull
// reply most likely never reached the phone. Re-queued ONCE (review #7); the
// phone's own handled-id list stops a second send if it did get it.
const NO_ACK_REQUEUE_MS  = 3 * 60_000;
const KEEP_IN_MEMORY_MS  = 3 * 86400_000;
const MAX_IN_MEMORY      = 5000;
const FLUSH_DEBOUNCE_MS  = 2000;
const DHAKA_OFFSET_MS    = 6 * 3600_000;     // no daylight saving in Bangladesh

/** Statuses a job never leaves. 'sent' is not here: a delivery report may follow. */
const FINAL = new Set(['delivered', 'failed', 'undelivered', 'cancelled', 'expired', 'unknown']);

const jobs = new Map();          // id -> job

// ─── SMS length: the same rule the dashboard shows and the phone enforces ───

const GSM_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?'
    + '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXT   = '^{}\\[~]|€\f';

/**
 * How many SMS parts this text costs. GSM-7 when every character is in the
 * GSM alphabet (extension characters count twice), otherwise UCS-2 — which is
 * what any Bangla text is. 160/70 for one part, 153/67 per part beyond that.
 */
function smsParts(text) {
    text = String(text == null ? '' : text);
    let gsm = true, units = 0;
    for (const ch of text) {
        if (GSM_BASIC.includes(ch)) units += 1;
        else if (GSM_EXT.includes(ch)) units += 2;
        else { gsm = false; break; }
    }
    if (!gsm) units = text.length;           // UTF-16 code units, as UCS-2 counts them
    const single = gsm ? 160 : 70, multi = gsm ? 153 : 67;
    const parts = units === 0 ? 0 : (units <= single ? 1 : Math.ceil(units / multi));
    return { encoding: gsm ? 'gsm' : 'ucs2', units, parts,
             capacity: parts <= 1 ? single : parts * multi };
}

/**
 * A number someone TYPED to send to, as a canonical BD mobile (01XXXXXXXXX), or
 * '' when it is not one. canonicalizePhone strips EVERY non-digit, so
 * "0171111111x" would pass as a real number; for a number that money-costing
 * SMS go to, a stray letter is a typo to show, not to repair. OTP Master
 * checks numbers with the same rule (Phone.kt; test/master-parity.test.js).
 */
function typedMobile(raw) {
    const typed = String(raw == null ? '' : raw).trim().slice(0, 32);
    const c = /[^0-9+\-\s().]/.test(typed) ? '' : canonicalizePhone(typed);
    return /^01[3-9][0-9]{8}$/.test(c) ? c : '';
}

const partsOf = j => Math.max(1, Number(j.parts) || 1);

// ─── Is the queue trustworthy yet? (review #3) ───────────────────
//
// The daily limit and the per-phone pacing are both counted from the jobs in
// memory. Until the boot load has succeeded, memory holds only what this
// process created — so a restart would hand everyone a fresh day and every
// phone a fresh window. Nothing is accepted or handed out until it has.
function ready() { return loadState.ok === true; }

/**
 * Are users and phones loaded? The outbox and the roster are read from
 * Firestore separately at boot. Before the roster lands every phone is unknown,
 * and the sweep expired every queued job as "the phone was removed" — quietly,
 * for good (review, 4.43.1). Until then: no hand-outs, only the age limit.
 */
function identityKnown() { return typeof users.identityReady !== 'function' || users.identityReady(); }

// ─── Who may send, from where, to whom ──────────────────────────

function isAdmin(session) { return session && session.role === 'admin'; }

function ownerName(userId) {
    if (!userId || userId === users.ADMIN_ID) return 'admin';
    const u = users.getUser(userId);
    return u ? u.name : userId;
}

/**
 * Can THIS caller send from THIS SIM right now? One function, used by the
 * options list AND the send itself, so what the dashboard offers and what the
 * server accepts cannot drift apart.
 *
 * @returns {{ok:boolean, reason?:string, device?:object, sim?:object}}
 */
function senderCheck(session, deviceId, slot, now) {
    now = now || Date.now();
    const d = users.getDevice(deviceId);
    if (!d || users.isRevoked(deviceId)) return { ok: false, reason: 'No such phone' };
    const owner = users.ownerOf(d.id);
    if (!isAdmin(session) && owner !== session.userId) {
        return { ok: false, reason: 'Not your phone' };
    }
    slot = Number(slot);
    const sim = (Array.isArray(d.sims) ? d.sims : []).find(s => s.slot === slot);
    if (!sim) {
        return { ok: false, device: d, reason: d.sims ? 'No such SIM slot'
            : 'This phone has not reported its SIMs — update the app to 4.36.0' };
    }
    if (!sim.number) return { ok: false, device: d, sim, reason: 'No number saved for this SIM' };
    if (sim.unconfirmed) {
        return { ok: false, device: d, sim,
                 reason: 'SIM card changed — save its number on the phone first' };
    }
    if (sim.present === false) return { ok: false, device: d, sim, reason: 'No SIM card in this slot' };
    if (d.canSendSms !== true) {
        return { ok: false, device: d, sim, reason: d.canSendSms === false
            ? 'SMS permission not granted on the phone'
            : 'App too old to send — update to 4.36.0' };
    }
    if (!d.lastSeen || now - d.lastSeen > ONLINE_MS) {
        return { ok: false, device: d, sim, reason: 'Phone is offline' };
    }
    return { ok: true, device: d, sim };
}

/** Start of today in Dhaka, as a timestamp. */
function dhakaDayStart(now) {
    now = now || Date.now();
    return Math.floor((now + DHAKA_OFFSET_MS) / 86400_000) * 86400_000 - DHAKA_OFFSET_MS;
}

/**
 * SMS parts this user created today that count against the limit. Cancelled
 * jobs, and jobs that expired without ever reaching a phone, are refunded —
 * neither cost anything.
 */
/**
 * When this account was created. A job older than that belongs to an EARLIER
 * account of the same name (purged, then re-created): the new one must not see
 * its SMS or inherit its daily count (audit, 4.42.1).
 */
function accountSince(userId) {
    const u = userId ? users.getUser(userId) : null;
    return (u && u.createdAt) || 0;
}

function usedToday(userId, now) {
    const from = Math.max(dhakaDayStart(now), accountSince(userId));
    let n = 0;
    for (const j of jobs.values()) {
        // PARTS — what the operator bills, and what the dashboard calls "N SMS".
        if (j.createdBy === userId && j.createdAt >= from && j.status !== 'cancelled'
                && !(j.status === 'expired' && !j.dispatchedAt)) n += partsOf(j);
    }
    return n;
}

function quotaFor(session, now) {
    const pol = users.sendPolicy(session.userId);
    const used = usedToday(session.userId, now);
    return {
        canSend: pol.enabled,
        dailyLimit: pol.dailyLimit,          // null = no limit (admin)
        usedToday: used,
        remaining: pol.dailyLimit == null ? null : Math.max(0, pol.dailyLimit - used)
    };
}

/**
 * Everything the composer needs, scoped to the caller.
 *
 * A user sees ONLY their own phones as senders and only their own SIMs in the
 * directory — the hidden-number privacy the system already has. Typing any
 * number by hand is still allowed (Riad's spec).
 */
function options(session, now) {
    now = now || Date.now();
    const senders = [];
    const offered = new Set();       // numbers already offered as a sender (newest device first)
    const directory = new Map();     // userId -> { userId, name, sims: Map(number -> sim) }
    // Newest contact first, so when an old row of the same phone (an earlier
    // install) still carries the same number, the live device is the one kept.
    const devs = users.allDevices().slice()
        .sort((a, b) => Math.max(b.lastSeen || 0, b.seenAt || 0) - Math.max(a.lastSeen || 0, a.seenAt || 0));
    for (const d of devs) {
        if (users.isRevoked(d.id)) continue;
        const owner = users.ownerOf(d.id);
        const mine = isAdmin(session) || owner === session.userId;
        if (!mine) continue;
        // A phone silent for longer than the dashboard's "inactive" limit is
        // hidden on the Devices page; offering it as a sender (or its numbers as
        // recipients) listed every old install of a phone again (Riad, 4.41.1).
        const last = Math.max(d.lastSeen || 0, d.seenAt || 0) || d.createdAt || 0;
        if (now - last > users.HIDE_AFTER_DAYS * 86_400_000) continue;
        for (const slot of [1, 2]) {
            const c = senderCheck(session, d.id, slot, now);
            const sim = c.sim || (Array.isArray(d.sims) ? d.sims.find(s => s.slot === slot) : null);
            // An EMPTY slot — no number, no card known to be in it — is not a
            // choice anyone can make; listing it doubled every phone.
            const empty = !sim || (!sim.number && !sim.unconfirmed && sim.present !== true);
            // The same number on an older row is the same SIM: one card, the newest.
            const repeat = !!(sim && sim.number && offered.has(sim.number));
            if (sim && sim.number) offered.add(sim.number);
            if (!empty && !repeat) {
                senders.push({
                    deviceId: d.id, deviceName: d.name, ownerId: owner, ownerName: ownerName(owner),
                    slot, number: sim.number || '', ok: c.ok, reason: c.ok ? '' : c.reason,
                    online: !!(d.lastSeen && now - d.lastSeen <= ONLINE_MS),
                    queued: queuedFor(d.id)
                });
            }
            if (sim && sim.number) {
                if (!directory.has(owner)) {
                    directory.set(owner, { userId: owner, name: ownerName(owner), sims: new Map() });
                }
                const bucket = directory.get(owner).sims;
                // One entry per NUMBER: the newest device holding it wins.
                if (!bucket.has(sim.number)) {
                    bucket.set(sim.number, { deviceId: d.id, deviceName: d.name, slot,
                                             number: sim.number, unconfirmed: !!sim.unconfirmed });
                }
            }
        }
    }
    return {
        senders,
        directory: Array.from(directory.values())
            .map(u => ({ userId: u.userId, name: u.name, sims: Array.from(u.sims.values()) }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        quota: quotaFor(session, now),
        limits: { maxRecipients: MAX_RECIPIENTS, maxParts: MAX_PARTS,
                  perPhoneWindow: DEVICE_WINDOW_MAX, windowMinutes: DEVICE_WINDOW_MS / 60_000 }
    };
}

/** A label for a number we know — "rahim · SIM 1" — scoped like the directory. */
function labelFor(number, session) {
    for (const d of users.allDevices()) {
        const owner = users.ownerOf(d.id);
        if (!isAdmin(session) && owner !== session.userId) continue;
        for (const s of (Array.isArray(d.sims) ? d.sims : [])) {
            if (s.number === number) return `${ownerName(owner)} · ${d.name} · SIM ${s.slot}`;
        }
    }
    return '';
}

// ─── Creating jobs ──────────────────────────────────────────────

function newId() { return crypto.randomBytes(8).toString('hex'); }

/**
 * @param {object} body { fromDeviceId, fromSlot, to: [numbers], message }
 * @returns {{ok:boolean, status?:number, error?:string, problems?:string[],
 *            batchId?:string, jobs?:object[], skipped?:object[]}}
 */
function createBatch(session, body, now) {
    now = now || Date.now();
    body = body || {};

    if (!ready()) {
        return { ok: false, status: 503,
                 error: 'The send queue is still loading after a restart — try again in a few seconds.' };
    }
    const quota = quotaFor(session, now);
    if (!quota.canSend) {
        return { ok: false, status: 403,
                 error: 'Sending SMS is not enabled for your account — ask the admin.' };
    }

    const message = typeof body.message === 'string' ? body.message : '';
    if (!message.trim()) return { ok: false, status: 400, error: 'Write a message first' };
    const len = smsParts(message);
    if (len.parts > MAX_PARTS) {
        return { ok: false, status: 400,
                 error: `Too long: ${len.parts} SMS parts (${len.units} characters). `
                      + `The limit is ${MAX_PARTS} parts.` };
    }

    const from = senderCheck(session, String(body.fromDeviceId || ''), body.fromSlot, now);
    if (!from.ok) return { ok: false, status: 400, error: 'Cannot send from that SIM: ' + from.reason };
    // A retry must go out from the SAME number as the original, never from
    // whatever SIM sits in that slot today.
    if (body.expectFromNumber && from.sim.number !== body.expectFromNumber) {
        return { ok: false, status: 409,
                 error: `That slot is now ${from.sim.number || 'empty'}, not ${body.expectFromNumber} `
                      + '— send it again from Send SMS if you still want it.' };
    }

    if (!Array.isArray(body.to) || body.to.length === 0) {
        return { ok: false, status: 400, error: 'Add at least one recipient' };
    }
    if (body.to.length > MAX_RECIPIENTS * 2) {
        return { ok: false, status: 400, error: `At most ${MAX_RECIPIENTS} recipients per send` };
    }

    const problems = [];
    const skipped = [];
    const seen = new Set();
    const numbers = [];
    for (const raw of body.to) {
        const typed = String(raw == null ? '' : raw).trim().slice(0, 32);
        const c = typedMobile(raw);
        if (!c) { problems.push(typed); continue; }
        if (seen.has(c)) continue;
        seen.add(c);
        if (c === from.sim.number) { skipped.push({ number: c, reason: 'the sending SIM itself' }); continue; }
        numbers.push(c);
    }
    if (problems.length) {
        return { ok: false, status: 400, problems,
                 error: 'Not a Bangladeshi mobile number: ' + problems.join(', ') };
    }
    if (!numbers.length) return { ok: false, status: 400, error: 'No recipient left to send to', skipped };
    if (numbers.length > MAX_RECIPIENTS) {
        return { ok: false, status: 400, error: `At most ${MAX_RECIPIENTS} recipients per send` };
    }
    const cost = numbers.length * len.parts;
    if (quota.remaining != null && cost > quota.remaining) {
        return { ok: false, status: 429,
                 error: `Daily limit: ${quota.remaining} of ${quota.dailyLimit} SMS left today `
                      + `— this send needs ${cost} (${numbers.length} recipient(s) × ${len.parts} part(s)).` };
    }

    const d = from.device;
    const owner = users.ownerOf(d.id);
    const batchId = newId();
    const created = numbers.map(to => ({
        id: newId(), batchId, createdAt: now, updatedAt: now,
        createdBy: session.userId, createdByName: ownerName(session.userId),
        fromDeviceId: d.id, fromDeviceName: d.name, fromSlot: from.sim.slot,
        fromNumber: from.sim.number, fromOwner: owner,
        to, toLabel: labelFor(to, session),
        message, encoding: len.encoding, parts: len.parts,
        status: 'queued', error: '',
        dispatchedAt: 0, sentAt: 0, deliveredAt: 0, receivedAt: 0, finishedAt: 0,
        partsSent: [], partsDelivered: [], requeued: 0, acked: false,
        retryOf: typeof body.retryOf === 'string' ? body.retryOf : ''
    }));
    for (const j of created) { jobs.set(j.id, j); markDirty(j); announce(j); }
    prune(now);

    // The signal. Its own topic, so exactly this phone wakes. The 30 s poll
    // carries the same news (sendDue) for a phone FCM cannot reach.
    fcm.send('send_sms', now, 'device_' + d.id);
    console.log(`[outbox] ${session.userId} queued ${created.length} SMS from ${from.sim.number} `
        + `(${d.name} SIM ${from.sim.slot}), ${len.parts} part(s) each`);
    return { ok: true, batchId, jobs: created.map(j => publicJob(j)), skipped };
}

// ─── The phone's side ───────────────────────────────────────────

/** SMS PARTS handed to this phone in the current window. */
function dispatchedInWindow(deviceId, now) {
    let n = 0;
    for (const j of jobs.values()) {
        if (j.fromDeviceId === deviceId && j.dispatchedAt && now - j.dispatchedAt < DEVICE_WINDOW_MS) n += partsOf(j);
    }
    return n;
}

/**
 * May this job STILL go out? Checked when the phone collects it, not only when
 * it was created (review #1): between the two the admin may have switched the
 * user's sending off, deactivated them, reassigned the phone, or removed it —
 * and a queued job must not then go out on someone else's balance.
 * @returns {string|null} why not, or null
 */
function stillAllowedWhy(j) {
    if (users.isRevoked(j.fromDeviceId) || !users.getDevice(j.fromDeviceId)) return 'the phone was removed';
    // NOTE: callers check identityKnown() first — before the roster has
    // loaded every phone looks "removed".
    if (j.createdBy !== users.ADMIN_ID) {
        const pol = users.sendPolicy(j.createdBy);
        if (!pol.enabled) return 'sending was switched off for ' + (j.createdByName || j.createdBy);
        if (users.ownerOf(j.fromDeviceId) !== j.createdBy) return 'the phone now belongs to someone else';
    }
    const d = users.getDevice(j.fromDeviceId);
    const sim = (Array.isArray(d.sims) ? d.sims : []).find(x => x.slot === j.fromSlot);
    if (!sim || sim.number !== j.fromNumber) return 'that SIM is no longer ' + j.fromNumber;
    if (sim.unconfirmed) return 'the SIM card in that slot changed';
    return null;
}

function expireJob(j, why, now) {
    if (j.dispatchedAt) {
        // It was handed to the phone once (then re-queued because nothing was
        // heard). It MAY have gone out — 'expired' would let Retry send it a
        // second time without a warning. 'unknown' warns, and still counts
        // against the daily limit (review, 4.41.3).
        j.status = 'unknown';
        j.error = 'it reached the phone once, then nothing was heard (' + why + ') — check its Sent messages';
    } else {
        j.status = 'expired'; j.error = why;
        // The admin's own action (removed the phone, switched a user's sending
        // off, gave the phone to someone else) is not news to push back to the
        // admin as "SMS not sent" (review, 4.42.0). 'unknown' above still
        // alerts: that one may have gone out.
        if (ADMIN_CAUSED.some(p => String(why).startsWith(p))) j.failureQuiet = true;
    }
    j.finishedAt = now; j.updatedAt = now;
    markDirty(j); announce(j);
}

/** stillAllowedWhy() reasons that only an admin action produces. */
const ADMIN_CAUSED = ['the phone was removed', 'sending was switched off for ', 'the phone now belongs to someone else'];

function queuedFor(deviceId) {
    let n = 0;
    for (const j of jobs.values()) if (j.fromDeviceId === deviceId && j.status === 'queued') n++;
    return n;
}

/** How many the phone could pull right now — for the poll's `sendDue`. */
function dueCount(deviceId, now) {
    now = now || Date.now();
    if (!deviceId || !ready()) return 0;
    const q = queuedFor(deviceId);
    if (!q) return 0;
    return DEVICE_WINDOW_MAX - dispatchedInWindow(deviceId, now) > 0 ? q : 0;
}

/**
 * Hand the phone its next jobs, oldest first, within its pacing budget, and
 * mark them dispatched IN THE SAME STEP — a second pull can never get them.
 */
function pull(deviceId, now) {
    now = now || Date.now();
    if (!ready() || !identityKnown()) return [];
    const d = users.getDevice(deviceId);
    if (!d || users.isRevoked(deviceId)) return [];
    let budget = DEVICE_WINDOW_MAX - dispatchedInWindow(deviceId, now);   // in parts
    if (budget <= 0) return [];
    const queued = Array.from(jobs.values())
        .filter(j => j.fromDeviceId === deviceId && j.status === 'queued')
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    const due = [];
    for (const j of queued) {
        if (due.length >= PULL_BATCH) break;
        const why = stillAllowedWhy(j);
        if (why) { expireJob(j, why, now); continue; }
        if (partsOf(j) > budget) break;        // keep order: the rest wait for the window
        budget -= partsOf(j);
        due.push(j);
    }
    for (const j of due) {
        j.status = 'dispatched';
        j.dispatchedAt = now;
        j.updatedAt = now;
        markDirty(j); announce(j);
    }
    return due.map(j => ({ id: j.id, slot: j.fromSlot, fromNumber: j.fromNumber,
                           to: j.to, message: j.message, parts: j.parts }));
}

const REPORT_EVENTS = new Set(['sending', 'part_sent', 'part_failed', 'part_delivered',
                               'part_undelivered', 'refused', 'already_handled']);

/**
 * A result from the phone. Idempotent per part: the same report twice changes
 * nothing, and a report for a job that is not this phone's is refused.
 */
function report(deviceId, r, now) {
    now = now || Date.now();
    r = r || {};
    // Not loaded yet (just restarted): every job looks unknown, and a 404 made
    // the phone drop its report for good — the SMS then ended "unknown" though
    // it was sent, inviting a Retry that sends it twice. 503 = try again; the
    // phone keeps the report (audit, 4.42.1).
    if (!ready()) return { ok: false, status: 503, error: 'Starting up — try again shortly' };
    const j = jobs.get(String(r.jobId || ''));
    if (!j) return { ok: false, status: 404, error: 'No such job' };
    if (j.fromDeviceId !== String(deviceId || '')) return { ok: false, status: 403, error: 'Not this phone\'s job' };
    if (!REPORT_EVENTS.has(r.event)) return { ok: false, status: 400, error: 'Unknown event' };
    // Cleared from the dashboard: a late report (a delivery receipt hours
    // later) is accepted so the phone stops retrying it, and changes nothing.
    if (j.deleted) return { ok: true, job: { status: j.status } };
    if (j.status === 'cancelled' || j.status === 'expired') return { ok: true, job: publicJob(j) };

    const parts = Math.max(1, Math.min(10, Math.floor(Number(r.parts)) || j.phoneParts || j.parts || 1));
    const part = Math.floor(Number(r.part));
    const okPart = Number.isFinite(part) && part >= 0 && part < parts;
    const err = String(r.error || '').slice(0, 120);
    const before = j.status;
    // Anything the phone says about a job proves it received it. A job
    // re-queued because nothing was heard (NO_ACK_REQUEUE_MS) must leave the
    // queue again the moment its late reports arrive, or it would be pulled
    // a second time.
    j.acked = true;
    const open = j.status === 'dispatched' || j.status === 'sending' || j.status === 'queued';

    switch (r.event) {
        case 'sending':
            if (j.status === 'dispatched' || j.status === 'queued') j.status = 'sending';
            break;
        case 'already_handled':
            // The phone had this job before (its reply to an earlier pull was
            // slow, not lost). It is not sending it again; what happened the
            // first time arrives in that run's own reports.
            if (j.status === 'dispatched') { j.status = 'sending'; }
            break;
        case 'refused':
            // From 'unknown' too: a refusal is proof that nothing was sent.
            if (open || j.status === 'unknown') {
                j.status = 'failed'; j.error = err || 'refused by the phone'; j.finishedAt = now;
            }
            break;
        case 'part_sent':
            if (!okPart) break;
            if (!j.partsSent.includes(part)) j.partsSent.push(part);
            if (j.status !== 'failed' && j.partsSent.length >= parts
                    && (open || j.status === 'unknown')) {
                j.status = 'sent'; j.sentAt = now;
            } else if (j.status === 'dispatched' || j.status === 'queued') {
                j.status = 'sending';
            }
            break;
        case 'part_failed':
            if (!okPart) break;
            if (open || j.status === 'unknown') {
                j.status = 'failed'; j.error = err || 'send failed'; j.finishedAt = now;
            }
            break;
        case 'part_delivered':
            if (!okPart) break;
            if (!j.partsDelivered.includes(part)) j.partsDelivered.push(part);
            if (j.partsDelivered.length >= parts && j.status !== 'failed' && j.status !== 'undelivered') {
                j.status = 'delivered'; j.deliveredAt = now; j.finishedAt = now;
                if (!j.sentAt) j.sentAt = now;
            }
            break;
        case 'part_undelivered':
            if (!okPart) break;
            if (j.status !== 'failed') {
                j.status = 'undelivered'; j.error = err || 'the network could not deliver it';
                j.finishedAt = now;
            }
            break;
    }
    // A re-queued job the phone has now reported on in ANY way is not waiting
    // any more: left 'queued' (a partial part_delivered, already_handled) it
    // was handed out again (review, 4.43.1).
    if (j.status === 'queued') j.status = 'sending';
    // The phone's own part count decides when the job is COMPLETE (its
    // encoding is what actually went out); the server's count stays what the
    // daily limit and pacing charge. Overwriting it let a report refund parts
    // (review, 4.43.1).
    j.phoneParts = parts;
    j.updatedAt = now;
    if (!j.dispatchedAt) j.dispatchedAt = now;
    if (j.status !== before || r.event === 'part_sent' || r.event === 'part_delivered') {
        markDirty(j); announce(j);
    } else {
        markDirty(j);                        // acked changed
    }
    return { ok: true, job: publicJob(j) };
}

// ─── The dashboard's side ───────────────────────────────────────

/** Jobs this caller may see: admin all; a user what they sent AND what was sent from their SIMs. */
function visibleTo(session, j) {
    if (isAdmin(session)) return true;
    if (j.createdBy !== session.userId && j.fromOwner !== session.userId) return false;
    return (j.createdAt || 0) >= accountSince(session.userId);
}

function list(session, limit) {
    limit = Math.max(1, Math.min(500, Number(limit) || 200));
    return Array.from(jobs.values())
        .filter(j => !j.deleted && visibleTo(session, j))
        .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
        .slice(0, limit)
        .map(j => publicJob(j, session));
}

// ─── Clearing (4.41.3) ──────────────────────────────────────────

/** What may be cleared: finished, or 'sent' (left the phone; a receipt may never come). */
const CLEARABLE = new Set([...FINAL, 'sent']);

/**
 * The fields a cleared SMS keeps — and nothing else. No text, no recipient, no
 * sender number, no names. Kept ONLY so clearing cannot hand back the daily
 * limit (usedToday) or a phone's pacing window (dispatchedInWindow), and so a
 * late report is recognised. sweep() deletes the record for good once neither
 * can matter any more (a past Dhaka day, and out of the pacing window).
 */
const TOMBSTONE_KEEP = new Set(['id', 'batchId', 'createdAt', 'createdBy', 'fromDeviceId', 'fromSlot',
    'fromOwner', 'parts', 'encoding', 'status', 'dispatchedAt', 'finishedAt', 'requeued', 'acked']);

function tombstone(j, session, now) {
    for (const k of Object.keys(j)) if (!TOMBSTONE_KEEP.has(k)) delete j[k];
    j.deleted = true;
    j.deletedAt = now;
    j.deletedBy = session.userId;
    j.updatedAt = now;
}

/**
 * Delete finished SMS from the outbox: the text and the number are gone from
 * memory and from Firestore at once. Admin: anything; a user: what they sent.
 * Queued / sending SMS are never cleared — they are still work in progress.
 *
 * @param {{jobIds?:string[], all?:boolean}} what
 * @returns {{ok:true, cleared:number}|{ok:false,status:number,error:string}}
 */
function clear(session, what, now) {
    now = now || Date.now();
    what = what || {};
    if (!ready()) {
        return { ok: false, status: 503, error: 'The send queue is still loading after a restart — try again in a few seconds.' };
    }
    // An empty id list is "none named", never "all of them".
    const ids = Array.isArray(what.jobIds) && what.jobIds.length
        ? new Set(what.jobIds.map(String).slice(0, 1000)) : null;
    if (!what.all && !ids) return { ok: false, status: 400, error: 'Give jobIds or all' };
    let n = 0;
    for (const j of jobs.values()) {
        if (j.deleted) continue;
        if (ids && !ids.has(j.id)) continue;
        if (!isAdmin(session) && j.createdBy !== session.userId) continue;
        if (!CLEARABLE.has(j.status)) continue;
        tombstone(j, session, now);
        markDirty(j);
        announce(j);
        n++;
    }
    if (n) console.log(`[outbox] ${session.userId} cleared ${n} SMS`);
    return { ok: true, cleared: n };
}

/** A tombstone no counter needs any more: before today (Dhaka) and outside the pacing window. */
function tombstoneExpired(j, now) {
    return j.deleted && j.createdAt < dhakaDayStart(now)
        && (!j.dispatchedAt || now - j.dispatchedAt >= DEVICE_WINDOW_MS);
}

/** Final states a person may retry. 'unknown' too — the dashboard warns it may have gone out. */
const RETRYABLE = new Set(['failed', 'undelivered', 'expired', 'unknown']);

/**
 * Retry = a NEW job with the same sender SIM, recipient and text, through
 * createBatch, so every check applies again (permission, daily limit, phone
 * online, SIM still that number). Only the person who sent it, or an admin.
 * One retry per job: a double click, or two admins at once, cannot send twice.
 */
function retry(session, jobId, now) {
    now = now || Date.now();
    if (!ready()) {
        return { ok: false, status: 503, error: 'The send queue is still loading after a restart — try again in a few seconds.' };
    }
    const j = jobs.get(String(jobId || ''));
    if (!j || j.deleted || !visibleTo(session, j)) return { ok: false, status: 404, error: 'No such SMS' };
    if (!isAdmin(session) && j.createdBy !== session.userId) {
        return { ok: false, status: 403, error: 'Only the person who sent it can retry it' };
    }
    if (!RETRYABLE.has(j.status)) {
        return { ok: false, status: 409, error: `Cannot retry an SMS that is ${j.status}` };
    }
    if (j.retriedBy) {
        return { ok: false, status: 409, error: 'Already retried — see the newer SMS in the list' };
    }
    const r = createBatch(session, {
        fromDeviceId: j.fromDeviceId, fromSlot: j.fromSlot, to: [j.to], message: j.message,
        expectFromNumber: j.fromNumber, retryOf: j.id
    }, now);
    if (!r.ok) return r;
    if (!r.jobs || !r.jobs.length) {
        return { ok: false, status: 400, error: 'Nothing to retry', skipped: r.skipped };
    }
    j.retriedBy = r.jobs[0].id;
    j.updatedAt = now;
    markDirty(j); announce(j);
    return r;
}

/** Cancel what has not reached a phone yet. A dispatched job cannot be called back. */
function cancel(session, { jobId, batchId }, now) {
    now = now || Date.now();
    // Not loaded yet: every job looks absent, "cancelled 0" was answered, and
    // the job then loaded and went out (audit, 4.42.1).
    if (!ready()) return -1;
    let n = 0;
    for (const j of jobs.values()) {
        if (jobId && j.id !== jobId) continue;
        if (batchId && j.batchId !== batchId) continue;
        if (!jobId && !batchId) continue;
        if (!isAdmin(session) && j.createdBy !== session.userId) continue;
        if (j.status !== 'queued' || j.deleted) continue;
        if (j.dispatchedAt) {
            // Back in the queue only because nothing was HEARD — it reached the
            // phone once and may well have gone out. 'cancelled' refunded the
            // daily limit and threw away the phone's late reports, so a sent
            // SMS looked unsent and invited a second send (audit, 4.42.1).
            // 'unknown' stops it going out again and keeps the reports.
            j.failureQuiet = true;              // the user's own action — not news to push back
            expireJob(j, 'cancelled after it had reached the phone', now);
            n++;
            continue;
        }
        j.status = 'cancelled'; j.finishedAt = now; j.updatedAt = now;
        markDirty(j); announce(j); n++;
    }
    return n;
}

/**
 * @param {object} [viewer] the session it is for. A recipient label was made
 *        with the CREATOR's view (an admin sees every user's names); shown to
 *        the SIM's owner it would reveal other users' names and phones (review
 *        #8). So a non-admin viewer gets it only for a number of their own.
 */
function publicJob(j, viewer) {
    let toLabel = j.toLabel;
    if (viewer && !isAdmin(viewer) && toLabel && labelFor(j.to, viewer) === '') toLabel = '';
    return {
        id: j.id, batchId: j.batchId, createdAt: j.createdAt, updatedAt: j.updatedAt,
        createdBy: j.createdBy, createdByName: j.createdByName,
        fromDeviceId: j.fromDeviceId, fromDeviceName: j.fromDeviceName, fromSlot: j.fromSlot,
        fromNumber: j.fromNumber, fromOwner: j.fromOwner,
        to: j.to, toLabel, message: j.message, encoding: j.encoding, parts: j.parts,
        status: j.status, error: j.error, errorText: smserrors.describe(j.error),
        retryOf: j.retryOf || '', retriedBy: j.retriedBy || '',
        deleted: !!j.deleted,
        dispatchedAt: j.dispatchedAt, sentAt: j.sentAt, deliveredAt: j.deliveredAt,
        receivedAt: j.receivedAt, finishedAt: j.finishedAt,
        partsSent: (j.partsSent || []).length, partsDelivered: (j.partsDelivered || []).length
    };
}

/** Called once per SMS that ends badly (alerts.smsFailed, 4.42.0). */
let failureHook = null;
function setFailureHook(fn) { failureHook = typeof fn === 'function' ? fn : null; }
const FAILED_STATES = new Set(['failed', 'undelivered', 'unknown', 'expired']);

/** Live update to the people who may see it: the sender, the SIM's owner, admins. */
function announce(j) {
    // Exactly once per SMS: the flag rides on the job (and its saved copy).
    if (failureHook && FAILED_STATES.has(j.status) && !j.deleted && !j.failureAlerted && !j.failureQuiet) {
        j.failureAlerted = true;
        try { failureHook(j); } catch (e) { console.error('[outbox] failure hook:', e && e.message); }
    }
    // The creator's copy carries the label as they made it (admins get this one).
    // A job older than the creator's ACCOUNT belongs to an earlier account of
    // that name (purged, re-created): only admins hear about it — list() hid
    // it, and the live update must too (review of 4.38.4).
    const creatorIsThisAccount = (j.createdAt || 0) >= accountSince(j.createdBy);
    store.broadcast('send_update', publicJob(j),
                    creatorIsThisAccount ? { userId: j.createdBy } : { adminOnly: true });
    if (j.fromOwner && j.fromOwner !== j.createdBy && (j.createdAt || 0) >= accountSince(j.fromOwner)) {
        // Admins received the first one already; this reaches the SIM's owner,
        // with the label scoped to what that owner may see.
        store.broadcast('send_update', publicJob(j, { role: 'user', userId: j.fromOwner }),
                        { userId: j.fromOwner, skipAdmins: true });
    }
}

// ─── The internal-SMS link (store.addSms → here) ───────────────

/**
 * One of our SIMs texted another of ours. If it matches a job we sent, the
 * other phone has RECEIVED it — the strongest confirmation there is.
 */
function noteInternal(fromNumber, toNumber, message, at) {
    let best = null;
    for (const j of jobs.values()) {
        if (j.fromNumber !== fromNumber || j.to !== toNumber || j.receivedAt) continue;
        if (j.message !== message) continue;
        if (!j.dispatchedAt || at - j.dispatchedAt > 3600_000) continue;
        if (!best || j.dispatchedAt > best.dispatchedAt) best = j;
    }
    if (!best) return;
    best.receivedAt = at;
    best.updatedAt = at;
    // Re-queued (dispatched, then nothing heard) counts too: receiving it is
    // proof it went out, and leaving it queued handed it to the phone again
    // (audit, 4.42.1).
    const requeued = best.status === 'queued' && best.dispatchedAt;
    if (best.status === 'sent' || best.status === 'sending' || best.status === 'dispatched'
            || best.status === 'unknown' || requeued) {
        best.status = 'delivered'; best.deliveredAt = at; best.finishedAt = at;
        best.acked = true;
        if (!best.sentAt) best.sentAt = at;
    }
    markDirty(best); announce(best);
}

// ─── Expiry ─────────────────────────────────────────────────────

function sweep(now) {
    now = now || Date.now();
    let n = 0;
    for (const j of Array.from(jobs.values())) {
        if (j.deleted) {
            if (tombstoneExpired(j, now)) { jobs.delete(j.id); dirty.delete(j.id); queueDelete(j.id); }
            continue;
        }
        if (j.status === 'queued') {
            if (!identityKnown()) {
                if (now - j.createdAt > QUEUE_MAX_AGE_MS) { expireJob(j, 'waited more than 6 hours', now); n++; }
                continue;
            }
            const d = users.getDevice(j.fromDeviceId);
            const silent = !d || !d.lastSeen || now - d.lastSeen > SILENT_EXPIRE_MS;
            const why = stillAllowedWhy(j)
                || (now - j.createdAt > QUEUE_MAX_AGE_MS ? 'waited more than 6 hours'
                : (silent && now - j.createdAt > SILENT_EXPIRE_MS ? 'the phone went offline' : null));
            if (why) { expireJob(j, why, now); n++; }
        } else if (j.status === 'dispatched' && !j.acked && !j.requeued
                   && now - j.dispatchedAt > NO_ACK_REQUEUE_MS) {
            // Review #7: the pull's reply most likely never reached the phone.
            // ONCE, and only with nothing heard at all; the phone refuses a job
            // id it already handled, so a slow-but-delivered reply cannot turn
            // into a second SMS.
            j.status = 'queued'; j.requeued = 1; j.updatedAt = now;
            markDirty(j); announce(j); n++;
        } else if ((j.status === 'dispatched' || j.status === 'sending')
                   && now - j.dispatchedAt > DISPATCH_TIMEOUT_MS) {
            // NOT re-queued — it may have gone out. See the header.
            j.status = 'unknown';
            j.error = 'the phone never reported a result — check its Sent messages';
            j.finishedAt = now; j.updatedAt = now;
            markDirty(j); announce(j); n++;
        }
    }
    prune(now);
    retention(now);
    return n;
}

function prune(now) {
    now = now || Date.now();
    if (jobs.size <= MAX_IN_MEMORY && !Array.from(jobs.values()).some(j => now - j.createdAt > KEEP_IN_MEMORY_MS)) return;
    const today = dhakaDayStart(now);
    const keep = Array.from(jobs.values())
        .filter(j => !(FINAL.has(j.status) || j.status === 'sent') || now - j.createdAt <= KEEP_IN_MEMORY_MS)
        .sort((a, b) => b.createdAt - a.createdAt);
    // Unfinished jobs AND everything from today stay: today's count the
    // daily limit, and dropping them would hand the limit back (review #8).
    const active = keep.filter(j => !(FINAL.has(j.status) || j.status === 'sent') || j.createdAt >= today);
    const done = keep.filter(j => (FINAL.has(j.status) || j.status === 'sent') && j.createdAt < today)
                     .slice(0, Math.max(0, MAX_IN_MEMORY - active.length));
    const kept = active.concat(done);
    const keptIds = new Set(kept.map(j => j.id));
    // A cleared SMS leaving memory leaves Firestore too (review, 4.41.3).
    for (const j of jobs.values()) if (!keptIds.has(j.id) && j.deleted) { dirty.delete(j.id); queueDelete(j.id); }
    jobs.clear();
    for (const j of kept) jobs.set(j.id, j);
}

// ─── Firestore retention (4.41.3) ───────────────────────────────
//
// Nothing older than KEEP_IN_MEMORY_MS is loaded, listed or counted, so a
// document older than that is invisible and can never be cleared from the
// dashboard — yet it still held the text and number. Riad: "delete
// permanently". Once an hour, documents older than that window are deleted.
// History of finished SMS is not the outbox's job.
const RETENTION_EVERY_MS = 3600_000;
let lastRetention = 0;
let retentionRunning = false;

function retention(now) {
    now = now || Date.now();
    if (!firestore.isEnabled() || !ready() || retentionRunning) return;
    if (now - lastRetention < RETENTION_EVERY_MS) return;
    lastRetention = now;
    retentionRunning = true;
    firestore.deleteOutboxBefore(COLLECTION, now - KEEP_IN_MEMORY_MS)
        .then(n => { if (n) console.log(`[outbox] Retention: deleted ${n} SMS record(s) older than 3 days`); })
        .catch(e => console.error('[outbox] Retention failed, will retry next hour:', e && e.message))
        .finally(() => { retentionRunning = false; });
}

// ─── Persistence ────────────────────────────────────────────────

const dirty = new Map();          // id -> job (latest object)
const pendingDeletes = new Set(); // ids to delete from Firestore — always AFTER the writes
let flushTimer = null;
let flushing = null;
let loadState = { ok: false, at: 0, error: null, loaded: 0 };

function markDirty(j) {
    if (!firestore.isEnabled()) return;
    dirty.set(j.id, j);
    scheduleFlush();
}

function queueDelete(id) {
    if (!firestore.isEnabled()) return;
    pendingDeletes.add(id);
    scheduleFlush();
}

function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, FLUSH_DEBOUNCE_MS);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

/**
 * Write what is waiting. NEVER STRANDS A CHANGE (review #2): a change made
 * while a write is in flight used to wait for the NEXT unrelated change, so a
 * job's "dispatched" could be missing from Firestore at a redeploy and the job
 * handed out again. Now a write that finishes with more waiting starts the next
 * one itself, and the returned promise covers everything that was waiting when
 * it was called.
 */
async function flush() {
    if (!firestore.isEnabled()) return 0;
    let total = 0;
    for (let guard = 0; guard < 20; guard++) {
        const n = flushing ? await flushing : ((dirty.size || pendingDeletes.size) ? await flushOnce() : null);
        if (n === null) return total;         // nothing in flight, nothing waiting
        if (n < 0) return total;              // failed: the 15 s backoff retries it
        total += n;
    }
    return total;
}

function flushOnce() {
    const batch = Array.from(dirty.values()).map(j => Object.assign({}, j));
    dirty.clear();
    // Deletes go in the SAME pass, after the writes: an id is never written
    // after it was deleted (a write in flight finishes before the next pass).
    const gone = Array.from(pendingDeletes);
    pendingDeletes.clear();
    flushing = (batch.length ? firestore.writeOutbox(COLLECTION, batch) : Promise.resolve())
        .then(() => gone.length ? firestore.deleteOutbox(COLLECTION, gone) : null)
        .then(() => batch.length + gone.length)
        .catch(e => {
            // Put back what failed, unless a newer version arrived meanwhile.
            // A write that DID succeed is written again: harmless, same data.
            const goneSet = new Set(gone);
            for (const j of batch) {
                if (dirty.has(j.id) || goneSet.has(j.id)) continue;
                // Deleted meanwhile (cleared, then swept or pruned): its delete
                // is queued, and the copy in this failed batch may still hold
                // the text — it must never be written again (review, 4.41.3).
                if (!jobs.has(j.id) && pendingDeletes.has(j.id)) continue;
                dirty.set(j.id, jobs.get(j.id) || j);
            }
            for (const id of gone) if (!jobs.has(id)) pendingDeletes.add(id);
            console.error('[outbox] Save failed, will retry:', e && e.message);
            if (!flushTimer) {
                flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 15_000);
                if (typeof flushTimer.unref === 'function') flushTimer.unref();
            }
            return -1;                        // failed: the caller must not retry at once
        })
        .finally(() => {
            flushing = null;
            // Changes that arrived during the write: their timer may already
            // have fired and found the write busy. Schedule them now.
            if ((dirty.size || pendingDeletes.size) && !flushTimer) {
                flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 0);
                if (typeof flushTimer.unref === 'function') flushTimer.unref();
            }
        });
    return flushing;
}

/** Load recent jobs at boot so a redeploy keeps the queue. Retries until it works. */
async function load(attempt) {
    attempt = attempt || 0;
    if (!firestore.isEnabled()) { loadState = { ok: true, at: Date.now(), error: null, loaded: 0 }; return; }
    const r = await firestore.readOutboxSince(COLLECTION, Date.now() - KEEP_IN_MEMORY_MS, MAX_IN_MEMORY);
    if (!r.ok) {
        loadState = { ok: false, at: Date.now(), error: 'read failed', loaded: 0 };
        const wait = [2000, 5000, 15000, 30000, 60000][Math.min(attempt, 4)];
        const t = setTimeout(() => load(attempt + 1), wait);
        if (typeof t.unref === 'function') t.unref();
        return;
    }
    let n = 0;
    for (const j of r.jobs) {
        if (!j || !j.id || jobs.has(j.id)) continue;     // memory is newer
        j.partsSent = Array.isArray(j.partsSent) ? j.partsSent : [];
        j.partsDelivered = Array.isArray(j.partsDelivered) ? j.partsDelivered : [];
        // A job that had already failed when it was saved without the flag
        // predates alerts (server < 4.42.0): it is old news, not an alert —
        // a Retry of it would otherwise announce the old failure (review).
        if (FAILED_STATES.has(j.status) && j.failureAlerted === undefined) j.failureAlerted = true;
        jobs.set(j.id, j);
        n++;
    }
    loadState = { ok: true, at: Date.now(), error: null, loaded: n };
    if (n) console.log(`[outbox] Loaded ${n} job(s) from Firestore`);
}

let sweepTimer = null;
function start() {
    store.setInternalHook(noteInternal);
    load();
    if (!sweepTimer) {
        sweepTimer = setInterval(() => { try { sweep(); } catch (e) { console.error('[outbox] sweep:', e); } }, 30_000);
        if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
    }
}

function stats() {
    const by = {};
    let cleared = 0;
    for (const j of jobs.values()) {
        if (j.deleted) { cleared++; continue; }
        by[j.status] = (by[j.status] || 0) + 1;
    }
    return { inMemory: jobs.size, byStatus: by, cleared,
             pendingSaves: dirty.size + pendingDeletes.size, load: loadState };
}

module.exports = {
    start, load, flush, sweep, stats,
    setFailureHook,
    smsParts, typedMobile, senderCheck, options, createBatch, retry, clear, pull, report, dueCount, list, cancel,
    noteInternal, dhakaDayStart, usedToday,
    RETRYABLE, CLEARABLE, COLLECTION, MAX_RECIPIENTS, MAX_PARTS, DEVICE_WINDOW_MAX, DEVICE_WINDOW_MS,
    ONLINE_MS, DISPATCH_TIMEOUT_MS, SILENT_EXPIRE_MS, QUEUE_MAX_AGE_MS,
    ready,
    _jobs: jobs,
    /** Tests only: pretend the server has just started (nothing loaded yet). */
    _setLoaded(ok) { loadState = Object.assign({}, loadState, { ok: !!ok }); }
};
