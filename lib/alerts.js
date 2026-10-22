'use strict';
/**
 * alerts.js — push alerts for the admin's phone (server 4.42.0, OTP Master).
 *
 * Three kinds, each on its OWN FCM topic so OTP Master can mute any of them by
 * simply leaving that topic (Riad: "admin can stop getting the notification"):
 *
 *   offline     a phone that was checking in went quiet for OFFLINE_AFTER_MS (20 min),
 *               and later "back online" for one that was reported quiet. A
 *               phone that NAPS (goes quiet, comes back by itself) is given its
 *               own longest recent nap + NAP_MARGIN_MS before the next report,
 *               up to NAP_CAP_MS — server 4.42.1, see toleranceOf()
 *   sms         dashboard SMS that failed / were not delivered / may not have
 *               gone out — batched, so a bulk send that fails is ONE alert
 *   keeponline  Keep online has been on for KEEP_ONLINE_REMIND_MS (and again
 *               every KEEP_ONLINE_REMIND_MS) — batteries
 *   unread      an SMS that a sender rule claimed had no code it could read —
 *               usually the sender changed its format (server 4.43.0). Tapping
 *               it opens Teach with that message ready. Once per rule per
 *               UNREAD_COOLDOWN_MS, so one format change is one alert.
 *
 * WHAT A PUSH CARRIES. FCM topics are not access-controlled: any app instance
 * in the Firebase project could subscribe. So an alert carries only what an
 * operator needs at a glance — a phone's name and owner, a count, a reason —
 * never a phone number, a message text or an OTP. The detail is in the app,
 * behind the admin login.
 *
 * In memory: a restart loses the "who was online" picture and re-learns it
 * silently from the next polls — it never alerts about the restart itself.
 */

const store      = require('./store');
const fcm        = require('./fcm');
const keepOnline = require('./keeponline');
const smserrors  = require('./smserrors');
const move       = require('./move');

const users = store.users;

const TOPICS = {
    offline:    'admin_alert_offline',
    sms:        'admin_alert_sms',
    keeponline: 'admin_alert_keeponline',
    unread:     'admin_alert_unread'
};

// Quiet this long = offline. 20 min by default: a sleeping phone in Doze checks
// in from its allow-while-idle alarm, which Android fires at most about every
// 9 min — 10 min sat on that edge and would flap overnight (review, 4.42.0).
// ALERT_OFFLINE_MINUTES overrides it (5–240).
const OFFLINE_AFTER_MS = Math.min(240, Math.max(5, Number(process.env.ALERT_OFFLINE_MINUTES) || 20)) * 60_000;
const OFFLINE_COOLDOWN_MS   = 30 * 60_000;     // per phone, so a flapping phone is not a stream
const CHECK_EVERY_MS        = 60_000;
const SMS_BATCH_MS          = 30_000;
const KEEP_ONLINE_REMIND_MS = 3 * 3600_000;
const DAY_MS                = 86_400_000;

/*
 * NAPS (server 4.42.1). Riad: the alert list filled with "offline" / "back
 * online" pairs. A phone the OS puts to sleep (Doze, an OEM battery manager)
 * checks in only at its maintenance windows, so it goes quiet for 20–60 min
 * and comes back BY ITSELF, night after night — each time a pair of pushes
 * that tells the admin nothing.
 *
 * So every quiet spell that ended by itself is remembered for a day, and that
 * phone is reported only once it has been quiet longer than its longest
 * recent nap + NAP_MARGIN_MS. The first nap is still reported (nothing has
 * been learned yet); the ones like it after that are not. A spell longer
 * than NAP_CAP_MS is an outage, not a nap, and teaches nothing — so a phone
 * that is really down is always reported within NAP_CAP_MS + margin at most.
 */
const NAP_MARGIN_MS = 10 * 60_000;
const NAP_CAP_MS    = 2 * 3600_000;
/**
 * A spell that WAS reported as offline is learned only up to this long. A
 * 110-min dead battery is an outage, not a nap: learned, it let a real outage
 * the next day go unreported for ~2 h (audit, 4.42.1). A 30-min spell is the
 * kind of nap the learning exists for, reported or not.
 */
