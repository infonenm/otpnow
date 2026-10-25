'use strict';
/**
 * lib/firebase.js — the ONE Firebase app for this process (server 4.44.0).
 *
 * =============================================================================
 * firebase-admin 14 REMOVED THE LEGACY NAMESPACE (`admin.initializeApp`,
 * `admin.credential.cert`, `admin.apps`, `admin.messaging()`,
 * `admin.firestore()`). Everything goes through the modular entry points:
 *     firebase-admin/app · firebase-admin/messaging · firebase-admin/firestore
 * It also requires Node 22+ (package.json engines).
 *
 * One initialiser, shared by fcm.js and firestore.js, so neither depends on
 * running first — the rule test/guards.test.js §4 has pinned since a second
 * initializeApp() silently disabled FCM for the whole process (the throw landed
 * in fcm.init's catch, and "the toggle takes 30 s" was the only symptom).
 * =============================================================================
 */

/** The default app, created on first use from FIREBASE_SERVICE_ACCOUNT. Throws if it cannot be. */
function app() {
    const { initializeApp, getApps, getApp, cert } = require('firebase-admin/app');
    if (getApps().length) return getApp();
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
    return initializeApp({ credential: cert(JSON.parse(raw)) });
}

function messaging() { return require('firebase-admin/messaging').getMessaging(app()); }
function firestore() { return require('firebase-admin/firestore').getFirestore(app()); }

module.exports = { app, messaging, firestore };
