const Customer = require('../models/Customer.js');
const User = require('../models/User.js');
const Order = require('../models/Order.js');
const normalizePhone = require('./normalizePhone.js');
const { normalizeEmail, phoneVariants } = require('./customerIdentity.js');
const { logAudit } = require('./auditLogger.js');
const logger = require('./logger.js');

// Ensure a portal account is linked to a customer record.
// Idempotent — returns immediately once user.customerId is set.
//
// This used to link the account to any customer record sharing its phone or
// email, before either had been verified. Because a portal account's phone is
// never verified, registering with someone else's number attached their
// customer record — wallet, loyalty points and order history included.
//
// Now:
//   • An existing record is claimed ONLY through a VERIFIED email, and only if
//     no other account already owns it and it has not been deactivated. This is
//     how "Create New Account" by an existing walk-in customer links to their
//     record instead of creating a duplicate.
//   • Otherwise a new record is created. Identifiers that already belong to
//     another record are not copied onto it (that would either fail the unique
//     index or silently merge two people); both records are flagged for review.
const ensureCustomer = async (user) => {
  if (user.customerId) return user;

  const email = normalizeEmail(user.email);
  const emailVerified = user.emailVerified !== false;

  // ── Claim an existing record through a verified email ─────────────────────
  if (user.role === 'customer' && email && emailVerified) {
    const existing = await Customer.findOne({ email });
    if (existing) {
      const ownedByAnother = await User.exists({ customerId: existing._id, _id: { $ne: user._id } });
      if (!ownedByAnother && existing.status !== 'suspended') {
        user.customerId = existing._id;
        await user.save({ validateBeforeSave: false });

        // Orders already belonging to this customer record become visible to
        // the account. Only unlinked ones are touched, so this is idempotent.
        const linked = await Order.updateMany(
          { customerId: existing._id, $or: [{ customer: null }, { customer: { $exists: false } }] },
          { $set: { customer: user._id } }
        );
        if (existing.status === 'guest') {
          await Customer.updateOne({ _id: existing._id, status: 'guest' }, { status: 'active' });
        }
        await logAudit({
          actorUserId: user._id,
          action: 'CUSTOMER_ACCOUNT_ACTIVATED',
          targetType: 'Customer',
          targetId: existing._id.toString(),
          metadata: { via: 'registration with verified email', ordersLinked: linked.modifiedCount || 0 },
        });
        return user;
      }
      // Owned by another account or deactivated: never attach. Fall through to
      // a fresh record without the email, flagged for review.
    }
  }

  // ── Create a new record ────────────────────────────────────────────────────
  const phone = normalizePhone(user.phone) || user.phone || null;
  const [phoneOwner, emailOwner] = await Promise.all([
    phone ? Customer.findOne({ phone: { $in: phoneVariants(phone) } }).select('_id').lean() : null,
    email ? Customer.findOne({ email }).select('_id').lean() : null,
  ]);

  const related = [phoneOwner?._id, emailOwner?._id].filter(Boolean);
  const reasons = [];
  if (phoneOwner) reasons.push('phone matches an existing customer record (phone not verified)');
  if (emailOwner) reasons.push('email matches a customer record that is already linked or deactivated');

  let customer;
  try {
    customer = await Customer.create({
      name: user.name,
      phone: phoneOwner ? undefined : (phone || undefined),
      email: emailOwner ? undefined : (email || undefined),
      status: 'active',
      source: 'online',
      ...(related.length
        ? { needsReview: true, reviewReason: reasons.join('; '), reviewRelatedCustomerIds: related }
        : {}),
    });
  } catch (err) {
    if (err.code !== 11000) throw err;
    // A concurrent write took an identifier between the check and the create.
    // Create a bare record rather than fail the request (protect() calls this).
    customer = await Customer.create({
      name: user.name, status: 'active', source: 'online',
      needsReview: true, reviewReason: 'identifier conflict during account setup',
    });
  }

  if (related.length) {
    await Customer.updateMany(
      { _id: { $in: related } },
      {
        $set: { needsReview: true, reviewReason: 'a portal account with matching details was created separately' },
        $addToSet: { reviewRelatedCustomerIds: customer._id },
      }
    ).catch((e) => logger.error(`[ensureCustomer] review flag failed: ${e.message}`));
  }

  user.customerId = customer._id;
  await user.save({ validateBeforeSave: false });
  return user;
};

module.exports = ensureCustomer;
