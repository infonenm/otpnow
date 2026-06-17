/**
 * lib/store.js — In-memory SMS + settings store
 *
 * Replaces Firebase RTDB entirely. All data lives in server memory.
 * - SMS auto-delete after configurable minutes
 * - Settings initialized from env vars, modifiable at runtime
 * - SSE broadcast to connected dashboard clients
 *
 * Trade-off: data is lost on server restart. Acceptable because:
 * - OTPs are consumed within seconds and auto-delete in 10-30 min
 * - Settings fall back to env var defaults on restart
 * - Android app's SQLite queue retries if server was briefly down
 */

const crypto = require('crypto');
const { extractCode } = require('./otp');

// ─── Phone number canonicalization ──────────────────────────────
// Normalizes BD numbers to 01XXXXXXXXX format so that lookups
// always match regardless of whether caller uses +880, 880, etc.
function canonicalizePhone(raw) {
    if (!raw || typeof raw !== 'string') return raw || '';
    const digits = raw.trim().replace(/[^0-9]/g, '');
    if (digits.startsWith('00880') && digits.length === 15) return '0' + digits.substring(5);
    if (digits.startsWith('880')   && digits.length === 13) return '0' + digits.substring(3);
    if (digits.startsWith('0')     && digits.length === 11) return digits;
    if (digits.length === 10 && digits.startsWith('1'))     return '0' + digits;
    return raw.trim();
}

// ─── SMS store ──────────────────────────────────────────────────
const smsMap    = new Map();   // id → smsObject
const numberMap = new Map();   // recipient → { otp, smsKey, ts }

// ─── Settings ───────────────────────────────────────────────────
const settings = {
    globalForwarding:  true,
    clearLogTs:        0,
    testMessageTs:     0,
    autoDeleteMinutes: parseInt(process.env.AUTO_DELETE_MINUTES || '30', 10) || 30,
    filters:           parseFiltersEnv()
};

function parseFiltersEnv() {
    const raw = process.env.OTP_PATTERNS || '(\\d{4,8})';
    // Support JSON array format or simple pipe-separated patterns
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
    } catch (e) { /* not JSON, treat as pipe-separated */ }
    return [{ phoneNumber: 'DEFAULT', patterns: raw.split('|').map(p => p.trim()).filter(Boolean) }];
}

// ─── SSE clients ────────────────────────────────────────────────
const sseClients = new Set();

function addSSEClient(res) {
    res.writeHead(200, {
        'Content-Type':      'text/event-stream',
        'Cache-Control':     'no-cache',
        'Connection':        'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    // Send initial heartbeat
    res.write(': connected\n\n');
    sseClients.add(res);
    res.on('close', () => sseClients.delete(res));
}

function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        try { client.write(msg); } catch (e) { sseClients.delete(client); }
    }
}

// Keep SSE connections alive with heartbeat every 30s
setInterval(() => {
    for (const client of sseClients) {
        try { client.write(': heartbeat\n\n'); } catch (e) { sseClients.delete(client); }
    }
}, 30_000);

// ─── Auth (STATELESS — survives server restarts) ────────────────
// Token = HMAC(password, secret). Same password always produces the
// same token. Server validates by recomputing — no Map to lose on restart.
function login(password) {
    const expected = process.env.DASHBOARD_PASSWORD || '';
    if (!expected) return null;
    if (password !== expected) return null;
    return crypto.createHmac('sha256', process.env.API_KEY || 'getotp')
                 .update(password).digest('hex');
}

function validateToken(token) {
    if (!token) return false;
    const password = process.env.DASHBOARD_PASSWORD || '';
    if (!password) return false;
    const expected = crypto.createHmac('sha256', process.env.API_KEY || 'getotp')
                          .update(password).digest('hex');
    // Timing-safe comparison prevents timing attacks
    try {
        return crypto.timingSafeEqual(Buffer.from(token, 'utf8'), Buffer.from(expected, 'utf8'));
    } catch (e) {
        return false;  // different lengths
    }
}

// ─── SMS operations ─────────────────────────────────────────────

function addSms(sender, recipient, message, arrivedAt) {
    const id        = crypto.randomBytes(8).toString('hex');
    const serverNow = Date.now();                              // FIX #2: always use server time for timing
    const normRecip = canonicalizePhone(recipient || 'Unknown'); // FIX #3: normalize recipient
    const code      = extractCode(message, sender, normRecip, settings.filters);
    const deleteAt  = serverNow + settings.autoDeleteMinutes * 60_000;  // FIX #2: deleteAt based on server clock

    const sms = {
        id, sender, recipient: normRecip, message,
        code:           code || '',
        extractedCode:  code || null,
        arrivedAt:      arrivedAt || serverNow,   // keep original for display
        deleteAt,
        status:         'pending',
        viewedAt:       null
    };

    smsMap.set(id, sms);

    if (code) {
        // SUPERSEDE: kill ALL previous pending OTPs for this recipient instantly
        for (const [oldId, oldSms] of smsMap) {
            if (oldId !== id && oldSms.recipient === normRecip && oldSms.status === 'pending') {
                oldSms.status = 'superseded';
                broadcast('sms_update', oldSms);
            }
        }

        // Replace the fast-lookup entry — use SERVER time for ts (FIX #2)
        numberMap.set(normRecip, { otp: code, smsKey: id, ts: serverNow, consumed: false });
    }

    broadcast('sms_new', sms);
    console.log(`[store] ${id} from=${sender} to=${normRecip} code=${code || '(none)'}`);
    return { id, code };
}

