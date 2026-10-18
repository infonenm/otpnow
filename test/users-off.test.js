/**
 * test/users-off.test.js — server 4.41.3 with USERS_ENABLED off.
 *
 * Without users the server keeps no phone list. The Test and Keep online still
 * reach every phone, so their panels must say "cannot list" (listed:false), not
 * "no phones" — and a named target, which would reach nobody, is refused.
 *
 * Run: node test/users-off.test.js
 */
const assert = require('assert');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

process.env.DASHBOARD_PASSWORD = 'admin-pw';
process.env.API_KEY            = 'test-key';
process.env.USERS_ENABLED      = 'false';
process.env.STATE_FILE         = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-uoff-')), 's.json');
process.env.PORT               = '3997';

const fcm = require('../lib/fcm');
const pushes = [];
fcm.send = async (action, ts, topic) => { pushes.push({ action, topic }); };
require('../server.js');

function req(method, p, { body, token, apiKey } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (data) { headers['Content-Type'] = 'application/json';
                    headers['Content-Length'] = Buffer.byteLength(data); }
        if (token)  headers.Authorization = 'Bearer ' + token;
        if (apiKey) headers['X-Api-Key'] = apiKey;
        const r = http.request({ host: '127.0.0.1', port: 3997, method, path: p, headers }, res => {
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

(async () => {
    await sleep(300);
    const admin = (await req('POST', '/api/login', { body: { password: 'admin-pw' } })).body.token;
    assert.ok(admin);

    let r = await req('POST', '/api/test', { token: admin, body: { target: 'all' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.run.listed, false, 'the panel is told it cannot list phones');
    assert.deepStrictEqual(r.body.run.devices, []);
    assert.strictEqual(pushes[pushes.length - 1].topic, undefined, 'the Test still goes to every phone');

    r = await req('POST', '/api/test', { token: admin, body: { target: 'rahim' } });
    assert.strictEqual(r.status, 400, 'a named target reaches nobody without users — refused');

    r = await req('POST', '/api/keep-online', { token: admin, body: { on: true, target: 'rahim' } });
    assert.strictEqual(r.status, 400, 'same for Keep online');
    r = await req('POST', '/api/keep-online', { token: admin, body: { on: true } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.status.listed, false);
    const p = await req('GET', '/api/settings?deviceId=a1a1a1a1a1a1a1a1', { apiKey: 'test-key' });
    assert.strictEqual(p.body.keepOnline.on, true, 'every phone is still kept online');
    await req('POST', '/api/keep-online', { token: admin, body: { on: false } });

    // /get is untouched.
    await req('POST', '/sms', { apiKey: 'test-key', body: { sender: 'IVAC_BD', recipient: '01700000000',
        message: 'Your OTP is 445566' } });
    assert.strictEqual((await req('GET', '/get?number=01700000000')).body.otp, '445566');

    console.log('ok — with users off, Test and Keep online still reach every phone, their panels say the list '
        + 'is unavailable instead of "no phones", and a named target is refused');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
