/**
 * lib/firebase.js — Firebase Admin SDK init
 *
 * Reads FIREBASE_SERVICE_ACCOUNT env var (full JSON string) and
 * FIREBASE_DATABASE_URL. Initializes once, exports the db reference.
 *
 * The Admin SDK maintains a persistent WebSocket to the Realtime
 * Database — no cold-start penalty after the first connect.
 */

const admin = require('firebase-admin');

let db = null;

function initFirebase() {
    if (db) return; // already initialized

    const saRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
    const dbUrl = process.env.FIREBASE_DATABASE_URL;

    if (!saRaw || !dbUrl) {
        console.error('[firebase] FIREBASE_SERVICE_ACCOUNT and FIREBASE_DATABASE_URL must be set');
        process.exit(1);
    }

    let serviceAccount;
    try {
        serviceAccount = JSON.parse(saRaw);
    } catch (e) {
        console.error('[firebase] Failed to parse FIREBASE_SERVICE_ACCOUNT:', e.message);
        process.exit(1);
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: dbUrl
    });

    db = admin.database();
    console.log('[firebase] Admin SDK initialized — DB:', dbUrl);
}

function getDb() {
    if (!db) throw new Error('Firebase not initialized — call initFirebase() first');
    return db;
}

function getAdmin() {
    return admin;
}

module.exports = { initFirebase, getDb, getAdmin };
