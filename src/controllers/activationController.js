// ─── Existing-customer portal activation ────────────────────────────────────
//
// For people who are already Relux customers — typically walk-ins whose orders
// were created at the counter — and want to use the portal. They have no
// password, so they prove who they are with a one-time code instead, then set
// one. The portal account is attached to their EXISTING customer record; no
// second customer is ever created.
//
//   POST /auth/activation/start     { identifier }            → code emailed
//   POST /auth/activation/verify    { identifier, code }      → activation token
//   POST /auth/activation/complete  { token, password, ... }  → signed in
//
// Verification is by EMAIL only. There is no working SMS integration, so a
// phone number is accepted to FIND the record but the code always goes to the
// email address already on that record. A walk-in with no email on file cannot
// self-activate until staff add one in person.
//
// Protections:
//   • Anti-enumeration — /start answers identically whether or not anything
//     matched, and never says what (or how much) history exists.
//   • Codes from crypto.randomInt, stored only as an HMAC, 10-minute expiry,
//     single-use, at most 5 attempts per code, at most 5 codes per hour.
//   • Deactivated customers and already-activated records can never be claimed.
//   • Every step is audit-logged; codes, tokens and passwords never are.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Customer = require('../models/Customer.js');
const CustomerActivation = require('../models/CustomerActivation.js');
const User = require('../models/User.js');
const Order = require('../models/Order.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');
const sendEmail = require('../utils/sendEmail.js');
const logger = require('../utils/logger.js');
const { logAudit } = require('../utils/auditLogger.js');
const { sendTokenResponse } = require('../utils/helpers.js');
const {
  normalizeEmail, phoneVariants, maskPhone,
} = require('../utils/customerIdentity.js');

const CODE_TTL_MS        = 10 * 60 * 1000;
const TOKEN_TTL          = '15m';
const MAX_ATTEMPTS       = 5;
const MAX_CODES_PER_HOUR = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;

const GENERIC_START_MESSAGE =
  "If we find a Relux customer record with an email address on file that matches, " +
  "we've sent a 6-digit code to that email. It expires in 10 minutes.";
const GENERIC_CODE_ERROR = 'That code is invalid or has expired. Request a new one and try again.';

