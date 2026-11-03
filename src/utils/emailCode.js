// ─── One-time codes sent by email (signup verification, password reset) ─────
//
// Why this exists: a code in a customer's inbox kept being rejected. Every
// "resend" — including one the app fired silently whenever an unverified
// customer tried to sign in — replaced the code, so the one they were reading
// was already dead. Signup and password-reset codes also shared one slot, and
// every failure said only "invalid or expired".
//
// Rules now:
//   • One active code per account, bound to a PURPOSE and the email address.
//   • Stored only as an HMAC (legacy plaintext codes issued before this change
//     are still accepted until they expire — at most 15 minutes).
//   • Issuing is a single atomic update with a cooldown, so concurrent resends
//     can't leave an email holding a code the database no longer has.
//   • `onlyIfNoActive` re-sends nothing while a usable code exists, so a
//     convenience resend never kills the code the customer already has.
//   • Checking says WHY a code failed (incorrect / replaced / expired / used),
//     counts attempts per account, and consumes the code atomically.
// Codes are never logged or returned.

const crypto = require('crypto');
const os = require('os');
const User = require('../models/User.js');
const logger = require('./logger.js');

const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;
// A code with less than this left counts as "about to expire": a convenience
// resend may replace it.
const MIN_USEFUL_LIFE_MS = 2 * 60 * 1000;
const PURPOSES = ['verify_email', 'reset_password', 'phone'];

