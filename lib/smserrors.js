'use strict';
/**
 * smserrors.js — what a failed SMS means, in words (server 4.41.2).
 *
 * The phone reports failures in its own vocabulary:
 *   - "error code N"      Android's SmsManager result code (app 4.36.0 words
 *                         only the 7 most common; everything else arrives raw)
 *   - a refusal reason    the app decided not to send (OutboxSender.refusal)
 *   - "network status 0xNN"  the operator's delivery report (TP-Status)
 *   - "exception"         SmsManager threw
 * The server's own reasons (expired, unknown) are already sentences.
 *
 * Translating HERE rather than in the app means every phone gets the words
 * without a reinstall, and the stored job keeps the raw value for debugging —
 * nothing persisted changes.
 *
 * Android codes: android.telephony.SmsManager, checked against the
 * android-34 android.jar (javap -constants). TP-Status ranges: 3GPP TS 23.040
 * §9.2.3.15 — only the three ranges are used, not individual values.
 *
 * PURE. test/smserrors.test.js.
 */

const CHECK_PHONE = 'check balance and signal on that SIM, then retry';

const ANDROID = {
    1: 'Sending failed (generic) — usually no balance or SMS pack, or the operator refused it',
    2: 'Radio is off on that phone (airplane mode?)',
    3: 'The message could not be encoded',
    4: 'No signal on that SIM',
    5: 'Android\'s SMS sending limit was reached — confirm the prompt on the phone',
    6: 'Blocked by the SIM\'s fixed dialling (FDN) list',
    7: 'Short codes are not allowed from this phone',
    8: 'Short codes are never allowed from this phone',
    9: 'The phone\'s radio was not available — ' + CHECK_PHONE,
    10: 'The network rejected the SMS — ' + CHECK_PHONE,
    11: 'Android rejected the request as invalid',
    12: 'The phone\'s radio was in the wrong state — retry in a minute',
    13: 'The phone ran out of memory while sending',
    14: 'The SMS format was rejected',
    15: 'Android system error while sending — retry',
    16: 'The phone\'s modem reported an error — retry; restart the phone if it repeats',
    17: 'Network error — ' + CHECK_PHONE,
    18: 'The message could not be encoded',
    19: 'Invalid message-centre (SMSC) number on that SIM — check it in the phone\'s Messages settings',
    20: 'The operation is not allowed on that SIM',
    21: 'Android internal error while sending — retry',
    22: 'The phone had no resources free to send — retry',
    23: 'Sending was cancelled on the phone',
    24: 'That SIM or phone does not support this request',
    28: 'Android stopped sending part-way',
    29: 'SMS is blocked during an emergency call',
    30: 'Android retried and still failed — ' + CHECK_PHONE,
    31: 'Android\'s SMS service failed (remote exception) — retry',
    32: 'Android requires a default SMS app on that phone',
    33: 'This Android user is not allowed to send SMS',
    100: 'The phone\'s radio was not available — ' + CHECK_PHONE,
    101: 'The modem asked to retry and gave up — ' + CHECK_PHONE,
    102: 'The network rejected the SMS — ' + CHECK_PHONE,
    103: 'The modem was in the wrong state — retry in a minute',
    104: 'The modem rejected the request as invalid',
    105: 'The modem ran out of memory',
    106: 'The modem is sending too fast (rate limited) — retry in a minute',
    107: 'The modem rejected the SMS format',
    108: 'Modem system error — retry; restart the phone if it repeats',
    109: 'The modem could not encode the message',
    110: 'Invalid message-centre (SMSC) number on that SIM — check it in the phone\'s Messages settings',
    111: 'The modem reported an error — retry; restart the phone if it repeats',
    112: 'Network error from the operator — ' + CHECK_PHONE,
    113: 'Modem internal error — retry; restart the phone if it repeats',
    114: 'The modem does not support this request',
    115: 'The modem was in an invalid state — retry; restart the phone if it repeats',
    116: 'The network was not ready — ' + CHECK_PHONE,
    117: 'The operator does not allow this on that SIM',
    118: 'The modem had no resources free — retry',
    119: 'The modem cancelled the send',
    120: 'No SIM card detected in that slot',
    121: 'Cannot send SMS during a call on this phone — retry after the call',
    122: 'Outgoing SMS is barred on that SIM — contact the operator',
    123: 'Blocked because a call was in progress — retry after the call',
    124: 'The modem reported a generic error — ' + CHECK_PHONE,
    125: 'The modem gave an invalid response — retry',
    128: 'That SIM\'s subscription was not available — check the SIM is enabled',
    129: 'SIM card error — check the SIM',
    126: 'The SIM asked for its PIN2 — the SIM blocks this',
    127: 'The SIM is PUK2-locked — contact the operator',
    130: 'The SIM was in a state that cannot send — restart the phone',
    131: 'The modem had no SMS to acknowledge — retry',
    132: 'The SIM was busy — retry in a minute',
    133: 'The SIM\'s message storage is full — delete SMS on the phone',
    134: 'No active subscription on that SIM — check the SIM is enabled',
    135: 'No mobile network found — check signal on that SIM',
    136: 'The modem was busy — retry in a minute',
    137: 'The modem aborted the send — retry',
    25: 'Bluetooth SMS service not available',
    26: 'Invalid Bluetooth address',
    27: 'Bluetooth disconnected'
};

const REFUSALS = {
    no_permission: 'The app has no permission to send SMS on that phone — open GetOTP on the phone and allow it',
    bad_slot: 'Invalid SIM slot',
    empty_message: 'The message was empty',
    no_sim: 'No SIM card in that slot on the phone',
    sim_unconfirmed: 'The SIM card in that slot changed and its number is not saved yet — save it in the app',
    sim_mismatch: 'The SIM in that slot no longer has this number — save the number in the app',
    too_long: 'Too long for the phone to send (more than 3 parts)',
    no_sms_manager: 'The phone could not open SMS sending for that SIM',
    bad_recipient: 'The phone rejected the recipient number',
    exception: 'The phone\'s SMS service crashed while sending — retry'
};

/**
 * @param {string} raw  the job's stored error
 * @returns {string}    words for people; '' for ''. Unknown input is returned
 *                      unchanged, so a sentence never turns into something worse.
 */
function describe(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    let m = /^error code (-?\d+)$/i.exec(s);
    if (m) {
        const code = Number(m[1]);
        return ANDROID[code] ? `${ANDROID[code]} (Android code ${code})`
                             : `Android send error ${code} — ${CHECK_PHONE}`;
    }
    if (Object.prototype.hasOwnProperty.call(REFUSALS, s)) return REFUSALS[s];
    m = /^network status 0x([0-9a-f]{1,2})$/i.exec(s);
    if (m) {
        const st = parseInt(m[1], 16);
        if (st >= 0x40 && st <= 0x7f) {
            return 'The operator stopped trying to deliver it — usually the recipient\'s phone was '
                 + `off or out of coverage, or the number is not in service (status 0x${m[1].toLowerCase()})`;
        }
        return `The operator reported delivery status 0x${m[1].toLowerCase()}`;
    }
    return s;
}

module.exports = { describe, _ANDROID: ANDROID, _REFUSALS: REFUSALS };
