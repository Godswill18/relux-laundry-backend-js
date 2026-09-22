// ─── Customer queries — the one definition of "a customer" ──────────────────
//
// A customer is a Customer RECORD, whether or not it has a portal account. The
// list, the stats cards and the dashboard all build on customerBasePipeline()
// so they can never count differently.
//
// "Total Customers" used to count portal logins (users with role 'customer'),
// so walk-in customers — the majority of a counter business — were invisible.
//
// Excluded: records linked to a STAFF account. protect() creates a customer
// record for any signed-in user lacking one, staff included; those are not
// customers of the business.

const mongoose = require('mongoose');
const Customer = require('../models/Customer.js');
const logger = require('./logger.js');

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ─── Portal status — the ONE definition ─────────────────────────────────────
//
// The portal status describes online access only. It is derived from the data
// that actually governs that access, never stored, and never inferred from a
// missing value or from where an order came from.
//
//   DEACTIVATED           account (or customer record) deactivated by the business
//   ACTIVE                has a portal account                       → "Activated"
//   PENDING_VERIFICATION  account exists, but signup was never finished:
//                         emailVerified is explicitly false. Accounts created
//                         before email verification existed (April 2026) have
//                         no such field and are ACTIVE — absent ≠ false.
//   UNREGISTERED          no portal account, AND has walk-in history, AND has a
//                         phone or email to claim it with     → "Not Activated"
//   NOT_ELIGIBLE          no portal account and nothing to claim it with — still
//                         a customer and still counted, just not "Not Activated"
//
// The previous version made UNREGISTERED mean "any customer record without an
// account", so every record lacking one was labelled Not Activated regardless
// of whether there was any walk-in history or any way to claim it.
//
// Adds: user, hasPortalAccount, hasWalkInHistory, hasContact, portalStatus, customerStatus
function customerBasePipeline() {
  return [
    {
      // Correlated let/$expr form: works on every MongoDB version (the
      // localField+pipeline form needs 5.0+), and from 5.0 an $eq inside $expr
      // uses the unique index on users.customerId.
      $lookup: {
        from: 'users',
        let: { cid: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$customerId', '$$cid'] } } },
          { $project: { password: 0, otp: 0, otpExpires: 0 } },
          { $limit: 1 },
        ],
        as: 'portal',
      },
    },
    { $addFields: { user: { $arrayElemAt: ['$portal', 0] } } },
    { $project: { portal: 0 } },
    // Records linked to a staff account are not customers of the business.
    { $match: { $or: [{ user: null }, { 'user.role': 'customer' }] } },
    {
      $lookup: {
        from: 'orders',
        let: { cid: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$customerId', '$$cid'] }, orderSource: 'offline' } },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
        as: 'walkIn',
      },
    },
    {
      $addFields: {
        hasPortalAccount: { $cond: [{ $ifNull: ['$user', false] }, true, false] },
        hasWalkInHistory: {
          $or: [{ $gt: [{ $size: '$walkIn' }, 0] }, { $eq: ['$source', 'walk_in'] }],
        },
        hasContact: {
          $or: [
            { $gt: [{ $strLenCP: { $trim: { input: { $ifNull: ['$phone', ''] } } } }, 0] },
            { $gt: [{ $strLenCP: { $trim: { input: { $ifNull: ['$email', ''] } } } }, 0] },
          ],
        },
      },
    },
    { $project: { walkIn: 0 } },
    {
      $addFields: {
        portalStatus: {
          $switch: {
            branches: [
              { case: { $and: ['$hasPortalAccount', { $eq: ['$user.isActive', false] }] }, then: 'DEACTIVATED' },
              { case: { $eq: ['$status', 'suspended'] },                                  then: 'DEACTIVATED' },
              { case: { $and: ['$hasPortalAccount', { $eq: ['$user.emailVerified', false] }] }, then: 'PENDING_VERIFICATION' },
              { case: '$hasPortalAccount',                                                 then: 'ACTIVE' },
              { case: { $and: ['$hasWalkInHistory', '$hasContact'] },                      then: 'UNREGISTERED' },
            ],
            default: 'NOT_ELIGIBLE',
          },
        },
        customerStatus: {
          $cond: [
            { $or: [{ $eq: ['$status', 'suspended'] }, { $eq: ['$user.isActive', false] }] },
            'DEACTIVATED',
            'ACTIVE',
          ],
        },
      },
    },
  ];
}

// Filters. `portal` is the new filter; `status` keeps the values the admin app
// already sends (active / deactivated / inactive).
function customerFilterStage({ search, portal, status, needsReview }) {
  const and = [];

  if (search && String(search).trim()) {
    const q = String(search).trim();
    const rx = new RegExp(escapeRegex(q), 'i');
    const or = [{ name: rx }, { email: rx }, { phone: rx }, { 'user.name': rx }, { 'user.email': rx }];
    // A phone typed as 080… still finds +234… (and vice versa).
    const digits = q.replace(/\D/g, '');
    if (digits.length >= 7) {
      const tail = new RegExp(escapeRegex(digits.slice(-9)));
      or.push({ phone: tail }, { 'user.phone': tail });
    }
    if (mongoose.isValidObjectId(q)) or.push({ _id: new mongoose.Types.ObjectId(q) });
    and.push({ $or: or });
  }

  const portalMap = { active: 'ACTIVE', unregistered: 'UNREGISTERED', pending: 'PENDING_VERIFICATION', deactivated: 'DEACTIVATED', not_eligible: 'NOT_ELIGIBLE' };
  if (portal && portalMap[portal]) and.push({ portalStatus: portalMap[portal] });

  if (status === 'active') and.push({ customerStatus: 'ACTIVE' });
  if (status === 'deactivated' || status === 'inactive') and.push({ customerStatus: 'DEACTIVATED' });

  if (needsReview === 'true') and.push({ needsReview: true });

  return and.length ? [{ $match: { $and: and } }] : [];
}

// Counts for the stats cards and dashboard. One aggregation, unique customers.
//
// Every figure is counted directly from its own status. "Not Activated" is the
// number of eligible walk-in customers — it is never derived as
// total − activated, which is what makes a missing or unrelated record look
// like an unactivated account.
async function customerCounts({ monthStart } = {}) {
  const [row] = await Customer.aggregate([
    ...customerBasePipeline(),
    {
      $group: {
        _id: null,
        total:        { $sum: 1 },
        deactivated:  { $sum: { $cond: [{ $eq: ['$customerStatus', 'DEACTIVATED'] }, 1, 0] } },
        portalActive: { $sum: { $cond: [{ $eq: ['$portalStatus', 'ACTIVE'] }, 1, 0] } },
        unregistered: { $sum: { $cond: [{ $eq: ['$portalStatus', 'UNREGISTERED'] }, 1, 0] } },
        pending:      { $sum: { $cond: [{ $eq: ['$portalStatus', 'PENDING_VERIFICATION'] }, 1, 0] } },
        notEligible:  { $sum: { $cond: [{ $eq: ['$portalStatus', 'NOT_ELIGIBLE'] }, 1, 0] } },
        needsReview:  { $sum: { $cond: [{ $eq: ['$needsReview', true] }, 1, 0] } },
        newThisMonth: {
          $sum: { $cond: [{ $gte: ['$createdAt', monthStart || new Date(0)] }, 1, 0] },
        },
      },
    },
  ]);
  const c = row || { total: 0, deactivated: 0, portalActive: 0, unregistered: 0, pending: 0, notEligible: 0, needsReview: 0, newThisMonth: 0 };

  // Adoption among customers who have, or could claim, an account.
  const canHaveAccount = c.portalActive + c.unregistered + c.pending;

  // Counts only — no identities or contact details in the log.
  logger.info(
    `[customerCounts] total=${c.total} activated=${c.portalActive} notActivated=${c.unregistered} ` +
    `pending=${c.pending} notEligible=${c.notEligible} deactivated=${c.deactivated} needsReview=${c.needsReview}`
  );

  return {
    total: c.total,
    active: c.total - c.deactivated,     // customers in good standing (not portal-related)
    inactive: c.deactivated,
    deactivated: c.deactivated,
    portalActive: c.portalActive,        // Activated
    unregistered: c.unregistered,        // Not Activated — eligible walk-ins only
    pendingVerification: c.pending,
    notEligible: c.notEligible,          // customers with nothing to claim an account with
    needsReview: c.needsReview,
    newThisMonth: c.newThisMonth,
    activationRate: canHaveAccount > 0 ? Math.round((c.portalActive / canHaveAccount) * 1000) / 10 : 0,
  };
}

module.exports = { customerBasePipeline, customerFilterStage, customerCounts, escapeRegex };
