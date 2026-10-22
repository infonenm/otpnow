/**
 * test/scan-libs-4431.test.js — server 4.43.1: the full-package scan, support libraries.
 *
 * Each case was reproduced by an independent reviewer and fails without its fix.
 *   1. Queued SMS are not expired before the users/phones list has loaded.
 *   2. A re-queued job the phone has reported on is never handed out again.
 *   3. The phone's part count does not change what the daily limit charges.
 *   4. One history entry Firestore refuses does not stop the archive.
 *   5. Outbox commits land in order (a late timed-out commit cannot win).
 *   6. A new device past MAX_DEVICES is refused; existing phones are not.
 *   7. JSON values named toString/valueOf no longer 500 any route.
 *
 * Each case runs in its own process (module state, env).
 * Run: node test/scan-libs-4431.test.js
 */
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { spawnSync } = require('child_process');

const LIB = path.join(__dirname, '..', 'lib');
const SRV = path.join(__dirname, '..', 'server.js');
function run(env, code, timeout) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'getotp-scanlibs-'));
    const r = spawnSync(process.execPath, ['-e', `const LIB=${JSON.stringify(LIB)};const SRV=${JSON.stringify(SRV)};` + code], {
        encoding: 'utf8', timeout: timeout || 60000,
        env: Object.assign({}, process.env, { USERS_ENABLED: 'true', STATE_FILE: path.join(dir, 's.json') }, env) });
    return (r.stdout || '') + (r.stderr || '');
}

// ── 1. identity race ──────────────────────────────────────────────
{
    const out = run({}, `
console.log = () => {};
const store = require(LIB + '/store'); const outbox = require(LIB + '/outbox'); const firestore = require(LIB + '/firestore');
const users = store.users; const now = Date.now(), dev = 'aaaaaaaaaaaaaaaa';
const saved = [0,1,2].map(i => ({ id: 'job'+i, batchId: 'b', createdAt: now - 60000, updatedAt: now - 60000, createdBy: 'rahim',
  createdByName: 'rahim', fromDeviceId: dev, fromDeviceName: 'X', fromSlot: 1, fromNumber: '01711111111', fromOwner: 'rahim',
  to: '0181111111'+i, toLabel: '', message: 'm', encoding: 'gsm', parts: 1, status: 'queued', error: '', dispatchedAt: 0,
  sentAt: 0, deliveredAt: 0, receivedAt: 0, finishedAt: 0, partsSent: [], partsDelivered: [], requeued: 0, acked: false, retryOf: '' }));
const q = { where: () => q, orderBy: () => q, limit: () => q, get: async () => ({ forEach: f => saved.forEach(d => f({ data: () => JSON.parse(JSON.stringify(d)) })) }) };
firestore._setDbForTests({ collection: () => q, batch: () => ({ set() {}, delete() {}, commit: async () => {} }) });
(async () => {
  await outbox.load();
  outbox.sweep(now + 30000);
  users.load({ users: [{ id: 'rahim', name: 'rahim', active: true, sendEnabled: true, sendDailyLimit: 50, createdAt: 1 }],
               devices: [{ id: dev, userId: 'rahim', canSendSms: true, sims: [{ slot: 1, number: '01711111111', present: true }] }] });
  users.getDevice(dev).lastSeen = now + 31000;
  process.stderr.write('PULLED=' + outbox.pull(dev, now + 31000).length + '\\n');
  process.exit(0);
})();`);
    assert.ok(/PULLED=3/.test(out), 'queued jobs survive until the roster loads: ' + out);
}

// ── 2 + 3. outbox reports ─────────────────────────────────────────
{
    const out = run({}, `
console.log = () => {};
const store = require(LIB + '/store'); const outbox = require(LIB + '/outbox'); const users = store.users;
users.load({ users: [], devices: [] });
users.createUser('rahim'); users.setSendPermission('rahim', { enabled: true, dailyLimit: 6 });
const id = 'aaaaaaaaaaaaaaaa';
users.registerDevice(id, { model: 'X', canSendSms: true, sims: [{ slot: 1, number: '01711111111', source: 'manual', present: true }] });
users.assignDevice(id, 'rahim'); outbox._setLoaded(true);
const rahim = { userId: 'rahim', role: 'user' };
let t = Date.now(); const on = () => users.getDevice(id).lastSeen = t;
const long = 'x'.repeat(200);
let r = outbox.createBatch(rahim, { fromDeviceId: id, fromSlot: 1, to: ['01811111111'], message: long }, t);
const j = outbox._jobs.get(r.jobs[0].id);
outbox.pull(id, t); t += 4 * 60000; on(); outbox.sweep(t);
outbox.report(id, { jobId: j.id, event: 'part_delivered', part: 0, parts: 2 }, t + 1);
process.stderr.write('AGAIN=' + outbox.pull(id, t + 2).some(x => x.id === j.id) + '\\n');
t += 3600000; on();
r = outbox.createBatch(rahim, { fromDeviceId: id, fromSlot: 1, to: ['01822222222', '01833333333'], message: long }, t);
for (const pj of outbox.pull(id, t)) outbox.report(id, { jobId: pj.id, event: 'sending', parts: 1 }, t + 1);
process.stderr.write('USED=' + outbox.usedToday('rahim', t + 2) + '\\n');
process.exit(0);`);
    assert.ok(/AGAIN=false/.test(out), 'a reported re-queued job is not handed out again: ' + out);
    assert.ok(/USED=6/.test(out), "the phone's part count refunds nothing: " + out);
}