const ALERTED_NAP_MAX_MS = 60 * 60_000;
const NAP_MEMORY_MS = DAY_MS;

/**
 * deviceId -> { online, seenOnline, alertedOffline, lastAlertAt }
 * seenOnline: it has checked in since this server started — only such a phone
 * can be reported offline (a restart never alerts about phones already quiet).
 */
const phones = new Map();
let smsBatch = [];
let smsTimer = null;
let lastKeepOnlineReminder = 0;
let lastKeepOnlineSince = 0;

/**
 * What was sent, newest last — the "Sent recently" list in OTP Master.
 * Bounded twice: at most RECENT_MAX, and nothing older than RECENT_MS (server
 * 4.42.1). With only the count, a server that stayed up held the same 50 for
 * days ("the list keeps growing"); the admin can also clear it.
 */
const sent = [];
const RECENT_MAX = 50;
const RECENT_MS  = DAY_MS;

function prune(now) {
    const cutoff = (now || Date.now()) - RECENT_MS;
    while (sent.length && (sent.length > RECENT_MAX || sent[0].at < cutoff)) sent.shift();
}

/**
 * @param device for the app's list only (one row per phone) — never part of the
 *               push itself, which carries just the words.
 */
function push(kind, title, body, now, device) {
    const data = { kind, title: redact(title).slice(0, 120), body: redact(body).slice(0, 400) };
    sent.push(Object.assign({ at: now || Date.now() }, data, device ? { device } : {}));
    prune(now);
    console.log(`[alerts] ${kind}: ${data.title} — ${data.body}`);
    return fcm.send('admin_alert', now || Date.now(), TOPICS[kind], data);
}

function labelOf(d) {
    const name = String(d.name || d.model || d.id);
    const owner = users.ownerOf(d.id);
    return owner && owner !== users.ADMIN_ID ? `${name} (${owner})` : name;
}

/**
 * The phones worth watching: listed, not removed, not gone for a week. With
 * users switched off there is no list, and nothing to watch.
 */
function watched(now) {
    if (!store.usersEnabled()) return [];
    const hideMs = (users.HIDE_AFTER_DAYS || 7) * DAY_MS;
    return users.allDevices().filter(d => {
        if (!d || !d.id || users.isRevoked(d.id)) return false;
        // Being moved to another server: going quiet HERE is the move working.
        if (move.covers(d.id, id => users.ownerOf(id))) return false;
        const last = Math.max(d.lastSeen || 0, d.seenAt || 0, d.createdAt || 0);
        return now - last <= hideMs;
    });
}

/**
 * How long THIS phone may be quiet before it is reported: the base threshold,
 * or its longest nap of the last day + margin, never above NAP_CAP_MS.
 */
function toleranceOf(st, now) {
    let longest = 0;
    st.naps = st.naps.filter(n => now - n.at <= NAP_MEMORY_MS);
    for (const n of st.naps) if (n.ms > longest) longest = n.ms;
    if (!longest) return OFFLINE_AFTER_MS;
    return Math.max(OFFLINE_AFTER_MS, Math.min(NAP_CAP_MS, longest + NAP_MARGIN_MS));
}

