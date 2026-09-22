// ─── Customer identity — one definition, used everywhere ────────────────────
//
// Relux has two separate things that used to be treated as one:
//
//   Customer  (the business record)  — collection `customers`. Wallets, loyalty
//                                      and order.customerId all point here.
//   User      (the portal account)   — collection `users`, role 'customer',
//                                      linked through user.customerId.
//
// A person is a customer once an order exists for them, whether or not they
// ever open a portal account. Orders belong to the Customer record.
//
// Identity rules:
//   • Automatic matching uses normalized phone and email only — never name.
//   • A portal account is linked to a customer record ONLY through a verified
//     identifier. Unverified identifiers never grant access to history: that
//     was how registering with someone else's phone handed over their orders,
//     wallet and points.
//   • When phone and email point to two different records, nothing is chosen
//     automatically. It is surfaced as a conflict for a person to resolve.

const mongoose = require('mongoose');
const Customer = require('../models/Customer.js');
const User = require('../models/User.js');
const normalizePhone = require('./normalizePhone.js');
const { logAudit } = require('./auditLogger.js');
const logger = require('./logger.js');

// trim + lowercase. Only a structural sanity check — deliverability is proven
// by the OTP, not by a regex.
function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const e = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

// Every stored spelling a phone may have. Legacy records were not always
// normalized, so lookups check the canonical form and the raw input.
function phoneVariants(raw) {
  const out = new Set();
  const n = normalizePhone(raw);
  if (n) {
    out.add(n);                       // +2348012345678
    out.add(n.slice(1));              // 2348012345678
    out.add('0' + n.slice(4));        // 08012345678
  }
  if (typeof raw === 'string' && raw.trim()) out.add(raw.trim());
  return [...out];
}

// Find customer records by identifier. Returns what each identifier matched so
// the caller can tell "same person" from "two different people".
async function findCustomersByIdentifiers({ phone, email }) {
  const normEmail = normalizeEmail(email);
  const variants = phone ? phoneVariants(phone) : [];

  const [byPhone, byEmail] = await Promise.all([
    variants.length ? Customer.findOne({ phone: { $in: variants } }) : null,
    normEmail ? Customer.findOne({ email: normEmail }) : null,
  ]);

  const conflict = !!(byPhone && byEmail && String(byPhone._id) !== String(byEmail._id));
  return { byPhone, byEmail, conflict, match: conflict ? null : (byPhone || byEmail || null) };
}

// The portal account linked to a customer record, if any.
async function portalUserFor(customerId) {
  if (!customerId) return null;
  return User.findOne({ customerId, role: 'customer' })
    .select('_id isActive emailVerified customerId')
    .lean();
}

// Portal status for a single customer — the JavaScript twin of the rule in
// utils/customerQueries.customerBasePipeline (keep the two identical):
//   DEACTIVATED → ACTIVE / PENDING_VERIFICATION (has an account)
//   → UNREGISTERED ("Not Activated": walk-in history + phone/email, no account)
//   → NOT_ELIGIBLE (no account, nothing to claim one with)
// A missing value never means "not activated": emailVerified absent (accounts
// that predate email verification) is ACTIVE.
function resolvePortalStatus({ user, customer, hasWalkInHistory }) {
  if (user && user.isActive === false) return 'DEACTIVATED';
  if (customer?.status === 'suspended') return 'DEACTIVATED';
  if (user && user.emailVerified === false) return 'PENDING_VERIFICATION';
  if (user) return 'ACTIVE';
  const walkIn = !!hasWalkInHistory || customer?.source === 'walk_in';
  const contact = !!(String(customer?.phone || '').trim() || String(customer?.email || '').trim());
  return walkIn && contact ? 'UNREGISTERED' : 'NOT_ELIGIBLE';
}

// ACTIVE | DEACTIVATED — the business's standing with the customer.
// A deactivated portal account deactivates the customer (the deactivation
// endpoint mirrors Customer.status to 'suspended'), but a customer with NO
// portal account is simply ACTIVE: not registering is not deactivation.
function customerStatusOf(customer) {
  return customer?.status === 'suspended' ? 'DEACTIVATED' : 'ACTIVE';
}

class IdentityConflictError extends Error {
  constructor(candidates) {
    super('These details match two different customers');
    this.code = 'IDENTITY_CONFLICT';
    this.candidates = candidates;
  }
}

