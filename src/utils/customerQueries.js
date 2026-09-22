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

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Adds: user (portal account or null), portalStatus, customerStatus, hasPortalAccount
function customerBasePipeline() {
  return [
    {
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
    { $match: { $or: [{ user: null }, { 'user.role': 'customer' }] } },
    {
      $addFields: {
        hasPortalAccount: { $cond: [{ $ifNull: ['$user', false] }, true, false] },
        portalStatus: {
          $switch: {
            branches: [
              { case: { $eq: [{ $ifNull: ['$user', null] }, null] }, then: 'UNREGISTERED' },
              { case: { $eq: ['$user.isActive', false] },            then: 'DEACTIVATED' },
              { case: { $eq: ['$user.emailVerified', false] },       then: 'PENDING_VERIFICATION' },
            ],
            default: 'ACTIVE',
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
    if (digits.length >= 7) or.push({ phone: new RegExp(escapeRegex(digits.slice(-9))) });
    if (mongoose.isValidObjectId(q)) or.push({ _id: new mongoose.Types.ObjectId(q) });
    and.push({ $or: or });
  }

  const portalMap = { active: 'ACTIVE', unregistered: 'UNREGISTERED', pending: 'PENDING_VERIFICATION', deactivated: 'DEACTIVATED' };
  if (portal && portalMap[portal]) and.push({ portalStatus: portalMap[portal] });

  if (status === 'active') and.push({ customerStatus: 'ACTIVE' });
  if (status === 'deactivated' || status === 'inactive') and.push({ customerStatus: 'DEACTIVATED' });

  if (needsReview === 'true') and.push({ needsReview: true });

  return and.length ? [{ $match: { $and: and } }] : [];
}

// Counts for the stats cards and dashboard. One aggregation, unique customers.
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
        needsReview:  { $sum: { $cond: [{ $eq: ['$needsReview', true] }, 1, 0] } },
        newThisMonth: {
          $sum: { $cond: [{ $gte: ['$createdAt', monthStart || new Date(0)] }, 1, 0] },
        },
      },
    },
  ]);
  const c = row || { total: 0, deactivated: 0, portalActive: 0, unregistered: 0, pending: 0, needsReview: 0, newThisMonth: 0 };
  // Activation rate among customers the business has not deactivated.
  const eligible = c.total - c.deactivated;
  return {
    total: c.total,
    active: eligible,
    inactive: c.deactivated,
    deactivated: c.deactivated,
    portalActive: c.portalActive,
    unregistered: c.unregistered,
    pendingVerification: c.pending,
    needsReview: c.needsReview,
    newThisMonth: c.newThisMonth,
    activationRate: eligible > 0 ? Math.round((c.portalActive / eligible) * 1000) / 10 : 0,
  };
}

module.exports = { customerBasePipeline, customerFilterStage, customerCounts, escapeRegex };