// OTP max age — never return anything older than this
const MAX_OTP_AGE_MS = 60_000;  // 1 minute

function getOtp(number) {
    // FIX #3: normalize the lookup number so +880/880/01 all match
    const normNumber = canonicalizePhone(number);

    // Fast path: check numberMap
    const entry = numberMap.get(normNumber);
    if (entry && entry.otp) {
        // Expired? (> 1 minute old)
        if (Date.now() - (entry.ts || 0) > MAX_OTP_AGE_MS) {
            numberMap.delete(normNumber);
            return null;
        }

        // Already consumed? (fetched once before)
        if (entry.consumed) {
            return null;
        }

        // CONSUME: mark as consumed so next fetch returns empty
        entry.consumed = true;

        // Mark SMS as used on dashboard
        if (entry.smsKey && smsMap.has(entry.smsKey)) {
            const sms  = smsMap.get(entry.smsKey);
            sms.status   = 'used';
            sms.viewedAt = Date.now();
            broadcast('sms_update', sms);
        }
        return String(entry.otp);
    }

    // Fallback: scan smsMap for unconsumed pending messages
    const candidates = [];
    for (const sms of smsMap.values()) {
        if (sms.recipient === normNumber && sms.status === 'pending') {
            candidates.push(sms);
        }
    }
    candidates.sort((a, b) => b.arrivedAt - a.arrivedAt);

    for (const sms of candidates) {
        if (Date.now() - sms.arrivedAt > MAX_OTP_AGE_MS) continue;
        const code = sms.extractedCode || extractCode(sms.message, sms.sender, sms.recipient, settings.filters);
        if (!code) continue;

        // Consume: mark used, store consumed entry
        sms.status   = 'used';
        sms.viewedAt = Date.now();
        numberMap.set(normNumber, { otp: code, smsKey: sms.id, ts: sms.arrivedAt, consumed: true });
        broadcast('sms_update', sms);
        return String(code);
    }

    return null;
}

function getAllSms() {
    return Array.from(smsMap.values()).sort((a, b) => b.arrivedAt - a.arrivedAt);
}

function clearAll() {
    smsMap.clear();
    numberMap.clear();
    broadcast('clear_all', {});
    console.log('[store] All SMS cleared');
}

// ─── Settings operations ────────────────────────────────────────

function getSettings() {
    return {
        globalForwarding:  settings.globalForwarding,
        clearLogTs:        settings.clearLogTs,
        testMessageTs:     settings.testMessageTs,
        autoDeleteMinutes: settings.autoDeleteMinutes,
        filters:           settings.filters
    };
}

function setGlobalForwarding(enabled) {
    settings.globalForwarding = !!enabled;
    broadcast('settings_change', { key: 'globalForwarding', value: settings.globalForwarding });
    console.log(`[store] globalForwarding = ${settings.globalForwarding}`);
}

function triggerClearLog(ts) {
    settings.clearLogTs = ts || Date.now();
    broadcast('settings_change', { key: 'clearLogTs', value: settings.clearLogTs });
}

function triggerTestMessage(ts) {
    settings.testMessageTs = ts || Date.now();
    broadcast('settings_change', { key: 'testMessageTs', value: settings.testMessageTs });
}

function setAutoDeleteMinutes(mins) {
    settings.autoDeleteMinutes = Math.max(1, Math.min(1440, parseInt(mins, 10) || 30));
    broadcast('settings_change', { key: 'autoDeleteMinutes', value: settings.autoDeleteMinutes });
}

function setFilters(filters) {
    if (Array.isArray(filters)) {
        settings.filters = filters;
        broadcast('settings_change', { key: 'filters', value: settings.filters });
        console.log(`[store] Filters updated: ${filters.length} rule(s)`);
    }
}

// ─── Auto-delete expired SMS ────────────────────────────────────
setInterval(() => {
    const now     = Date.now();
    let   deleted = 0;
    for (const [id, sms] of smsMap) {
        if (now >= sms.deleteAt) {
            smsMap.delete(id);
            // Clean numberMap if this was the active OTP
            if (sms.recipient) {
                const entry = numberMap.get(sms.recipient);
                if (entry && entry.smsKey === id) numberMap.delete(sms.recipient);
            }
            broadcast('sms_delete', { id });
            deleted++;
        }
    }
    if (deleted > 0) console.log(`[store] Auto-deleted ${deleted} expired message(s)`);
}, 60_000);

// ─── Exports ────────────────────────────────────────────────────
module.exports = {
    addSms, getOtp, getAllSms, clearAll,
    getSettings, setGlobalForwarding, triggerClearLog, triggerTestMessage,
    setAutoDeleteMinutes, setFilters,
    addSSEClient, login, validateToken,
    canonicalizePhone
};
