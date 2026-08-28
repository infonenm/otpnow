/**
 * test/forwarding.test.js — the off switch must mean off.
 *
 * Two properties are asserted here, both of which used to fail:
 *
 *   1. While forwarding is OFF, a message that reaches this server is NOT
 *      stored. The device is supposed to have stopped already, but a phone that
 *      is asleep, offline or force-stopped has not heard the command yet — so
 *      the server has to be the final word rather than trusting every device to
 *      be up to date.
 *
 *   2. The setting SURVIVES A RESTART. It used to be a hardcoded `true`, which
 *      meant switching off, a restart for any reason, and every device turning
 *      itself back on within 30 seconds. An off switch that silently undoes
 *      itself is worse than no off switch.
 *
 * Run: node test/forwarding.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_FILE = path.join(os.tmpdir(), `getotp-test-state-${process.pid}.json`);
try { fs.unlinkSync(STATE_FILE); } catch (e) { /* fresh start */ }

process.env.API_KEY = 'test-api-key';
process.env.DASHBOARD_PASSWORD = 'test-password';
process.env.STATE_FILE = STATE_FILE;
process.env.PORT = '3997';
delete process.env.GET_KEY;

const realLog = console.log;
console.log = () => {};
require('../server.js');

const BASE = 'http://127.0.0.1:3997';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const json = (p, o) => fetch(BASE + p, o).then(r => r.json());

const postSms = (recipient, message) => json('/sms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': process.env.API_KEY },
    body: JSON.stringify({ sender: 'IVAC', recipient, message, arrivedAt: Date.now() })
});

(async () => {
    await sleep(400);

    const login = await json('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: process.env.DASHBOARD_PASSWORD })
    });
    const auth = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };
    const setForwarding = (enabled) => json('/api/toggle', {
        method: 'POST', headers: auth, body: JSON.stringify({ enabled })
    });

    // ── ON: normal behaviour, and the reply carries the state ────
    await setForwarding(true);
    const accepted = await postSms('01711111111', 'Your OTP is 111111');
    assert.strictEqual(accepted.success, true);
    assert.strictEqual(accepted.ignored, undefined, 'must not be ignored while ON');
    assert.strictEqual(accepted.globalForwarding, true,
        'reply must carry the state so the device can sync from it');
    assert.deepStrictEqual(await json('/get?number=01711111111'),
        { success: true, otp: '111111' });

    // ── OFF: the server declines, and stores nothing ─────────────
    await setForwarding(false);
    const declined = await postSms('01822222222', 'Your OTP is 222222');

    assert.strictEqual(declined.success, true,
        'must be 200/success — a 4xx would make the device retry a message we ' +
        'deliberately declined, for ten passes');
    assert.strictEqual(declined.ignored, true, 'must report that it was ignored');
    assert.strictEqual(declined.globalForwarding, false,
        'reply must tell the device to switch itself off');

    assert.deepStrictEqual(await json('/get?number=01822222222'),
        { success: false, otp: '' }, 'a declined message must not be fetchable');

    const stored = await json('/api/messages', { headers: auth });
    assert.strictEqual(stored.messages.some(m => m.recipient === '01822222222'), false,
        'a declined message must not reach the dashboard either');

    // ── The setting is persisted ─────────────────────────────────
    assert.strictEqual(fs.existsSync(STATE_FILE), true, 'state file must be written');
    const persisted = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    assert.strictEqual(persisted.globalForwarding, false,
        'OFF must be on disk, or a restart silently turns every device back on');

    // ── Filters are persisted too ────────────────────────────────
    // They used to revert to OTP_PATTERNS on every restart, i.e. to the
    // catch-all (\d{4,8}). Since any message with an extractable code
    // supersedes the live OTP, that catch-all lets a promotional SMS replace a
    // real OTP with whatever digits it contains. Sender-specific rules are the
    // fix, and they are only a fix if they survive a restart.
    const rules = [{ phoneNumber: 'IVAC', patterns: ['OTP is (\\d{6})'] }];
    await json('/api/filters', {
        method: 'POST', headers: auth, body: JSON.stringify({ filters: rules })
    });
    const afterFilters = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    assert.deepStrictEqual(afterFilters.filters, rules,
        'filter rules must be on disk, or a restart reopens the catch-all');

    await json('/api/auto-delete', {
        method: 'POST', headers: auth, body: JSON.stringify({ minutes: 12 })
    });
    assert.strictEqual(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).autoDeleteMinutes, 12,
        'auto-delete minutes must be on disk');

    // Writing one setting must not wipe the others.
    const all = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    assert.strictEqual(all.globalForwarding, false, 'a later write must not lose the on/off state');
    assert.deepStrictEqual(all.filters, rules, 'a later write must not lose the filters');

    // ── ON again: accepted immediately ───────────────────────────
    await setForwarding(true);
    const reaccepted = await postSms('01933333333', 'Your OTP is 333333');
    assert.strictEqual(reaccepted.ignored, undefined, 'must be accepted again once ON');
    assert.deepStrictEqual(await json('/get?number=01933333333'),
        { success: true, otp: '333333' });

    // ── FORWARDING_DEFAULT decides the post-redeploy state ───────
    // A redeploy starts from a fresh container, so the state file is gone. The
    // env var is the only thing that survives that.
    delete require.cache[require.resolve('../lib/store')];
    try { fs.unlinkSync(STATE_FILE); } catch (e) { /* simulating a redeploy */ }
    process.env.FORWARDING_DEFAULT = 'off';
    const freshStore = require('../lib/store');
    assert.strictEqual(freshStore.isForwardingEnabled(), false,
        'FORWARDING_DEFAULT=off must survive a redeploy');

    try { fs.unlinkSync(STATE_FILE); } catch (e) { /* cleanup */ }
    console.log = realLog;
    console.log('ok — OFF is enforced server-side, not stored, and survives a restart');
    process.exit(0);
})().catch((e) => {
    console.log = realLog;
    try { fs.unlinkSync(STATE_FILE); } catch (err) { /* cleanup */ }
    console.error('FAIL:', e.message);
    process.exit(1);
});
