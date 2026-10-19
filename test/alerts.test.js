/**
 * test/alerts.test.js — server 4.42.0: push alerts for OTP Master.
 *
 * What must hold:
 *   1. A phone that was online and goes quiet for 10 min → ONE "offline" alert;
 *      flapping inside the cooldown is not a stream; "back online" follows only
 *      an alert that was sent. First sight after a restart never alerts.
 *   2. Removed phones and phones gone for a week are not watched.
 *   3. Failed dashboard SMS are batched into one alert, once per SMS.
 *   4. Keep online left on: a reminder after 3 h, then every 3 h; a new ON
 *      restarts the clock; OFF stops it.
 *   5. Each kind goes to its own topic (so the app can mute it), and no alert
 *      carries a phone number or a message text.
 *   6. GET /api/alerts is admin only.
 *
 * Run: node test/alerts.test.js
 */
const assert = require('assert');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

process.env.DASHBOARD_PASSWORD = 'admin-pw';
process.env.API_KEY            = 'test-key';
process.env.USERS_ENABLED      = 'true';
process.env.STATE_FILE         = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-alerts-')), 's.json');
process.env.PORT               = '3998';
// The timeline below is written for a 10-minute threshold (the default is 20).
process.env.ALERT_OFFLINE_MINUTES = '10';

const fcm = require('../lib/fcm');
const pushes = [];
fcm.send = async (action, ts, topic, extra) => { pushes.push({ action, topic, data: extra || {} }); };

const users      = require('../lib/users');
const outbox     = require('../lib/outbox');
const keepOnline = require('../lib/keeponline');
const alerts     = require('../lib/alerts');
require('../server.js');