const normEmail = (e) => String(e || '').trim().toLowerCase();
const normCode = (c) => String(c ?? '').replace(/\s+/g, '');
const hashCode = (purpose, email, code) =>
  'h1:' + crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${purpose}:${normEmail(email)}:${code}`).digest('hex');

const safeEqual = (a, b) => {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};

// Stored value matches the typed code? Hashed codes, or a legacy plaintext one.
function matches(stored, purpose, email, code) {
  if (!stored) return false;
  return stored.startsWith('h1:') ? safeEqual(stored, hashCode(purpose, email, code)) : safeEqual(stored, code);
}

/**
 * Issue a code for the account with this email. Returns
 *   { issued: true, code, user }   — caller emails `code` to user.email
 *   { issued: false, reason }      — 'no_account' | 'cooldown' | 'active_code'
 */
async function issueCode({ email, purpose, ttlMs, extraFilter = {}, onlyIfNoActive = false }) {
  if (!PURPOSES.includes(purpose)) throw new Error(`unknown code purpose ${purpose}`);
  const now = Date.now();
  const address = normEmail(email);
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

  const conditions = [
    { email: address, ...extraFilter },
    // Cooldown: concurrent or rapid requests can't race each other.
    { $or: [{ otpSentAt: null }, { otpSentAt: { $lte: new Date(now - RESEND_COOLDOWN_MS) } }] },
  ];
  if (onlyIfNoActive) {
    conditions.push({
      $or: [
        { otp: null },
        { otpPurpose: { $ne: purpose } },
        { otpExpires: { $lte: new Date(now + MIN_USEFUL_LIFE_MS) } },
        { otpAttempts: { $gte: MAX_ATTEMPTS } },
      ],
    });
  }

  // Read the current code first so a replaced code can be recognised later.
  const current = await User.findOne({ email: address }).select('otp otpPurpose').lean();
  const previous = current?.otp && current.otpPurpose === purpose ? current.otp : null;

  const user = await User.findOneAndUpdate(
    { $and: conditions },
    {
      $set: {
        otp: hashCode(purpose, address, code),
        otpPurpose: purpose,
        otpExpires: new Date(now + ttlMs),
        otpSentAt: new Date(now),
        otpAttempts: 0,
        ...(previous ? { otpPrevious: previous } : {}),
      },
      ...(previous ? {} : { $unset: { otpPrevious: 1 } }),
    },
    { new: true }
  );

  if (!user) {
    const exists = await User.findOne({ email: address, ...extraFilter }).select('otpSentAt').lean();
    const reason = !exists ? 'no_account'
      : exists.otpSentAt && now - new Date(exists.otpSentAt).getTime() < RESEND_COOLDOWN_MS ? 'cooldown' : 'active_code';
    logger.info('[email-code] not issued', { purpose, reason, userId: exists?._id, instance: os.hostname() });
    return { issued: false, reason };
  }
  logger.info('[email-code] issued', { purpose, userId: user._id, expiresAt: user.otpExpires, instance: os.hostname() });
  return { issued: true, code, user };
}

/** Email delivery failed: let the customer retry straight away (no cooldown). */
async function releaseCooldown(userId) {
  await User.updateOne({ _id: userId }, { $unset: { otpSentAt: 1 } }).catch(() => {});
}

/**
 * Check and CONSUME a code. `consumeSet` is applied in the same atomic update
 * that clears the code (e.g. { emailVerified: true }), so two simultaneous
 * submissions can't both succeed. Returns { ok: true, userId } or
 * { ok: false, reason } — 'incorrect' | 'superseded' | 'expired' | 'locked' |
 * 'no_code' | 'used'.
 */
async function checkCode({ email, code, purpose, consumeSet = {} }) {
  const address = normEmail(email);
  const typed = normCode(code);
  const doc = await User.findOne({ email: address })
    .select('otp otpPurpose otpExpires otpAttempts otpPrevious emailVerified').lean();
  const log = (result) => logger.info('[email-code] check', {
    purpose, result, userId: doc?._id, found: !!doc?.otp, expiresAt: doc?.otpExpires, attempts: doc?.otpAttempts, instance: os.hostname(),
  });

  if (!/^\d{6}$/.test(typed)) { log('malformed'); return { ok: false, reason: 'incorrect' }; }
  if (!doc) { log('no_account'); return { ok: false, reason: 'no_code' }; }
  // A legacy code (issued before purposes existed) is accepted for its one use.
  const purposeOk = !doc.otpPurpose || doc.otpPurpose === purpose;
  if (!doc.otp || !purposeOk) {
    const reason = purpose === 'verify_email' && doc.emailVerified ? 'used' : 'no_code';
    log(reason); return { ok: false, reason };
  }
  if ((doc.otpAttempts || 0) >= MAX_ATTEMPTS) { log('locked'); return { ok: false, reason: 'locked' }; }
  if (!doc.otpExpires || new Date(doc.otpExpires).getTime() <= Date.now()) { log('expired'); return { ok: false, reason: 'expired' }; }

  // Count the attempt BEFORE comparing, conditional on the same code still
  // being active, so parallel guesses can't share one attempt.
  const counted = await User.findOneAndUpdate(
    { _id: doc._id, otp: doc.otp, $or: [{ otpAttempts: null }, { otpAttempts: { $lt: MAX_ATTEMPTS } }] },
    { $inc: { otpAttempts: 1 } },
    { new: true, projection: { otpAttempts: 1 } }
  ).lean();
  if (!counted) { log('raced'); return { ok: false, reason: 'no_code' }; }

  if (!matches(doc.otp, purpose, address, typed)) {
    const reason = doc.otpPrevious && matches(doc.otpPrevious, purpose, address, typed) ? 'superseded' : 'incorrect';
    log(reason);
    return { ok: false, reason: counted.otpAttempts >= MAX_ATTEMPTS ? 'locked' : reason, attemptsLeft: MAX_ATTEMPTS - counted.otpAttempts };
  }

  const consumed = await User.findOneAndUpdate(
    { _id: doc._id, otp: doc.otp },
    {
      $set: { otpAttempts: 0, ...consumeSet },
      $unset: { otp: 1, otpExpires: 1, otpPurpose: 1, otpPrevious: 1, otpSentAt: 1 },
    },
    { new: true, projection: { _id: 1 } }
  ).lean();
  if (!consumed) { log('used'); return { ok: false, reason: 'used' }; }
  log('ok');
  return { ok: true, userId: consumed._id };
}

// What the customer is told. None of these reveal whether some OTHER email has
// an account: 'no_code' reads the same for an unknown email and a used code.
const MESSAGES = {
  incorrect: 'The verification code is incorrect. Please check the code and try again.',
  superseded: 'That code was replaced by a newer one. Please use the code from the most recent email.',
  expired: 'Your verification code has expired. Please request a new one.',
  locked: 'Too many incorrect attempts. Please request a new code.',
  no_code: 'This code is no longer valid. Please request a new code.',
  used: 'This verification code has already been used. If your email is verified, please sign in.',
};

module.exports = {
  issueCode, checkCode, releaseCooldown, hashCode, MESSAGES, MAX_ATTEMPTS, RESEND_COOLDOWN_MS,
};