// ── 4. a refused history entry ────────────────────────────────────
{
    const out = run({ HISTORY_ENABLED: 'true', FIRESTORE_ENABLED: 'true' }, `
console.log = () => {}; console.error = () => {};
const firestore = require(LIB + '/firestore'); const history = require(LIB + '/history');
const stored = [];
firestore._setDbForTests({ collection: c => ({ doc: id => ({ id }) }),
  batch: () => { const ops = []; return { set: (ref, d) => ops.push(d), delete() {},
    commit: async () => { if (ops.some(d => d.message === 'POISON')) throw new Error('3 INVALID_ARGUMENT: Cannot use "undefined" as a Firestore value');
                          stored.push(...ops); } }; } });
const sms = (id, m) => ({ id, userId: 'admin', sender: 'IVAC', recipient: '01711111111', message: m, receivedAt: 1, arrivedAt: 1 });
history.record(sms('a', 'POISON'), 'fetched');
for (let i = 0; i < 5; i++) history.record(sms('b' + i, 'ok ' + i), 'fetched');
(async () => {
  await history.flush(); await history.flush();
  process.stderr.write('STORED=' + stored.length + ' QUEUED=' + history.stats().queued + ' REJECTED=' + history.stats().rejected + '\\n');
  process.exit(0);
})();`);
    assert.ok(/STORED=5 QUEUED=0 REJECTED=1/.test(out), 'the refused entry is dropped, the rest written: ' + out);
}

// ── 5. outbox commit order ────────────────────────────────────────
{
    const out = run({ FIRESTORE_ENABLED: 'true' }, `
console.log = () => {}; console.error = () => {};
const firestore = require(LIB + '/firestore');
const docs = new Map(); let n = 0;
firestore._setDbForTests({ collection: () => ({ doc: id => ({ id }) }),
  batch: () => { const ops = []; return { set: (ref, d) => ops.push([ref.id, d]), delete() {},
    commit: () => { const k = ++n; return new Promise(r => setTimeout(() => { for (const [id, d] of ops) docs.set(id, d); r(); }, k === 1 ? 600 : 10)); } }; } });
(async () => {
  const first = firestore.writeOutbox('o', [{ id: 'j', status: 'queued' }]).catch(() => {});
  await new Promise(r => setTimeout(r, 50));
  await firestore.writeOutbox('o', [{ id: 'j', status: 'dispatched' }]);
  await first;
  process.stderr.write('FINAL=' + docs.get('j').status + '\\n');
  process.exit(0);
})();`);
    assert.ok(/FINAL=dispatched/.test(out), 'the newer job state wins: ' + out);
}

// ── 6. device cap ─────────────────────────────────────────────────
{
    const out = run({ MAX_DEVICES: '50' }, `
console.log = () => {}; console.error = () => {};
const store = require(LIB + '/store'); const users = store.users;
users.load({ users: [], devices: [] });
const hex = i => i.toString(16).padStart(16, '0');
let refused = 0;
for (let i = 1; i <= 60; i++) if (users.registerDevice(hex(i), { model: 'X' }).error) refused++;
const again = users.registerDevice(hex(1), { model: 'X' });
process.stderr.write('REFUSED=' + refused + ' EXISTING=' + (!again.error) + '\\n');
process.exit(0);`);
    assert.ok(/REFUSED=10 EXISTING=true/.test(out), 'new rows past the cap refused, existing phones fine: ' + out);
}

// ── 7. toString / valueOf bodies ──────────────────────────────────
{
    const out = run({ PORT: '3987', DASHBOARD_PASSWORD: 'pw', API_KEY: 'k' }, `
console.log = () => {}; console.error = () => {}; console.warn = () => {};
require(SRV);
const base = 'http://127.0.0.1:3987';
(async () => {
  await new Promise(r => setTimeout(r, 400));
  const tok = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) })).json()).token;
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok, 'X-Api-Key': 'k' };
  const bad = JSON.stringify({ jobId: { toString: 1 }, deviceId: { valueOf: 1 }, url: { toString: 1 }, name: { toString: 1 } });
  let worst = 0;
  for (const p of ['/api/send/retry', '/api/send/cancel', '/api/send/report', '/api/register', '/api/set-url', '/api/users', '/sms']) {
    const r = await fetch(base + p, { method: 'POST', headers: H, body: bad });
    worst = Math.max(worst, r.status);
  }
  process.stderr.write('WORST=' + worst + '\\n');
  process.exit(0);
})();`);
    const m = out.match(/WORST=(\d+)/);
    assert.ok(m && Number(m[1]) < 500, 'no 5xx from hostile JSON values: ' + out);
}

console.log('ok — outbox waits for the roster, no second hand-out, no part refund, archive survives a refused entry, '
    + 'commits in order, device cap, no 5xx from toString/valueOf');