/** One pass: phones that went quiet or came back, and the Keep online reminder. */
function check(now) {
    now = now || Date.now();
    const seen = new Set();
    for (const d of watched(now)) {
        seen.add(d.id);
        const online = !!d.lastSeen && now - d.lastSeen <= OFFLINE_AFTER_MS;
        const st = phones.get(d.id);
        if (!st) {
            // First sight since this server started: learn, never alert.
            phones.set(d.id, { online, seenOnline: online, alertedOffline: false, lastAlertAt: 0,
                               quietSince: online ? 0 : (d.lastSeen || 0), naps: [] });
            continue;
        }
        if (!online) {
            if (st.online) st.quietSince = d.lastSeen || now;
            st.online = false;
            const tolerance = toleranceOf(st, now);
            if (now - (d.lastSeen || 0) < tolerance) continue;      // a nap like its others
            // Not only on the online→offline EDGE: a phone that went quiet
            // inside the cooldown is reported once the cooldown ends, if it is
            // still quiet. (On the edge alone, a phone that died 12 min after
            // "back online" was never reported — the last word stayed "back
            // online". Review, 4.42.0.)
            if (st.seenOnline && !st.alertedOffline && now - st.lastAlertAt >= OFFLINE_COOLDOWN_MS) {
                const mins = Math.round((now - d.lastSeen) / 60_000);
                // The longest nap itself (not tolerance − margin, which the 2 h
                // cap makes smaller than the nap).
                const longestNap = st.naps.reduce((m, n) => Math.max(m, n.ms), 0);
                const napNote = tolerance > OFFLINE_AFTER_MS && longestNap > 0
                    ? ` It usually naps up to ${Math.round(longestNap / 60_000)} min, so this is longer.`
                    : '';
                push('offline', `📴 ${labelOf(d)} is offline`,
                     `No check-in for ${mins} min.${napNote} It may be switched off, out of internet, `
                     + 'or the app was stopped.', now, d.id);
                st.alertedOffline = true;
                st.lastAlertAt = now;
            }
        } else {
            if (!st.online) {
                // A quiet spell that ended by itself. Learned only if this
                // phone had been seen online (so the spell has a known start)
                // and it was short enough to be a nap rather than an outage.
                const spell = st.quietSince ? (d.lastSeen || now) - st.quietSince : 0;
                const learnable = spell > 0 && spell <= (st.alertedOffline ? ALERTED_NAP_MAX_MS : NAP_CAP_MS);
                if (st.seenOnline && learnable) st.naps.push({ at: now, ms: spell });
                st.online = true;
                st.quietSince = 0;
                if (st.alertedOffline) {
                    push('offline', `✅ ${labelOf(d)} is back online`, 'It is checking in again.', now, d.id);
                    st.alertedOffline = false;
                }
            }
            st.seenOnline = true;
        }
    }
    for (const id of Array.from(phones.keys())) if (!seen.has(id)) phones.delete(id);

    // Keep online left on.
    const ko = keepOnline.status(now);
    if (!ko.on) {
        lastKeepOnlineSince = 0;
        lastKeepOnlineReminder = 0;
    } else {
        if (ko.since !== lastKeepOnlineSince) {          // a new ON: start its clock
            lastKeepOnlineSince = ko.since;
            lastKeepOnlineReminder = ko.since;
        }
        if (now - lastKeepOnlineReminder >= KEEP_ONLINE_REMIND_MS) {
            const hours = Math.floor((now - ko.since) / 3600_000);
            push('keeponline', '🔋 Keep online is still on',
                 `${ko.target ? ko.target + "'s phones have" : 'All phones have'} been kept awake for `
                 + `${hours} h. Turn it off when you are done, to save their batteries.`, now);
            lastKeepOnlineReminder = now;
        }
    }
}

/**
 * A dashboard SMS ended badly. Batched: the first failure starts a 30 s window
 * and everything failing inside it is one alert.
 */
function smsFailed(job) {
    if (!job) return;
    smsBatch.push({
        status: job.status,
        device: job.fromDeviceName || job.fromDeviceId || 'a phone',
        slot: job.fromSlot,
        reason: reasonOf(job)
    });
    if (!smsTimer) {
        smsTimer = setTimeout(() => { smsTimer = null; flushSms(); }, SMS_BATCH_MS);
        if (typeof smsTimer.unref === 'function') smsTimer.unref();
    }
}

const STATUS_WORDS = {
    failed:      'sending failed on the phone',
    undelivered: 'the operator did not deliver it',
    unknown:     'it may or may not have gone out — check the phone\'s Sent messages',
    expired:     'it expired before the phone sent it'
};

/**
 * Why, in words fit for a push. ONLY a recognised phone/operator code is
 * translated; any other stored error is free text from the server or the phone
 * and may hold a phone number ("that SIM is no longer 017…") — it never leaves
 * in a push (review, 4.42.0). The full error is in the Outbox, behind the login.
 */
