/**
 * test/shutdown.test.js — a deploy must not lose a save.
 *
 * Render stops the old instance with SIGTERM. Config and identity writes are
 * debounced by two seconds and the archive flushes every thirty, so before
 * 4.37.0 a filter saved just before a deploy was in memory only when the process
 * died. This starts the REAL server in a child process, saves a filter, sends
 * SIGTERM inside the debounce window, and reads what reached the store.
 *
 * Run: node test/shutdown.test.js
 */
const assert = require('assert');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { spawn } = require('child_process');

const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-sd-'));
const FILE = path.join(dir, 'firestore.json');
const PORT = 3994;

function req(method, p, { body, token } = {}) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const headers = { 'Content-Type': 'application/json' };
        if (data) headers['Content-Length'] = Buffer.byteLength(data);
        if (token) headers.Authorization = 'Bearer ' + token;
        const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers }, res => {
            let buf = ''; res.on('data', c => buf += c);
            res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(buf || 'null') }));
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    const child = spawn(process.execPath,
        ['-r', path.join(__dirname, 'helpers', 'file-firestore.js'), path.join(__dirname, '..', 'server.js')], {
        env: Object.assign({}, process.env, {
            PORT: String(PORT), DASHBOARD_PASSWORD: 'pw', API_KEY: 'k',
            FIRESTORE_ENABLED: 'true', FIREBASE_SERVICE_ACCOUNT: '{"stub":true}',
            HISTORY_ENABLED: 'true',
            STATE_FILE: path.join(dir, 'state.json'), FAKE_FIRESTORE_FILE: FILE
        }),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);

    for (let i = 0; i < 50 && !/on port/.test(log); i++) await sleep(100);
    const token = (await req('POST', '/api/login', { body: { password: 'pw' } })).json.token;
    const filters = [{ phoneNumber: 'IVAC', patterns: ['is (\\d{6})'] },
                     { phoneNumber: 'DEFAULT', patterns: ['(\\d{4,8})'] }];
    const r = await req('POST', '/api/filters', { token, body: { filters } });
    assert.strictEqual(r.status, 200);

    // A message that finishes, so the archive has something queued too.
    await new Promise((resolve, reject) => {
        const data = JSON.stringify({ sender: 'IVAC', recipient: '01711111111',
                                      message: 'Your OTP is 445566', msgId: 'sd1' });
        const q = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/sms',
            headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'k',
                       'Content-Length': Buffer.byteLength(data) } }, res => { res.resume(); res.on('end', resolve); });
        q.on('error', reject); q.write(data); q.end();
    });
    await req('GET', '/get?number=01711111111');      // fetched -> archive queue

    // Inside the 2 s debounce and the 30 s archive interval: nothing saved yet.
    const before = (() => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return {}; } })();
    assert.ok(!before['getotp/config'], 'precondition: the filter save is still debounced');

    const exited = new Promise(r => child.on('exit', (code, sig) => r({ code, sig })));
    child.kill('SIGTERM');
    const { code } = await exited;
    assert.strictEqual(code, 0, 'a clean exit on SIGTERM:\n' + log);

    const after = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    assert.ok(after['getotp/config'], 'the debounced config write reached the store before exit');
    assert.deepStrictEqual(after['getotp/config'].filters.map(f => f.phoneNumber), ['IVAC', 'DEFAULT']);
    const archivedRows = Object.keys(after).filter(k => k.startsWith('getotp_history/'));
    assert.strictEqual(archivedRows.length, 1, 'the queued archive entry was written on the way out');

    console.log('ok — SIGTERM saves pending config and archive writes before the process exits');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
