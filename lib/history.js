/**
 * lib/history.js — the SMS archive.
 *
 * =============================================================================
 * NOTHING HERE RUNS WHILE A MESSAGE IS ALIVE
 *
 * A message is queued for the archive only once it is FINISHED — fetched,
 * superseded, expired, or swept. By then nothing is waiting on it, no fetch can
 * be racing it, and — the part that makes this design work — its OUTCOME IS
 * ALREADY KNOWN.
 *
 * That is why there is one write per message and never an update. The obvious
 * design (write on arrival, update when consumed) needs two Firestore round
 * trips per SMS, puts the first one on the live path, and leaves rows reading
 * "unknown" whenever the second is lost. Deferring removes all three problems
 * at once.
 *
 * The flush runs on a 30-second timer, matching the app's poll interval and the
 * SSE heartbeat so there is one cadence in the system rather than three. A pass
 * with nothing to write makes NO Firestore call at all — same idea as
 * QueueFlusher.stats() on the phone: check cheaply, act only when there is
 * something to act on.
 *
 * ACCEPTED, AND STATED PLAINLY: a restart can lose up to 30 seconds of HISTORY.
 * Never an OTP. Those were delivered and used long before the archive sees them.
 * Closing that window would mean writing on arrival, which is exactly what must
 * not happen.
 * =============================================================================
 */

const firestore = require('./firestore');

const COLLECTION = 'getotp_history';

/** Matches the app poll and the SSE heartbeat — one cadence, not three. */
const FLUSH_INTERVAL_MS = 30_000;

/** Bounded, so a Firestore outage cannot grow the queue without limit. */
const MAX_QUEUE = 2000;

/** Firestore's batch ceiling is 500; stay under it with room to spare. */
const BATCH_SIZE = 400;

const queue = [];
let dropped = 0;
let written = 0;
let lastFlushAt = 0;
let lastError = null;
let timer = null;

function enabled() {
    const v = String(process.env.HISTORY_ENABLED || '').trim().toLowerCase();
    return (v === 'true' || v === '1' || v === 'yes') && firestore.isEnabled();
}

/**
 * File a finished message.
 *
 * @param {object} sms      the stored message
 * @param {string} outcome  fetched | superseded | expired | no_code
 *
 * OUTCOME IS THE POINT OF THIS WHOLE FEATURE. Today these three failures look
 * identical from the dashboard:
 *
 *   - the SMS never arrived at all
 *   - it arrived and no filter matched it
 *   - it arrived, a code was extracted, and nobody ever fetched it
 *
 * The store knows which of the three happened at the moment the message
 * finishes. Recording it costs nothing and is the difference between "the OTP
 * did not come" and an actual answer.
 */
/** Sender used by the Test button. Never a real OTP, never archived. */
const TEST_SENDER = 'GetOTP-Test';

function record(sms, outcome) {
    if (!enabled() || !sms) return;

    // A test message is something the system invented to prove a path works.
    // Archiving it pollutes the outcome counts the History tab exists to show —
    // a run of tests while chasing a problem would depress the fetch rate,
    // which is the one number meant to tell you the system is healthy.
    if (String(sms.sender || '') === TEST_SENDER) return;

    if (queue.length >= MAX_QUEUE) {
        // Counted here and reported by the next successful flush — logging on
        // every dropped message would itself become the flood. (The old comment
        // claimed this was "throttled logging"; nothing logged here at all.)
        dropped++;
        return;
    }
    queue.push({
        smsId:       sms.id,
        userId:      sms.userId || 'admin',
        deviceId:    sms.deviceId || null,
        deviceLabel: sms.deviceLabel || null,
        sender:      String(sms.sender || ''),
        recipient:   String(sms.recipient || ''),
        message:     String(sms.message || ''),
        code:        sms.extractedCode || null,
        outcome:     outcome,
        receivedAt:  sms.receivedAt,
        arrivedAt:   sms.arrivedAt,
        finishedAt:  Date.now(),
        // Firestore TTL deletes on this field with no read cost, so the
        // collection cannot grow without bound and you are not paying attention
        // to it. Configurable; 90 days by default.
        expireAt:    new Date(Date.now() + retentionDays() * 86400_000)
    });
}

function retentionDays() {
    const raw = parseInt(process.env.HISTORY_RETENTION_DAYS || '90', 10);
    return Math.max(1, Math.min(3650, raw || 90));
}

/**
 * Write whatever has finished since the last pass.
 *
 * Never throws: a failure leaves the entries queued for the next attempt, and
 * the caller is a timer with nowhere to report to.
 */
async function flush() {
    if (!enabled() || queue.length === 0) return 0;

    const batch = queue.splice(0, BATCH_SIZE);
    lastFlushAt = Date.now();

    try {
        await firestore.writeHistory(COLLECTION, batch);
        written += batch.length;
        lastError = null;
        if (dropped > 0) {
            console.warn(`[history] ${dropped} entr(ies) dropped while the queue was full`);
            dropped = 0;
        }
        return batch.length;
    } catch (e) {
        // Put them back at the FRONT: history is only useful in order, and
        // losing the oldest first is the wrong end to lose.
        queue.unshift(...batch);
        lastError = firestore.explain(e.message);
        console.error(`[history] Flush failed, ${queue.length} queued — ${lastError}`);
        return 0;
    }
}

function start() {
    if (timer) return;
    timer = setInterval(() => { flush().catch(() => {}); }, FLUSH_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    if (enabled()) {
        console.log(`[history] Archive on — flushing every ${FLUSH_INTERVAL_MS / 1000}s, `
            + `${retentionDays()}-day retention`);
    }
}

function stats() {
    return {
        enabled: enabled(),
        queued: queue.length,
        written,
        dropped,
        lastFlushAt,
        lastError,
        retentionDays: retentionDays(),
        flushSeconds: FLUSH_INTERVAL_MS / 1000
    };
}

module.exports = {
    record, flush, start, stats, enabled, retentionDays, TEST_SENDER,
    COLLECTION, FLUSH_INTERVAL_MS, MAX_QUEUE, BATCH_SIZE
};
