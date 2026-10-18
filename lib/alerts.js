'use strict';
/**
 * alerts.js — push alerts for the admin's phone (server 4.42.0, OTP Master).
 *
 * Three kinds, each on its OWN FCM topic so OTP Master can mute any of them by
 * simply leaving that topic (Riad: "admin can stop getting the notification"):
 *
 *   offline     a phone that was checking in went quiet for OFFLINE_AFTER_MS (20 min),
 *               and later "back online" for one that was reported quiet
 *   sms         dashboard SMS that failed / were not delivered / may not have
 *               gone out — batched, so a bulk send that fails is ONE alert
 *   keeponline  Keep online has been on for KEEP_ONLINE_REMIND_MS (and again
 *               every KEEP_ONLINE_REMIND_MS) — batteries
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
    keeponline: 'admin_alert_keeponline'
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

/** Exposed for tests: everything sent, newest last (bounded). */
const sent = [];

function push(kind, title, body, now) {
    const data = { kind, title: redact(title).slice(0, 120), body: redact(body).slice(0, 400) };
    sent.push(Object.assign({ at: now || Date.now() }, data));
    if (sent.length > 50) sent.shift();
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
            phones.set(d.id, { online, seenOnline: online, alertedOffline: false, lastAlertAt: 0 });
            continue;
        }
        if (!online) {
            st.online = false;
            // Not only on the online→offline EDGE: a phone that went quiet
            // inside the cooldown is reported once the cooldown ends, if it is
            // still quiet. (On the edge alone, a phone that died 12 min after
            // "back online" was never reported — the last word stayed "back
            // online". Review, 4.42.0.)
            if (st.seenOnline && !st.alertedOffline && now - st.lastAlertAt >= OFFLINE_COOLDOWN_MS) {
                const mins = Math.round((now - d.lastSeen) / 60_000);
                push('offline', `📴 ${labelOf(d)} is offline`,
                     `No check-in for ${mins} min. It may be switched off, out of internet, `
                     + 'or the app was stopped.', now);
                st.alertedOffline = true;
                st.lastAlertAt = now;
            }
        } else {
            st.seenOnline = true;
            if (!st.online) {
                st.online = true;
                if (st.alertedOffline) {
                    push('offline', `✅ ${labelOf(d)} is back online`, 'It is checking in again.', now);
                    st.alertedOffline = false;
                }
            }
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
    phones.clear(); smsBatch = []; sent.length = 0;
    if (smsTimer) { clearTimeout(smsTimer); smsTimer = null; }
    lastKeepOnlineReminder = 0; lastKeepOnlineSince = 0;
}

/** The last alerts sent, newest last — copies, so callers cannot change them. */
function recent() { return sent.map(a => Object.assign({}, a)); }

module.exports = {
    start, check, smsFailed, flushSms, recent, TOPICS,
    OFFLINE_AFTER_MS, OFFLINE_COOLDOWN_MS, KEEP_ONLINE_REMIND_MS, SMS_BATCH_MS,
    reasonOf, redact, _sent: sent, _reset
};