const hashCode = (activationId, code) =>
  crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${activationId}:${code}`).digest('hex');

const safeEqual = (a, b) => {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};

// Resolve the identifier the person typed to a customer record.
async function findCustomerByIdentifier(identifier) {
  if (!identifier || typeof identifier !== 'string') return null;
  const raw = identifier.trim();
  if (raw.includes('@')) {
    const email = normalizeEmail(raw);
    return email ? Customer.findOne({ email }) : null;
  }
  const variants = phoneVariants(raw);
  return variants.length ? Customer.findOne({ phone: { $in: variants } }) : null;
}

// Run fn inside a MongoDB transaction when the deployment supports one
// (Atlas / any replica set). A standalone local mongod does not, so fall back
// to running without a session — the steps below are ordered so a failure
// part-way is compensated rather than left half-registered.
async function withOptionalTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await fn(session); });
    return result;
  } catch (err) {
    const unsupported = err.code === 20 || /replica set|Transaction numbers/i.test(err.message || '');
    if (!unsupported) throw err;
    logger.warn('[activation] Transactions unavailable — running without a session');
    return fn(null);
  } finally {
    session.endSession();
  }
}

// @desc    Start activation — email a one-time code
// @route   POST /api/v1/auth/activation/start
// @access  Public (rate-limited)
exports.startActivation = asyncHandler(async (req, res) => {
  const genericReply = () => res.status(200).json({ success: true, message: GENERIC_START_MESSAGE, data: {} });

  const customer = await findCustomerByIdentifier(req.body?.identifier);

  // Every branch below ends in the same reply. Email sending is not awaited, so
  // response time does not reveal whether anything matched.
  if (!customer || customer.status === 'suspended' || !customer.email) return genericReply();

  const existingUser = await User.findOne({ customerId: customer._id }).select('_id').lean();
  if (existingUser) {
    // Already activated: tell the owner (at their own inbox), not the requester.
    sendEmail({
      to: customer.email,
      subject: 'Your Relux Laundry account is already active',
      html: `<p>Hi ${customer.name || 'there'},</p><p>Someone asked to activate a Relux Laundry account with your details, but your account is already active. Sign in with your password, or use "Forgot password" to reset it.</p><p>If this wasn't you, you can ignore this email.</p>`,
    }).catch((e) => logger.error(`[activation] notice email failed: ${e.message}`));
    return genericReply();
  }

  // Throttle per customer, independent of IP address.
  const recent = await CustomerActivation.find({
    customerId: customer._id,
    createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
  }).sort('-createdAt').select('createdAt').lean();
  if (recent.length >= MAX_CODES_PER_HOUR) return genericReply();
  if (recent[0] && Date.now() - new Date(recent[0].createdAt).getTime() < RESEND_COOLDOWN_MS) return genericReply();

  // A new code retires any earlier unused one.
  await CustomerActivation.updateMany(
    { customerId: customer._id, usedAt: null, verifiedAt: null },
    { $set: { expiresAt: new Date() } }
  );

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const activation = new CustomerActivation({
    customerId: customer._id,
    channel: 'email',
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
    requestIp: req.ip,
    codeHash: 'pending',
  });
  activation.codeHash = hashCode(activation._id, code);
  await activation.save();

  sendEmail({
    to: customer.email,
    subject: 'Your Relux Laundry activation code',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px;">
        <h2 style="color:#1d4ed8;margin-bottom:8px;">Relux Laundry</h2>
        <h3>Activate your account</h3>
        <p>Hi ${customer.name || 'there'},</p>
        <p>Use this code to activate your Relux Laundry account. It expires in <strong>10 minutes</strong>.</p>
        <div style="text-align:center;margin:32px 0;">
          <span style="font-size:36px;font-weight:bold;letter-spacing:10px;color:#1d4ed8;">${code}</span>
        </div>
        <p>If you didn't ask for this, ignore this email — nothing changes without the code.</p>
      </div>`,
  }).catch((e) => logger.error(`[activation] code email failed for ${customer._id}: ${e.message}`));

  await logAudit({
    action: 'CUSTOMER_ACCOUNT_ACTIVATION_STARTED',
    targetType: 'Customer',
    targetId: customer._id.toString(),
    metadata: { channel: 'email', ip: req.ip },
  });

  return res.status(200).json({
    success: true,
    message: GENERIC_START_MESSAGE,
    data: process.env.NODE_ENV === 'development' ? { devCode: code } : {},
  });
});

// @desc    Verify the code — returns a short-lived activation token
// @route   POST /api/v1/auth/activation/verify
// @access  Public (rate-limited)
exports.verifyActivation = asyncHandler(async (req, res, next) => {
  const code = String(req.body?.code || '').trim();
  if (!/^\d{6}$/.test(code)) return next(new AppError(GENERIC_CODE_ERROR, 400));

  const customer = await findCustomerByIdentifier(req.body?.identifier);
  if (!customer || customer.status === 'suspended') return next(new AppError(GENERIC_CODE_ERROR, 400));

  const pending = await CustomerActivation.findOne({
    customerId: customer._id, usedAt: null, verifiedAt: null, expiresAt: { $gt: new Date() },
  }).sort('-createdAt');
  if (!pending) return next(new AppError(GENERIC_CODE_ERROR, 400));

  // Count the attempt atomically before comparing, so parallel guesses cannot
  // share one attempt.
  const counted = await CustomerActivation.findOneAndUpdate(
    { _id: pending._id, attempts: { $lt: MAX_ATTEMPTS } },
    { $inc: { attempts: 1 } },
    { new: true }
  );
  if (!counted) {
    await CustomerActivation.updateOne({ _id: pending._id }, { $set: { expiresAt: new Date() } });
    return next(new AppError('Too many incorrect attempts. Request a new code.', 429));
  }

  if (!safeEqual(counted.codeHash, hashCode(counted._id, code))) {
    return next(new AppError(GENERIC_CODE_ERROR, 400));
  }

  const verified = await CustomerActivation.findOneAndUpdate(
    { _id: counted._id, verifiedAt: null },
    { $set: { verifiedAt: new Date() } },
    { new: true }
  );
  if (!verified) return next(new AppError(GENERIC_CODE_ERROR, 400));

  await logAudit({
    action: 'CUSTOMER_IDENTITY_VERIFIED',
    targetType: 'Customer',
    targetId: customer._id.toString(),
    metadata: { channel: 'email' },
  });

  const token = jwt.sign(
    { purpose: 'customer-activation', aid: String(verified._id), cid: String(customer._id) },
    process.env.JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );

  // Identity is proven, so the person may now see their own record's details.
  const orderCount = await Order.countDocuments({ customerId: customer._id });
  res.status(200).json({
    success: true,
    message: 'Verified. Finish setting up your account.',
    data: {
      activationToken: token,
      profile: {
        name: customer.name,
        email: customer.email,
        phone: customer.phone ? maskPhone(customer.phone) : null,
        hasPhone: !!customer.phone,
        orderCount,
      },
    },
  });
});

// @desc    Complete activation — create the portal account on the existing record
// @route   POST /api/v1/auth/activation/complete
// @access  Public (requires activation token)
exports.completeActivation = asyncHandler(async (req, res, next) => {
  const { activationToken, password } = req.body || {};

  let claims;
  try {
    claims = jwt.verify(activationToken, process.env.JWT_SECRET);
  } catch {
    return next(new AppError('Your verification has expired. Start again to get a new code.', 401));
  }
  if (claims?.purpose !== 'customer-activation') {
    return next(new AppError('Invalid activation token', 401));
  }

  if (typeof password !== 'string' || password.length < 8) {
    return next(new AppError('Password must be at least 8 characters', 400));
  }

  const activation = await CustomerActivation.findById(claims.aid);
  if (!activation || String(activation.customerId) !== claims.cid || !activation.verifiedAt || activation.usedAt) {
    return next(new AppError('This activation has already been used or is no longer valid. Start again.', 400));
  }

  const customer = await Customer.findById(claims.cid);
  if (!customer) return next(new AppError('Customer record not found', 404));

  // Deactivated by the business: activation must never restore access.
  if (customer.status === 'suspended') {
    return next(new AppError('This account has been deactivated. Please contact support for assistance.', 403));
  }
  if (await User.exists({ customerId: customer._id })) {
    return next(new AppError('This account is already active. Sign in, or use "Forgot password".', 409));
  }

  const email = normalizeEmail(customer.email);
  if (!email) return next(new AppError('No verified email on this customer record', 400));
  if (await User.exists({ email })) {
    // A separate account already uses this email. Two identities colliding
    // needs a person to resolve, not an automatic merge.
    await Customer.updateOne(
      { _id: customer._id },
      { $set: { needsReview: true, reviewReason: 'activation blocked: email already used by another portal account' } }
    );
    return next(new AppError(
      'An account already uses this email. Sign in, or contact support to link your order history.',
      409
    ));
  }

  // Only the customer's own name is taken from the form, and only to replace
  // the placeholder a walk-in record gets when no name was captured. Email and
  // phone come from the record — trusted historical data is not overwritten.
  const suppliedName = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 100) : '';
  const phone = customer.phone || null;
  const phoneTaken = phone ? await User.exists({ phone }) : false;

  let user;
  try {
    user = await withOptionalTransaction(async (session) => {
      const opts = session ? { session } : {};

      // Claim the activation first: the conditional update is what makes the
      // code single-use even when two completions race.
      const claimed = await CustomerActivation.findOneAndUpdate(
        { _id: activation._id, usedAt: null },
        { $set: { usedAt: new Date() } },
        { new: true, ...opts }
      );
      if (!claimed) throw new AppError('This activation has already been used. Sign in instead.', 409);

      const [created] = await User.create([{
        name: suppliedName || customer.name,
        email,
        phone: phoneTaken ? undefined : (phone || undefined),
        password,
        role: 'customer',
        emailVerified: true,       // proven by the code just now
        isPhoneVerified: false,    // captured at the counter, never verified
        customerId: customer._id,
      }], opts);

      // Every order already on this customer record becomes visible to the new
      // account — walk-in and online alike, whenever they were placed.
      await Order.updateMany(
        { customerId: customer._id, $or: [{ customer: null }, { customer: { $exists: false } }] },
        { $set: { customer: created._id } },
        opts
      );

      const customerUpdate = { status: customer.status === 'guest' ? 'active' : customer.status };
      if (suppliedName && /^walk-in customer$/i.test(customer.name || '')) customerUpdate.name = suppliedName;
      if (phoneTaken) {
        customerUpdate.needsReview = true;
        customerUpdate.reviewReason = 'activated account could not take its phone: another portal account already uses it';
      }
      await Customer.updateOne({ _id: customer._id }, { $set: customerUpdate }, opts);

      return created;
    });
  } catch (err) {
    if (err instanceof AppError) return next(err);
    // Without a transaction, undo whatever landed so the customer is not left
    // half-registered; they can simply start again.
    logger.error(`[activation] complete failed for ${customer._id}: ${err.message}`);
    const partial = await User.findOne({ customerId: customer._id, email }).select('_id').lean().catch(() => null);
    if (partial) {
      await Order.updateMany({ customer: partial._id, customerId: customer._id }, { $unset: { customer: 1 } }).catch(() => {});
      await User.deleteOne({ _id: partial._id }).catch(() => {});
    }
    await CustomerActivation.updateOne({ _id: activation._id }, { $unset: { usedAt: 1 } }).catch(() => {});
    return next(new AppError('Activation could not be completed. Please try again.', 500));
  }

  // Same referral-code format register() gives every new account.
  user.referralCode = `REF-${user._id.toString().slice(-6).toUpperCase()}-${Date.now().toString(36).slice(-3).toUpperCase()}`;
  await user.save({ validateBeforeSave: false });

  const linkedOrders = await Order.countDocuments({ customerId: customer._id, customer: user._id });
  await logAudit({
    actorUserId: user._id,
    action: 'CUSTOMER_ACCOUNT_ACTIVATED',
    targetType: 'Customer',
    targetId: customer._id.toString(),
    metadata: { via: 'existing-customer activation', channel: 'email', ordersLinked: linkedOrders },
  });

  // Signs them in — same response shape as login.
  await sendTokenResponse(user, 201, res);
});

// Exposed for tests.
exports._internal = { hashCode, findCustomerByIdentifier, MAX_ATTEMPTS };