function req(method, p, { body, token, apiKey } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json';
                    headers['Content-Length'] = Buffer.byteLength(data); }
        if (token)  headers.Authorization = 'Bearer ' + token;
        if (apiKey) headers['X-Api-Key'] = apiKey;
        const r = http.request({ host: '127.0.0.1', port: 3998, method, path: p, headers }, res => {
            let raw = ''; res.on('data', c => raw += c);
            res.on('end', () => { let b = null; try { b = JSON.parse(raw); } catch (e) { /* */ }
                                  resolve({ status: res.statusCode, body: b }); });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const KEY = 'test-key';
const register = (deviceId, model) => req('POST', '/api/register', { apiKey: KEY,
    body: { deviceId, model, installId: deviceId, appVersion: '4.38.0',
            sims: [{ slot: 1, number: '01711111111', source: 'manual', unconfirmed: false,
                     changedAt: 0, changedFrom: '', present: true }], canSendSms: true } });
const alertPushes = () => pushes.filter(p => p.action === 'admin_alert');

(async () => {
    await sleep(300);
    const admin = (await req('POST', '/api/login', { body: { password: 'admin-pw' } })).body.token;
    const created = (await req('POST', '/api/users', { token: admin, body: { name: 'Rahim' } })).body;
    await req('POST', '/api/set-password', { body: { username: 'rahim', code: created.enrollCode,
                                                     password: 'rahim-password' } });
    const rahim = (await req('POST', '/api/login', { body: { username: 'rahim', password: 'rahim-password' } })).body.token;

    const A = 'a1a1a1a1a1a1a1a1', B = 'b2b2b2b2b2b2b2b2', C = 'c3c3c3c3c3c3c3c3';
    await register(A, 'Infinix X6816C');
    await register(B, 'Galaxy M14');
    await register(C, 'Redmi 12');
    await req('POST', `/api/devices/${A}/assign`, { token: admin, body: { userId: 'rahim' } });
    alerts._reset();
    const now0 = Date.now();
    for (const id of [A, B, C]) users.getDevice(id).lastSeen = now0;

    // ── 1. first sight never alerts ──────────────────────────────
    alerts.check(now0);
    assert.strictEqual(alertPushes().length, 0, 'learning the phones after a restart is silent');

    // A goes quiet for 11 min → one alert, on the offline topic.
    let t = now0 + 11 * 60_000;
    users.getDevice(B).lastSeen = t; users.getDevice(C).lastSeen = t;
    alerts.check(t);
    let ap = alertPushes();
    assert.strictEqual(ap.length, 1);
    assert.strictEqual(ap[0].topic, alerts.TOPICS.offline);
    assert.match(ap[0].data.title, /Infinix X6816C \(rahim\) is offline/);
    alerts.check(t + 60_000);
    assert.strictEqual(alertPushes().length, 1, 'once, not every minute');

    // Back online → "back online"; then quiet again inside the cooldown → silent.
    t += 2 * 60_000;
    users.getDevice(A).lastSeen = t;
    alerts.check(t);
    ap = alertPushes();
    assert.strictEqual(ap.length, 2);
    assert.match(ap[1].data.title, /back online/);
    users.getDevice(B).lastSeen = t + 11 * 60_000; users.getDevice(C).lastSeen = t + 11 * 60_000;
    alerts.check(t + 11 * 60_000);
    assert.strictEqual(alertPushes().length, 2, 'a flapping phone inside the cooldown is not a stream');
    // Coming back after a SILENT offline is not announced.
    users.getDevice(A).lastSeen = t + 12 * 60_000;
    alerts.check(t + 12 * 60_000);
    assert.strictEqual(alertPushes().length, 2, '"back online" only follows an alert that was sent');
    // Quiet AGAIN, still inside the cooldown of the first alert (sent at t-2m)…
    const fresh = at => { users.getDevice(B).lastSeen = at; users.getDevice(C).lastSeen = at; };
    fresh(t + 23 * 60_000); alerts.check(t + 23 * 60_000);
    assert.strictEqual(alertPushes().length, 2, 'inside the cooldown: silent');
    // A has napped twice now (13 and 12 min, both ended by themselves), so it
    // is given its longest nap + NAP_MARGIN_MS = 23 min before being reported
    // (server 4.42.1). Quiet since t+12: at t+29 (17 min) that is still a nap.
    fresh(t + 29 * 60_000); alerts.check(t + 29 * 60_000);
    assert.strictEqual(alertPushes().length, 2, 'quiet no longer than its usual naps: not reported');
    // …and still quiet past its usual nap + margin, cooldown over → reported
    // (the last word must not stay "back online" for a dead phone — review 4.42.0).
    fresh(t + 36 * 60_000); alerts.check(t + 36 * 60_000);
    ap = alertPushes();
    assert.strictEqual(ap.length, 3, 'quiet longer than any recent nap is reported');
    assert.match(ap[2].data.title, /Infinix X6816C \(rahim\) is offline/);
    assert.match(ap[2].data.body, /usually naps up to 13 min/);
    fresh(t + 38 * 60_000); alerts.check(t + 38 * 60_000);
    assert.strictEqual(alertPushes().length, 3, 'and only once');
    users.getDevice(A).lastSeen = t + 39 * 60_000; fresh(t + 39 * 60_000);
    alerts.check(t + 39 * 60_000);
    assert.match(alertPushes()[3].data.title, /back online/);
    // The list knows which phone each offline alert is about (one row per
    // phone in the app); the push itself never carries it.
    assert.ok(alerts.recent().filter(a => a.kind === 'offline').every(a => a.device === A));
    assert.ok(alertPushes().every(p => p.data.device === undefined), 'no device id in a push');
    // A restart while a phone is ALREADY quiet: it was never seen online since,
    // so it is not reported (a restart never alerts).
    alerts._reset();
    users.getDevice(A).lastSeen = t; fresh(t + 40 * 60_000);
    alerts.check(t + 40 * 60_000); fresh(t + 80 * 60_000); alerts.check(t + 80 * 60_000);
    assert.strictEqual(alertPushes().length, 4, 'not seen online since the restart → never reported');

    // ── 1b. naps (4.42.1): learned per phone, capped, forgotten after a day ──
    {
        const nap = alerts._reset() || null;
        const base = alerts.OFFLINE_AFTER_MS;
        const T0 = t + 100 * 60_000;
        const others = at => { users.getDevice(B).lastSeen = at; users.getDevice(C).lastSeen = at; };
        const at = m => T0 + m * 60_000;
        users.getDevice(A).lastSeen = T0; others(T0); alerts.check(T0);
        pushes.length = 0;
        // Nap 1: 30 min. Nothing learned yet → reported at the base threshold.
        others(at(11)); alerts.check(at(11));
        assert.strictEqual(alertPushes().length, 1, 'the first nap is reported');
        users.getDevice(A).lastSeen = at(30); others(at(30)); alerts.check(at(30));
        assert.strictEqual(alertPushes().length, 2, 'and its end');
        // Nap 2, the same length, after the cooldown: silent — tolerance 30 + 10.
        for (let m = 31; m <= 90; m++) { others(at(m)); alerts.check(at(m)); if (m === 69) break; }
        assert.strictEqual(alertPushes().length, 2, 'a nap like the last one: no push');
        users.getDevice(A).lastSeen = at(69); others(at(69)); alerts.check(at(69));
        assert.strictEqual(alertPushes().length, 2, 'and no "back online" either');
        // A real outage: reported once it outlasts its naps + margin (39 min learned → 49).
        for (let m = 70; m <= 69 + 48; m++) { others(at(m)); alerts.check(at(m)); }
        assert.strictEqual(alertPushes().length, 2, 'still within its usual nap + margin');
        others(at(69 + 50)); alerts.check(at(69 + 50));
        assert.strictEqual(alertPushes().length, 3, 'past it: reported');
        // A spell longer than the cap teaches nothing; tolerance never exceeds the cap.
        users.getDevice(A).lastSeen = at(69 + 200); others(at(69 + 200)); alerts.check(at(69 + 200));
        const D2 = at(69 + 200);
        pushes.length = 0;
        others(D2 + base + 60_000); alerts.check(D2 + base + 60_000);
        assert.strictEqual(alertPushes().length, 0, 'the earlier naps (≤ 39 min) still apply');
        others(D2 + 51 * 60_000); alerts.check(D2 + 51 * 60_000);
        assert.strictEqual(alertPushes().length, 1, 'the 200-min outage did not stretch the tolerance');
        users.getDevice(A).lastSeen = D2 + 52 * 60_000; others(D2 + 52 * 60_000); alerts.check(D2 + 52 * 60_000);
        // The cap: a 115-min nap allows 120 min, not 125.
        const st = { naps: [{ at: D2, ms: 115 * 60_000 }] };
        assert.strictEqual(alerts._toleranceOf(st, D2), alerts.NAP_CAP_MS);
        assert.strictEqual(alerts._toleranceOf({ naps: [] }, D2), base, 'no naps: the base threshold');
        // After a day the naps are forgotten → back to the base threshold.
        const later = D2 + alerts.NAP_CAP_MS + 25 * 3600_000;
        users.getDevice(A).lastSeen = later; others(later); alerts.check(later);
        pushes.length = 0;
        others(later + base + 60_000); alerts.check(later + base + 60_000);
        assert.strictEqual(alertPushes().length, 1, 'naps older than a day are forgotten');
        void nap;
    }
    pushes.length = 0;
    alerts._reset();

    // ── 1c. a REPORTED long outage is not learned as a nap (audit 4.42.1) ──
    {
        const T1 = t + 5000 * 60_000;
        const at = m => T1 + m * 60_000;
        const others = x => { users.getDevice(B).lastSeen = x; users.getDevice(C).lastSeen = x; };
        users.getDevice(A).lastSeen = T1; others(T1); alerts.check(T1);
        pushes.length = 0;
        others(at(11)); alerts.check(at(11));
        assert.strictEqual(alertPushes().length, 1, 'the outage is reported');
        users.getDevice(A).lastSeen = at(110); others(at(110)); alerts.check(at(110));   // back after 110 min
        assert.strictEqual(alertPushes().length, 2);
        others(at(110 + 11)); alerts.check(at(110 + 11));
        assert.strictEqual(alertPushes().length, 3,
            'the next outage is reported at the base threshold, not after a learned 2 h');
    }
    pushes.length = 0;
    alerts._reset();

    // ── 2. removed / long-gone phones are not watched ────────────
    await req('POST', `/api/devices/${C}/remove`, { token: admin, body: {} });
    t += 40 * 60_000;
    users.getDevice(A).lastSeen = t; users.getDevice(B).lastSeen = t;
    alerts.check(t);
    alerts.check(t + 11 * 60_000);              // A and B quiet now; C is gone
    ap = alertPushes();
    assert.ok(!ap.some(p => /Redmi/.test(p.data.title)), 'a removed phone is never alerted about');

    // ── 3. failed SMS: batched, once per SMS ─────────────────────
    pushes.length = 0;
    const j1 = { status: 'failed', error: 'error code 112', fromDeviceName: 'Infinix X6816C', fromSlot: 1,
                 to: '01555000111', message: 'secret 4242' };
    const j2 = Object.assign({}, j1, { error: 'sim_mismatch' });
    alerts.smsFailed(j1);
    alerts.smsFailed(j2);
    assert.strictEqual(alertPushes().length, 0, 'waits for the batch window');
    alerts.flushSms();
    ap = alertPushes();
    assert.strictEqual(ap.length, 1, 'one alert for the batch');
    assert.strictEqual(ap[0].topic, alerts.TOPICS.sms);
    assert.match(ap[0].data.title, /2 SMS were not sent/);
    assert.match(ap[0].data.body, /Network error from the operator/);

    // Free-text errors never reach a push: "that SIM is no longer 017…" is the
    // server's own reason and carries the number (review 4.42.0).
    pushes.length = 0;
    alerts.smsFailed({ status: 'expired', error: 'that SIM is no longer 01711111111', fromDeviceName: 'Galaxy', fromSlot: 1 });
    const flushed = alerts.flushSms();
    assert.ok(flushed && typeof flushed.then === 'function', 'flushSms returns the send (shutdown awaits it)');
    ap = alertPushes();
    assert.strictEqual(ap.length, 1);
    assert.ok(!/\d{5}/.test(ap[0].data.body), 'no number: ' + ap[0].data.body);
    assert.match(ap[0].data.body, /expired before the phone sent it/);
    assert.strictEqual(alerts.reasonOf({ status: 'unknown',
        error: 'handed to the phone, then nothing heard (that SIM is no longer 01711111111) — check its Sent messages' }),
        'it may or may not have gone out — check the phone\'s Sent messages');
    assert.strictEqual(alerts.redact('call +880 1711-111111 now'), 'call … now');
    // Any script, any separator (review 4.42.0: these all went out unscrubbed).
    for (const name of ['Riad 017.1111.1111', 'SIM ০১৭১১১১১১১১', '01711/111111', '01711_111111',
                        '0171１１１１１１１', '(017) 1111 1111']) {
        const out = alerts.redact(name);
        assert.ok(!/\p{Nd}{4}/u.test(out.replace(/\D(?=\d)/g, '')) && !/(\p{Nd}\D{0,3}){4}\p{Nd}/u.test(out),
                  'scrubbed: ' + name + ' → ' + out);
    }
    assert.strictEqual(alerts.redact('No check-in for 11 min · SIM 1 · code 112'), 'No check-in for 11 min · SIM 1 · code 112');
    assert.strictEqual(alerts.redact('Android code 112'), 'Android code 112', 'a short code is not a number');

    // Through the outbox: a job failing fires the hook exactly once.
    pushes.length = 0;
    let r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: B, fromSlot: 1,
        to: ['01555000222'], message: 'hello 9999' } });
    // (B must be online for the send; it polled at t + 11 min in test time,
    //  so refresh it to real now.)
    if (r.status !== 200) {
        users.getDevice(B).lastSeen = Date.now();
        r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: B, fromSlot: 1,
            to: ['01555000222'], message: 'hello 9999' } });
    }
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const jid = r.body.jobs[0].id;
    await req('GET', `/api/send/pull?deviceId=${B}`, { apiKey: KEY });
    await req('POST', '/api/send/report', { apiKey: KEY, body: { deviceId: B, jobId: jid,
        event: 'part_failed', part: 0, parts: 1, error: 'error code 4' } });
    await req('POST', '/api/send/report', { apiKey: KEY, body: { deviceId: B, jobId: jid,
        event: 'refused', part: -1, parts: 1, error: 'x' } });
    // A Retry re-announces the original (retriedBy) — still no second alert.
    users.getDevice(B).lastSeen = Date.now();
    const rr = await req('POST', '/api/send/retry', { token: admin, body: { jobId: jid } });
    assert.strictEqual(rr.status, 200, JSON.stringify(rr.body));
    alerts.flushSms();
    ap = alertPushes();
    assert.strictEqual(ap.length, 1, 'one alert for one failed SMS, however often it is announced again');
    assert.match(ap[0].data.title, /^⚠️ An SMS was not sent$/, 'counted once, not once per announcement');
    assert.match(ap[0].data.body, /No signal/);

    // ── 5. no number, no text in any alert ───────────────────────
    for (const p of pushes) {
        const s = JSON.stringify(p.data);
        assert.ok(!/015550|01711111111|secret|hello 9999/.test(s), 'no number or message text: ' + s);
    }

    // ── 3b. the admin's own action is not an "SMS not sent" alert ──
    pushes.length = 0;
    users.getDevice(B).lastSeen = Date.now();
    r = await req('POST', '/api/send', { token: admin, body: { fromDeviceId: B, fromSlot: 1,
        to: ['01555000333'], message: 'queued then phone removed' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const qid = r.body.jobs[0].id;
    await req('POST', `/api/devices/${B}/remove`, { token: admin, body: {} });
    outbox.sweep(Date.now());
    alerts.flushSms();
    assert.strictEqual(outbox._jobs.get(qid).status, 'expired', 'the queued SMS expired with its phone');
    assert.strictEqual(alertPushes().length, 0, 'removing the phone yourself is not pushed back as "SMS not sent"');

    // ── 4. Keep online reminder ──────────────────────────────────
    pushes.length = 0;
    const sess = { userId: 'admin', role: 'admin' };
    const k0 = Date.now();
    keepOnline.set(true, null, sess, k0);
    alerts.check(k0 + 60_000);
    assert.strictEqual(alertPushes().filter(p => p.topic === alerts.TOPICS.keeponline).length, 0);
    alerts.check(k0 + alerts.KEEP_ONLINE_REMIND_MS + 1000);
    let ko = alertPushes().filter(p => p.topic === alerts.TOPICS.keeponline);
    assert.strictEqual(ko.length, 1, 'reminded after 3 h');
    assert.match(ko[0].data.body, /All phones have been kept awake for 3 h/);
    alerts.check(k0 + alerts.KEEP_ONLINE_REMIND_MS + 120_000);
    assert.strictEqual(alertPushes().filter(p => p.topic === alerts.TOPICS.keeponline).length, 1, 'not again at once');
    alerts.check(k0 + 2 * alerts.KEEP_ONLINE_REMIND_MS + 2000);
    assert.strictEqual(alertPushes().filter(p => p.topic === alerts.TOPICS.keeponline).length, 2, 'and every 3 h');
    keepOnline.set(false, null, sess, k0 + 2 * alerts.KEEP_ONLINE_REMIND_MS + 3000);
    alerts.check(k0 + 4 * alerts.KEEP_ONLINE_REMIND_MS);
    assert.strictEqual(alertPushes().filter(p => p.topic === alerts.TOPICS.keeponline).length, 2, 'OFF stops it');

    // ── 7. a job saved before alerts existed is old news ─────────
    {
        const firestore = require('../lib/firestore');
        const saved = { isEnabled: firestore.isEnabled, read: firestore.readOutboxSince };
        firestore.isEnabled = () => true;
        firestore.readOutboxSince = async () => ({ ok: true, jobs: [
            { id: 'old-failed-1', status: 'failed', createdAt: Date.now() - 3600_000, createdBy: 'admin' },
            { id: 'old-queued-1', status: 'queued', createdAt: Date.now() - 60_000, createdBy: 'admin' },
            { id: 'new-failed-1', status: 'failed', failureAlerted: false, createdAt: Date.now(), createdBy: 'admin' }] });
        await outbox.load();
        firestore.isEnabled = saved.isEnabled; firestore.readOutboxSince = saved.read;
        assert.strictEqual(outbox._jobs.get('old-failed-1').failureAlerted, true, 'pre-4.42 failure: not alerted again');
        assert.strictEqual(outbox._jobs.get('old-queued-1').failureAlerted, undefined, 'a live job still can be');
        assert.strictEqual(outbox._jobs.get('new-failed-1').failureAlerted, false, 'a saved flag is kept as it is');
        for (const id of ['old-failed-1', 'old-queued-1', 'new-failed-1']) outbox._jobs.delete(id);
    }

    // ── 6. admin only ────────────────────────────────────────────
    assert.strictEqual((await req('GET', '/api/alerts', { token: rahim })).status, 403);
    r = await req('GET', '/api/alerts', { token: admin });
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body.alerts) && r.body.alerts.length > 0);
    assert.strictEqual(r.body.topics.offline, 'admin_alert_offline');

    // ── 8. the list holds the last 24 h, at most 50, and can be cleared (4.42.1)
    {
        const now = Date.now();
        alerts._reset();
        const s = alerts._sent;
        s.push({ at: now - alerts.RECENT_MS - 60_000, kind: 'offline', title: 'old', body: '' });
        s.push({ at: now - 3600_000, kind: 'offline', title: 'fresh', body: '' });
        assert.deepStrictEqual(alerts.recent(now).map(a => a.title), ['fresh'], 'older than 24 h: dropped');
        for (let i = 0; i < alerts.RECENT_MAX + 10; i++) s.push({ at: now, kind: 'sms', title: 'n' + i, body: '' });
        const list = alerts.recent(now);
        assert.strictEqual(list.length, alerts.RECENT_MAX, 'never more than 50');
        assert.strictEqual(list[list.length - 1].title, 'n' + (alerts.RECENT_MAX + 9), 'the newest are kept');

        assert.strictEqual((await req('POST', '/api/alerts/clear', { token: rahim })).status, 403);
        r = await req('POST', '/api/alerts/clear', { token: admin });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.cleared, alerts.RECENT_MAX);
        r = await req('GET', '/api/alerts', { token: admin });
        assert.strictEqual(r.body.alerts.length, 0, 'cleared');
    }

    console.log('ok — offline/back-online alerts once per change with a cooldown, failed SMS batched once per SMS, '
        + 'a Keep online reminder every 3 h, each kind on its own topic, and no number or text in any push');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