function reasonOf(job) {
    const raw = String(job.error == null ? '' : job.error).trim();
    const words = raw ? smserrors.describe(raw) : '';
    const recognised = words && words !== raw;
    return redact(recognised ? words : (STATUS_WORDS[job.status] || 'it was not sent'));
}

/**
 * Belt and braces: nothing that could be a phone number ever goes out. A device
 * name is free text an admin may type, so: 7+ digits of ANY script (Bengali
 * ০-৯, fullwidth …), with up to 3 non-alphanumeric characters between them
 * ("017.1111.1111", "(017) 1111 1111", "01711_111111", "+880 1711-111111").
 * Short numbers ("code 112", "11 min", "SIM 1") are left alone.
 */
const NUMBERISH = /\+?\p{Nd}(?:[^\p{L}\p{Nd}]{0,3}\p{Nd}){6,}/gu;
function redact(s) { return String(s).replace(NUMBERISH, '…'); }

/** Send the batch now. Returns the send (shutdown awaits it). */
function flushSms(now) {
    if (smsTimer) { clearTimeout(smsTimer); smsTimer = null; }
    const batch = smsBatch;
    smsBatch = [];
    if (!batch.length) return Promise.resolve();
    const first = batch[0];
    const where = `${first.device}${first.slot ? ' · SIM ' + first.slot : ''}`;
    const title = batch.length === 1 ? '⚠️ An SMS was not sent' : `⚠️ ${batch.length} SMS were not sent`;
    const body = batch.length === 1
        ? `${where}: ${first.reason}`
        : `${where}: ${first.reason}` + (batch.length > 1 ? ` (+${batch.length - 1} more — see Outbox)` : '');
    return push('sms', title, body, now);
}

let timer = null;
function start() {
    if (timer) return;
    timer = setInterval(() => { try { check(); } catch (e) { console.error('[alerts]', e); } }, CHECK_EVERY_MS);
    if (typeof timer.unref === 'function') timer.unref();
}

function _reset() {
    phones.clear(); smsBatch = []; sent.length = 0; unreadLast.clear();
    if (smsTimer) { clearTimeout(smsTimer); smsTimer = null; }
    lastKeepOnlineReminder = 0; lastKeepOnlineSince = 0;
}

/**
 * An SMS a sender rule could not read. The push names the RULE only — never
 * the message or the sender's number (redact() runs on it like every push);
 * the message itself is in Teach, behind the admin login.
 */
const UNREAD_COOLDOWN_MS = 15 * 60_000;
const unreadLast = new Map();        // rule key -> { at, missed }
function smsUnread(rule, now) {
    now = now || Date.now();
    const key = String(rule || '').toUpperCase().replace(/[\s_-]/g, '');
    const st = unreadLast.get(key);
    if (st && now - st.at < UNREAD_COOLDOWN_MS) { st.missed++; return null; }
    const more = st && st.missed ? ` (${st.missed} more since the last alert)` : '';
    unreadLast.set(key, { at: now, missed: 0 });
    return push('unread', `🧩 ${rule} SMS not read`,
        `A message from ${rule} had no code any filter could read${more}. Its format may have changed — `
        + 'open Teach, check the message and paste the code part.', now);
}

/** The alerts of the last 24 h (at most 50), newest last — copies, so callers cannot change them. */
function recent(now) { prune(now); return sent.map(a => Object.assign({}, a)); }

/** Empty the list (the admin's Clear). Alerts already pushed stay on the phones. */
function clearRecent() { const n = sent.length; sent.length = 0; return n; }

module.exports = {
    start, check, smsFailed, smsUnread, flushSms, recent, clearRecent, TOPICS, RECENT_MAX, RECENT_MS,
    UNREAD_COOLDOWN_MS,
    NAP_MARGIN_MS, NAP_CAP_MS,
    OFFLINE_AFTER_MS, OFFLINE_COOLDOWN_MS, KEEP_ONLINE_REMIND_MS, SMS_BATCH_MS,
    reasonOf, redact, _sent: sent, _reset, _toleranceOf: toleranceOf
};
