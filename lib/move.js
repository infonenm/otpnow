'use strict';
/**
 * move.js — "Push to all phones": moving the fleet to another server (4.42.0).
 *
 * The push (FCM `set_url`) is the fast carrier. This is the one that cannot be
 * missed: the move stays PENDING here and rides every settings poll as
 * `moveTo: {url, ts}` (app 4.38.0+), so a phone that was offline, asleep past
 * the push's lifetime, without Play Services, or that had not yet heard about
 * the new host, still moves the next time it checks in. The app applies a move
 * once per `ts`, so both carriers together never move a phone twice, and a
 * newer move always wins over an older one arriving late.
 *
 * In memory: the old server keeps answering its phones until they are gone —
 * the whole point. A restart of THIS server drops the pending move (phones
 * that already moved are unaffected); push again if that happens mid-move.
 *
 * While a move is pending, the phones it covers are expected to go quiet here:
 * alerts.js does not report them offline (they are on the new server).
 */

let pending = null;   // { url, host, ts, target, by, at }

function hostOf(url) {
    return String(url || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
}

/** Record a move. `target` null = every phone; a user id = that user's phones. */
/** A move nobody stopped is dropped after this long (it would otherwise
 *  silence those phones' offline alerts here forever). */
const MAX_PENDING_MS = 7 * 24 * 3600_000;

function set(url, ts, target, by) {
    pending = { url: String(url), host: hostOf(url), ts: Number(ts) || Date.now(),
                target: target || null, by: by || 'admin', at: Date.now() };
    return pending;
}

function clear() { const was = pending; pending = null; return was; }

/** The move THIS device should apply, or null. `ownerOf` resolves the device's owner. */
function forDevice(deviceId, ownerOf, now) {
    if (pending && (now || Date.now()) - pending.at > MAX_PENDING_MS) {
        console.warn(`[move] the move to ${pending.url} was never stopped — dropped after 7 days`);
        pending = null;
    }
    if (!pending) return null;
    if (pending.target && (!deviceId || ownerOf(deviceId) !== pending.target)) return null;
    return { url: pending.url, ts: pending.ts };
}

/** Is this device part of the pending move (so its silence here is expected)? */
function covers(deviceId, ownerOf) { return !!forDevice(deviceId, ownerOf); }

function status() { return pending ? Object.assign({}, pending) : null; }

/**
 * Before any phone is told to move: is the new server there, and will it take
 * these phones? Calls its /api/settings with THIS server's API key — the exact
 * request every phone will make — so an unreachable host, a sleeping instance
 * that does not wake in time, or a different API_KEY (which would lock every
 * moved phone out: no SMS accepted) is refused here instead of discovered later.
 * Then checks the admin password, so OTP Master can follow without signing in
 * again (a warning only: the phones do not need it).
 *
 * @returns {Promise<{ok:boolean, error?:string, warnings:string[]}>}
 */
async function preflight(url, apiKey, adminPassword, fetchImpl, timeoutMs, selfId) {
    const f = fetchImpl || globalThis.fetch;
    const base = String(url).replace(/\/+$/, '');
    const warnings = [];
    // ONE deadline per call that also covers reading the body — a server that
    // sends headers and then stalls must not hold the request open forever.
    const call = async (path, opts, ms) => {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), ms);
        try {
            const res = await f(base + path, Object.assign({ signal: ctl.signal }, opts));
            let body = null;
            try { body = await res.json(); } catch (e) { if (e && e.name === 'AbortError') throw e; }
            return { status: res.status, ok: res.ok, body };
        } finally { clearTimeout(t); }
    };
    let r;
    try {
        // Up to 45 s: a sleeping Render instance takes that long to wake.
        r = await call('/api/settings', { headers: { 'X-Api-Key': apiKey || '' } }, timeoutMs || 45_000);
    } catch (e) {
        return { ok: false, warnings, error: `${hostOf(url)} did not answer (${e.name === 'AbortError' ? 'timed out' : e.message}). `
            + 'If it is a sleeping Render instance, open it once and push again.' };
    }
    if (r.status === 401 || r.status === 403) {
        return { ok: false, warnings, error: `${hostOf(url)} refused this server's API key — set its API_KEY to the same `
            + 'value first, or every phone that moves would be locked out.' };
    }
    if (!r.ok || !r.body || typeof r.body.globalForwarding !== 'boolean') {
        return { ok: false, warnings, error: `${hostOf(url)} answered HTTP ${r.status}, not like a GetOTP server.` };
    }
    // The same server under another name (or this address itself): "moving"
    // there would move nobody and only silence its alerts.
    if (selfId && r.body.serverId === selfId) {
        return { ok: false, warnings, error: `${hostOf(url)} is this server — pick the server to move TO.` };
    }
    if (r.body.moveTo) {
        warnings.push(`${hostOf(url)} is itself moving its phones to ${r.body.moveTo.url} — phones would follow on.`);
    }
    if (adminPassword) {
        try {
            const l = await call('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                 body: JSON.stringify({ password: adminPassword }) }, 10_000);
            if (l.ok && l.body && l.body.token) {
                await call('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + l.body.token,
                    'Content-Type': 'application/json' }, body: '{}' }, 5_000).catch(() => {});
            } else if (l.status === 401) {
                warnings.push('The admin password is different there: OTP Master moves with the phones and will ask you to sign in again.');
            }
        } catch (e) { /* the phones do not need it — no warning on a network blip */ }
    }
    return { ok: true, warnings };
}

function _reset() { pending = null; }

module.exports = { set, clear, forDevice, covers, status, preflight, hostOf, MAX_PENDING_MS, _reset };