// Find or create the customer record for a walk-in order.
//
// • phone+email → one record          → use it
// • phone → A, email → B              → IdentityConflictError (staff choose)
// • nothing matches                   → create a record, portal UNREGISTERED
//
// A missing identifier on an existing record is filled in, never overwritten:
// an existing phone or email is trusted historical data.
async function resolveWalkInCustomer({ name, phone, email, actor }) {
  const normPhone = normalizePhone(phone) || (phone ? String(phone).trim() : null);
  const normEmail = normalizeEmail(email);

  const found = await findCustomersByIdentifiers({ phone: normPhone, email: normEmail });

  if (found.conflict) {
    throw new IdentityConflictError([found.byPhone, found.byEmail]);
  }

  if (found.match) {
    const c = found.match;
    const fill = {};
    if (!c.email && normEmail) fill.email = normEmail;
    if (!c.phone && normPhone) fill.phone = normPhone;
    if (Object.keys(fill).length) {
      try {
        await Customer.updateOne({ _id: c._id }, { $set: fill });
        Object.assign(c, fill);
      } catch (err) {
        // A duplicate-key here means the identifier already belongs to another
        // record — leave both untouched rather than guess.
        if (err.code !== 11000) throw err;
        logger.warn(`[identity] Could not attach ${Object.keys(fill)} to ${c._id}: already on another record`);
      }
    }
    return { customer: c, created: false };
  }

  // ── No customer record matched — check registered ACCOUNTS ───────────────
  // A registered customer's record can lack the phone they give at the counter
  // (older accounts, or a phone contested at signup). Creating a new record
  // then splits one person into "Activated" + "Not Activated".
  //   • Verified match (verified email, or a phone the account actually
  //     verified) → it is them: use their record and fill in the identifier.
  //   • Unverified phone only → not proof. A portal phone is never verified,
  //     and linking on it is how someone who registered with another person's
  //     number received their orders. Create the walk-in record, flag both for
  //     review; staff can pick the account explicitly after checking in person.
  const variants = normPhone ? phoneVariants(normPhone) : [];
  const accountOr = [];
  if (normEmail) accountOr.push({ email: normEmail });
  if (variants.length) accountOr.push({ phone: { $in: variants } });
  const account = accountOr.length
    ? await User.findOne({ role: 'customer', customerId: { $ne: null }, $or: accountOr })
      .select('customerId email phone emailVerified isPhoneVerified').lean()
    : null;

  let reviewWith = null;
  if (account?.customerId) {
    const verifiedEmail = !!normEmail && account.email === normEmail && account.emailVerified !== false;
    const verifiedPhone = account.isPhoneVerified === true && variants.includes(account.phone);
    const record = await Customer.findById(account.customerId);
    if (record && (verifiedEmail || verifiedPhone)) {
      const fill = {};
      if (!record.phone && normPhone) fill.phone = normPhone;
      if (!record.email && normEmail) fill.email = normEmail;
      if (Object.keys(fill).length) {
        await Customer.updateOne({ _id: record._id }, { $set: fill }).catch((err) => {
          if (err.code !== 11000) throw err;
        });
      }
      return { customer: record, created: false };
    }
    if (record) reviewWith = record._id;
  }

  // No match: create. The unique indexes on phone/email make a concurrent
  // double-create impossible — the loser re-reads the winner's record.
  try {
    const customer = await Customer.create({
      name: (name || '').trim() || 'Walk-in customer',
      phone: normPhone || undefined,
      email: normEmail || undefined,
      status: 'guest',
      source: 'walk_in',
      ...(reviewWith ? {
        needsReview: true,
        reviewReason: 'walk-in phone matches a registered account whose phone is not verified — confirm and link',
        reviewRelatedCustomerIds: [reviewWith],
      } : {}),
    });
    if (reviewWith) {
      await Customer.updateOne(
        { _id: reviewWith },
        { $set: { needsReview: true, reviewReason: 'a walk-in record with this account\'s phone was created separately' },
          $addToSet: { reviewRelatedCustomerIds: customer._id } }
      ).catch((e) => logger.error(`[identity] review flag failed: ${e.message}`));
    }
    await logAudit({
      actorUserId: actor?.id,
      action: 'CUSTOMER_CREATED_FROM_WALK_IN',
      targetType: 'Customer',
      targetId: customer._id.toString(),
      metadata: { performedByRole: actor?.role, hasPhone: !!normPhone, hasEmail: !!normEmail },
    });
    return { customer, created: true };
  } catch (err) {
    if (err.code !== 11000) throw err;
    const retry = await findCustomersByIdentifiers({ phone: normPhone, email: normEmail });
    if (retry.conflict) throw new IdentityConflictError([retry.byPhone, retry.byEmail]);
    if (retry.match) return { customer: retry.match, created: false };
    throw err;
  }
}

// Can this signed-in customer see / act on this order?
//
// Through the account (order.customer) or the customer record it is linked to
// (order.customerId). Deliberately NOT by phone: the phone on a portal account
// was never verified, so matching on it handed walk-in history — and payment
// and cancellation rights — to whoever registered with that number.
function customerCanAccessOrder(user, order) {
  if (!user || !order) return false;
  const orderUser = order.customer?._id ?? order.customer;
  if (orderUser && String(orderUser) === String(user.id ?? user._id)) return true;
  const orderCust = order.customerId?._id ?? order.customerId;
  return !!(orderCust && user.customerId && String(orderCust) === String(user.customerId));
}

// Mongo filter equivalent of customerCanAccessOrder, for list queries.
function customerOrderFilter(user) {
  const or = [{ customer: new mongoose.Types.ObjectId(String(user.id ?? user._id)) }];
  if (user.customerId) or.push({ customerId: new mongoose.Types.ObjectId(String(user.customerId)) });
  return { $or: or };
}

// Mask for anything shown before identity is proven.
function maskEmail(e) {
  if (!e) return null;
  const [u, d] = e.split('@');
  return `${u.slice(0, 1)}${'*'.repeat(Math.max(1, u.length - 1))}@${d}`;
}
function maskPhone(p) {
  if (!p) return null;
  return p.length > 4 ? `${'*'.repeat(p.length - 4)}${p.slice(-4)}` : '****';
}

module.exports = {
  normalizeEmail,
  normalizePhone,
  phoneVariants,
  findCustomersByIdentifiers,
  portalUserFor,
  resolvePortalStatus,
  customerStatusOf,
  resolveWalkInCustomer,
  IdentityConflictError,
  customerCanAccessOrder,
  customerOrderFilter,
  maskEmail,
  maskPhone,
};
