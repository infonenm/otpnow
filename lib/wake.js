'use strict';
/**
 * wake.js — "did the phones answer?" for the Test button (server 4.41.3).
 *
 * Riad: Test should also wake a phone in deep sleep and get it working. The
 * waking is the phone's side (app 4.37.0: a high-priority push → foreground
 * service → topics, alarms, queue, registration, settings, outbox). This module
 * is the dashboard's side: which phones a Test was aimed at, and which of them
 * answered, so a sleeping or dead phone is visible instead of silently quiet.
 *
 * Two kinds of answer, either is enough:
 *   - 'woke'  the phone reports the Test's timestamp on its settings poll
 *             (wokeTs, app 4.37.0+) — works with forwarding OFF too;
 *   - 'test'  its test message reached /sms (any app version).
 *
 * In memory only, like lastSeen: a Test is something you watch for two
 * minutes. A restart loses the panel, never a message.
 */

const store = require('./store');
const users = store.users;

/**
 * FCM keeps a Test 120 s and the app runs one from the poll only while it is
 * under 120 s old (RemoteCommands.ONE_SHOT_MAX_AGE_MS) — later, it CANNOT
 * answer. 15 s margin for the network (review, 4.41.3: was 150 s, which marked
 * phones "no answer" for a window in which they were not allowed to answer).
 */
const ANSWER_WINDOW_MS = 135_000;
const DAY_MS = 86_400_000;

/** One run per person who pressed Test — the newest replaces the older. */
const runs = new Map();           // pressedBy userId -> run

let broadcastFn = () => {};
function setBroadcast(fn) { broadcastFn = typeof fn === 'function' ? fn : () => {}; }

function deviceLabel(d) {
    return String(d.name || d.model || d.id);
}

/**
 * The phones a Test reaches: every listed (not removed, not hidden as gone
 * for a week) phone for "all", or the phones owned by one user.
 */
function targetedDevices(target, now) {
    const hideMs = (users.HIDE_AFTER_DAYS || 7) * DAY_MS;
    return users.allDevices().filter(d => {
        if (!d || !d.id || users.isRevoked(d.id)) return false;
        const last = Math.max(d.lastSeen || 0, d.seenAt || 0, d.createdAt || 0);
        if (now - last > hideMs) return false;
        return target ? users.ownerOf(d.id) === target : true;
    });
}

/**
 * A Test was just sent.
 * @param {number} ts      the Test's timestamp (what the phones report back)
 * @param {string|null} target  user id, or null for all phones
 * @param {object} session who pressed it
 */
function start(ts, target, session, now) {
    now = now || Date.now();
    const run = {
        ts: Number(ts) || now, target: target || null, startedAt: now,
        pressedBy: session.userId,
        devices: targetedDevices(target, now).map(d => ({
            id: d.id, name: deviceLabel(d), owner: users.ownerOf(d.id),
            appVersion: d.appVersion || '', lastSeen: d.lastSeen || 0,
            answeredAt: 0, via: ''
        }))
    };
    runs.set(session.userId, run);
    return publicRun(run, now);
}

function publicRun(run, now) {
    now = now || Date.now();
    return {
        ts: run.ts, target: run.target, startedAt: run.startedAt, pressedBy: run.pressedBy,
        // false when the server has users (and so its phone list) switched off:
        // the panel must not say "no phones" about phones it cannot list.
        listed: store.usersEnabled(),
        deadline: run.startedAt + ANSWER_WINDOW_MS,
        over: now > run.startedAt + ANSWER_WINDOW_MS,
        devices: run.devices.map(x => {
            const d = users.getDevice(x.id) || {};
            return Object.assign({}, x, {
                lastSeen: d.lastSeen || x.lastSeen || 0,
                appVersion: d.appVersion || x.appVersion || ''
            });
        })
    };
}

/** The caller's newest run, or null. Nobody sees another person's run. */
function status(session, now) {
    const run = runs.get(session.userId);
    return run ? publicRun(run, now) : null;
}

/**
 * A phone answered.
 * @param {'woke'|'test'} via
 * @param {number} [wokeTs] for 'woke': the Test timestamp the phone reports
 */
function noteAnswer(deviceId, via, wokeTs, now) {
    now = now || Date.now();
    deviceId = String(deviceId || '');
    if (!deviceId) return 0;
    let n = 0;
    for (const run of runs.values()) {
        if (now - run.startedAt > ANSWER_WINDOW_MS + 60_000) continue;   // long over
        // A woke report must be for THIS Test (or a newer one), never an old one.
        if (via === 'woke' && !(Number(wokeTs) >= run.ts)) continue;
        if (via === 'test' && now < run.startedAt) continue;
        const x = run.devices.find(r => r.id === deviceId);
        if (!x || x.answeredAt) continue;
        x.answeredAt = now;
        x.via = via;
        n++;
        broadcastFn('wake_update', publicRun(run, now), { userId: run.pressedBy });
    }
    return n;
}

function _reset() { runs.clear(); }

module.exports = { start, status, noteAnswer, setBroadcast, targetedDevices, ANSWER_WINDOW_MS, _reset };
