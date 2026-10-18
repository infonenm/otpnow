'use strict';
/**
 * keeponline.js — "Keep online": phones stay awake until the admin turns it
 * off (server 4.41.3 / app 4.37.0, Riad: "I will turn the button off when my
 * work is done").
 *
 * The switch lives HERE; the staying-awake is the phone's. Every settings poll
 * tells each phone { on, ts } and the phone holds a wake lock on a LEASE of a
 * few minutes, renewed by each poll that still says on. So:
 *   - turning it off reaches a phone within one poll (and at once by push);
 *   - a phone that loses the server — or a server that restarts and forgets —
 *     falls back to normal sleep by itself when the lease runs out. A switch
 *     nobody can see can never drain a battery for days.
 *
 * In memory, deliberately: a redeploy turns Keep online OFF (the phones'
 * leases run out). The safe direction — press it again if still needed.
 *
 * Android's rule, which no code can change: while a phone is in Doze, its
 * wake locks are honoured only if GetOTP's battery setting is "Unrestricted"
 * (not optimised). Each phone reports that, and the dashboard names the ones
 * that cannot stay awake.
 */

const store = require('./store');
const users = store.users;

let state = { on: false, target: null, since: 0, ts: 0, by: '' };
/** deviceId -> { holding, exempt, at } as each phone last reported. */
const reports = new Map();

let broadcastFn = () => {};
function setBroadcast(fn) { broadcastFn = typeof fn === 'function' ? fn : () => {}; }

/** Is this phone covered by the switch as it stands? */
function covers(deviceId) {
    if (!state.on) return false;
    // A removed phone is never kept awake (review, 4.41.3).
    if (users.isRevoked(deviceId)) return false;
    return !state.target || users.ownerOf(deviceId) === state.target;
}

/**
 * What a phone's poll is told. Omitted (null) until the switch has been used
 * since this server started: a phone then keeps its own lease, which runs out.
 */
function forDevice(deviceId) {
    if (!state.ts) return null;
    return { on: covers(deviceId), ts: state.ts };
}

/**
 * Turn it on (for all phones or one user's) or off.
 * @returns {{ok:true, status:object, topicTargets:Array<(string|null)>}}
 */
function set(on, target, session, now) {
    now = now || Date.now();
    // ts strictly increases, so a phone can always tell newer from older.
    const ts = Math.max(now, state.ts + 1);
    // Off is sent where the last ON went, so exactly those phones hear it. A
    // CHANGE of target while on tells both groups: the phones that drop out
    // hear it at once, not on their next poll (review, 4.41.3).
    const topics = [];
    if (on) {
        topics.push(target || null);
        if (state.on && (state.target || null) !== (target || null)) topics.push(state.target || null);
    } else {
        topics.push(state.target || null);
    }
    state = on
        ? { on: true, target: target || null, since: now, ts, by: session.userId }
        : { on: false, target: null, since: 0, ts, by: session.userId };
    console.log(`[keep-online] ${on ? 'ON for ' + (target || 'all phones') : 'OFF'} by ${session.userId}`);
    const st = status(now);
    broadcastFn('keep_online', st, { adminOnly: true });
    // null (all phones) covers every topic: send it alone.
    return { ok: true, status: st, topicTargets: topics.includes(null) ? [null] : Array.from(new Set(topics)) };
}

/**
 * A phone's poll report. Changes are broadcast so the panel updates live;
 * the steady state (same answer every 30 s) is silent.
 */
function noteReport(deviceId, holding, exempt, now) {
    now = now || Date.now();
    deviceId = String(deviceId || '');
    // Only phones this server knows: the map is keyed by what a caller sends,
    // and must not grow with made-up ids (review, 4.41.3).
    if (!deviceId || !users.getDevice(deviceId)) return;
    const before = reports.get(deviceId);
    const next = { holding: !!holding, exempt: !!exempt, at: now };
    reports.set(deviceId, next);
    pruneReports(now);
    const changed = !before || before.holding !== next.holding || before.exempt !== next.exempt;
    // The first report since this ON counts as an answer to it even when it
    // says the same as before (review, 4.41.3: the panel showed "waiting" for
    // up to a minute after a target change).
    const firstForThisOn = state.on && (!before || before.at < state.since);
    if (changed || firstForThisOn) {
        if (state.on || (before && before.holding)) broadcastFn('keep_online', status(now), { adminOnly: true });
    }
}

/** Reports older than a lease are worthless; at most every few minutes, drop them. */
const REPORT_TTL_MS = 15 * 60_000;
let lastReportPrune = 0;
function pruneReports(now) {
    if (now - lastReportPrune < 60_000) return;
    lastReportPrune = now;
    for (const [id, r] of reports) if (now - r.at > REPORT_TTL_MS) reports.delete(id);
}

const DAY_MS = 86_400_000;

/** The switch, and every listed phone it covers with what each last said. */
function status(now) {
    now = now || Date.now();
    const hideMs = (users.HIDE_AFTER_DAYS || 7) * DAY_MS;
    const devices = state.on ? users.allDevices().filter(d => {
        if (!d || !d.id || users.isRevoked(d.id)) return false;
        const last = Math.max(d.lastSeen || 0, d.seenAt || 0, d.createdAt || 0);
        return now - last <= hideMs && covers(d.id);
    }).map(d => {
        const r = reports.get(d.id);
        // A report from before this ON does not count as holding for it.
        const fresh = r && r.at >= state.since;
        return {
            id: d.id, name: String(d.name || d.model || d.id), owner: users.ownerOf(d.id),
            appVersion: d.appVersion || '', lastSeen: d.lastSeen || 0,
            holding: !!(fresh && r.holding), exempt: r ? r.exempt : null,
            reportedAt: r ? r.at : 0
        };
    }) : [];
    return { on: state.on, target: state.target, since: state.since, ts: state.ts, by: state.by,
             serverTime: now, listed: store.usersEnabled(), devices };
}

function _reset() { state = { on: false, target: null, since: 0, ts: 0, by: '' }; reports.clear(); }

module.exports = { set, forDevice, noteReport, status, covers, setBroadcast, _reset };
