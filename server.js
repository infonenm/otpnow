/**
 * server.js — GetOTP Render Server v4.5
 *
 * ZERO external dependencies. No Firebase, no Google Sheets, no Cloudflare.
 * Everything runs in-memory on this single Render service.
 *
 * Endpoints:
 *   POST /sms             → Receive SMS from Android app (API key auth)
 *   GET  /get?number=X    → OTP fetch API
 *   GET  /api/settings    → Settings for Android app polling (API key auth)
 *   POST /api/login       → Dashboard login (password → token)
 *   GET  /api/messages    → All current SMS (dashboard token auth)
 *   GET  /api/stream      → SSE real-time stream (dashboard token auth)
 *   POST /api/toggle      → Toggle forwarding (dashboard token auth)
 *   POST /api/clear-log   → Clear forward log on devices (dashboard token auth)
 *   POST /api/test        → Send test message to devices (dashboard token auth)
 *   POST /api/clear-all   → Delete all SMS (dashboard token auth)
 *   POST /api/filters     → Update filter rules (dashboard token auth)
 *   POST /api/auto-delete → Update auto-delete minutes (dashboard token auth)
 *   GET  /api/full-settings→ Full settings for dashboard (dashboard token auth)
 *   GET  /health          → Keepalive
 *   GET  /                → Dashboard
 */

const express = require('express');
const path    = require('path');
const store   = require('./lib/store');
const fcm     = require('./lib/fcm');

// Initialize FCM (silent no-op if FIREBASE_SERVICE_ACCOUNT not set)
fcm.init();

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── CORS ───────────────────────────────────────────────────────
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// ─── Auth middleware ────────────────────────────────────────────

function requireApiKey(req, res, next) {
    const key = req.headers['x-api-key'] || '';
    const expected = process.env.API_KEY || '';
    if (!expected) return next();   // dev mode: no key configured
    if (key !== expected) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

function requireToken(req, res, next) {
    const auth  = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || '');
    if (!store.validateToken(token)) return res.status(401).json({ error: 'Unauthorized' });
    next();
}


// ═════════════════════════════════════════════════════════════════
// ANDROID APP ENDPOINTS
// ═════════════════════════════════════════════════════════════════

// 1. RECEIVE SMS — from RenderForwarder on Android
app.post('/sms', requireApiKey, (req, res) => {
    const { sender, recipient, message, arrivedAt } = req.body || {};
    if (!sender || !message) {
        return res.status(400).json({ error: 'Missing sender or message' });
    }
    const result = store.addSms(sender, recipient || 'Unknown', message, arrivedAt || Date.now());
    res.json({ success: true, id: result.id, code: result.code || null });
});

// 2. OTP FETCH API — replaces Cloudflare Worker + Apps Script 2
app.get('/get', (req, res) => {
    const number = req.query.number;
    if (!number) return res.json({ success: false, otp: '', error: 'Missing number' });
    const otp = store.getOtp(number);
    if (otp) return res.json({ success: true, otp });
    return res.json({ success: false, otp: '' });
});

// 3. SETTINGS FOR APP POLLING — replaces Firebase RTDB listeners
app.get('/api/settings', requireApiKey, (req, res) => {
    const s = store.getSettings();
    res.json({
        globalForwarding: s.globalForwarding,
        clearLogTs:       s.clearLogTs,
        testMessageTs:    s.testMessageTs
    });
});


// ═════════════════════════════════════════════════════════════════
// DASHBOARD ENDPOINTS
// ═════════════════════════════════════════════════════════════════

// Login — password from env var, returns session token
app.post('/api/login', (req, res) => {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'Missing password' });
    const token = store.login(password);
    if (!token) return res.status(401).json({ error: 'Wrong password' });
    res.json({ token });
});

// All current messages
app.get('/api/messages', requireToken, (req, res) => {
    res.json({ messages: store.getAllSms() });
});

// SSE real-time stream
app.get('/api/stream', requireToken, (req, res) => {
    store.addSSEClient(res);
});

// Toggle forwarding
app.post('/api/toggle', requireToken, (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
    store.setGlobalForwarding(enabled);
    // FCM: instantly wake the app (even if killed)
    fcm.send(enabled ? 'enable' : 'disable');
    res.json({ success: true, globalForwarding: enabled });
});

// Clear forward log on devices
app.post('/api/clear-log', requireToken, (req, res) => {
    store.triggerClearLog();
    fcm.send('clear_log');
    res.json({ success: true });
});

// Send test message to devices
app.post('/api/test', requireToken, (req, res) => {
    store.triggerTestMessage();
    fcm.send('test');
    res.json({ success: true });
});

// Clear all SMS from server
app.post('/api/clear-all', requireToken, (req, res) => {
    store.clearAll();
    res.json({ success: true });
});

// Update filters
app.post('/api/filters', requireToken, (req, res) => {
    const { filters } = req.body || {};
    if (!Array.isArray(filters)) return res.status(400).json({ error: 'filters must be an array' });
    store.setFilters(filters);
    res.json({ success: true });
});

// Update auto-delete minutes
app.post('/api/auto-delete', requireToken, (req, res) => {
    const { minutes } = req.body || {};
    if (typeof minutes !== 'number') return res.status(400).json({ error: 'minutes must be a number' });
    store.setAutoDeleteMinutes(minutes);
    res.json({ success: true });
});

// Full settings (for dashboard settings panel)
app.get('/api/full-settings', requireToken, (req, res) => {
    res.json(store.getSettings());
});


// ═════════════════════════════════════════════════════════════════
// HEALTH
// ═════════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() | 0 });
});


// ─── Start server ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[server] GetOTP Render v4.5 on port ${PORT}`);
    console.log(`[server] POST /sms           — receive SMS`);
    console.log(`[server] GET  /get           — OTP fetch`);
    console.log(`[server] GET  /api/settings  — app polling`);
    console.log(`[server] GET  /api/stream    — SSE dashboard`);
    console.log(`[server] GET  /              — dashboard`);
    console.log(`[server] GET  /health        — keepalive`);
});
