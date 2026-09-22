const Customer = require('../models/Customer.js');
const User = require('../models/User.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');
const { logAudit } = require('../utils/auditLogger.js');
const logger = require('../utils/logger.js');
const { customerBasePipeline, customerFilterStage } = require('../utils/customerQueries.js');

// Shape one aggregated customer record the way the admin app already reads
// rows (it used to receive User documents with customerId populated), so the
// wallet, loyalty, edit and view screens keep working unchanged.
//   _id               portal account id when there is one (what deactivate uses)
//   userId            the same, explicit; null for a customer with no account
//   customerRecordId  the Customer record — present for every customer
function toCustomerRow(c) {
  const u = c.user || null;
  const { user, portalStatus, customerStatus, hasPortalAccount, tier, deactivatedByUser, reactivatedByUser, ...record } = c;
  return {
    _id: u?._id || c._id,
    userId: u?._id || null,
    customerRecordId: c._id,
    name: u?.name || c.name,
    email: u?.email || c.email || null,
    phone: u?.phone || c.phone || null,
    // Valid customer unless the business deactivated them. Not having a portal
    // account is NOT inactive.
    isActive: customerStatus !== 'DEACTIVATED',
    createdAt: c.createdAt,
    deactivatedAt: u?.deactivatedAt || null,
    deactivatedBy: deactivatedByUser || null,
    deactivationReason: u?.deactivationReason || null,
    reactivatedAt: u?.reactivatedAt || null,
    reactivatedBy: reactivatedByUser || null,
    portalStatus,
    customerStatus,
    hasPortalAccount,
    source: c.source || null,
    needsReview: !!c.needsReview,
    reviewReason: c.reviewReason || null,
    customerId: { ...record, loyaltyTierId: tier || null },
  };
}

// @desc    Get all customers — every customer record, with or without a portal account
// @route   GET /api/v1/customers
// @access  Private (Admin/Manager/Staff)
// Query: search, portal (active|unregistered|pending|deactivated),
//        status (active|deactivated), needsReview=true, page, limit
exports.getCustomers = asyncHandler(async (req, res, next) => {
  const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));

  const [result] = await Customer.aggregate([
    ...customerBasePipeline(),
    ...customerFilterStage(req.query),
    {
      $facet: {
        total: [{ $count: 'n' }],
        rows: [
          { $sort: { createdAt: -1, _id: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
          { $lookup: { from: 'loyaltytiers', localField: 'loyaltyTierId', foreignField: '_id', as: 'tier', pipeline: [{ $project: { name: 1, rank: 1 } }] } },
          { $addFields: { tier: { $arrayElemAt: ['$tier', 0] } } },
          { $lookup: { from: 'users', localField: 'user.deactivatedBy', foreignField: '_id', as: 'deactivatedByUser', pipeline: [{ $project: { name: 1, role: 1 } }] } },
          { $lookup: { from: 'users', localField: 'user.reactivatedBy', foreignField: '_id', as: 'reactivatedByUser', pipeline: [{ $project: { name: 1, role: 1 } }] } },
          { $addFields: {
            deactivatedByUser: { $arrayElemAt: ['$deactivatedByUser', 0] },
            reactivatedByUser: { $arrayElemAt: ['$reactivatedByUser', 0] },
          } },
        ],
      },
    },
  ]);

  const total = result?.total?.[0]?.n || 0;
  res.status(200).json({
    success: true,
    message: 'Customers fetched successfully',
    data: { customers: (result?.rows || []).map(toCustomerRow) },
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

// @desc    Find existing customers while creating an order at the counter
// @route   GET /api/v1/customers/lookup?q=
// @access  Private (staff roles that create walk-in orders)
// Searches phone (any format), email, name and customer id. Name results help
// staff pick; automatic matching when an order is saved still uses phone/email
// only (see utils/customerIdentity).
exports.lookupCustomers = asyncHandler(async (req, res, next) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) {
    return res.status(200).json({ success: true, data: { customers: [] } });
  }

  const rows = await Customer.aggregate([
    ...customerBasePipeline(),
    ...customerFilterStage({ search: q }),
    { $sort: { updatedAt: -1 } },
    { $limit: 10 },
    { $lookup: { from: 'orders', localField: '_id', foreignField: 'customerId', as: 'o', pipeline: [{ $project: { _id: 1 } }] } },
    { $addFields: { orderCount: { $size: '$o' } } },
    { $project: { o: 0 } },
  ]);

  res.status(200).json({
    success: true,
    data: {
      customers: rows.map((c) => ({
        customerRecordId: c._id,
        name: c.user?.name || c.name,
        phone: c.phone || c.user?.phone || null,
        email: c.email || c.user?.email || null,
        portalStatus: c.portalStatus,
        customerStatus: c.customerStatus,
        orderCount: c.orderCount,
        needsReview: !!c.needsReview,
        // Identifiers on the customer RECORD (safe to auto-match on) versus
        // those only on the portal account (unverified — staff must confirm).
        recordPhone: c.phone || null,
        recordEmail: c.email || null,
      })),
    },
  });
});

// @desc    Get single customer
// @route   GET /api/v1/customers/:id
// @access  Private (Admin/Manager/Staff)
exports.getCustomer = asyncHandler(async (req, res, next) => {
  const customer = await Customer.findById(req.params.id)
    .populate('loyaltyTierId', 'name rank multiplierPercent');

  if (!customer) {
    return next(new AppError('Customer not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Customer fetched successfully',
    data: { customer },
  });
});

// @desc    Create customer
// @route   POST /api/v1/customers
// @access  Private (Admin/Manager/Staff)
exports.createCustomer = asyncHandler(async (req, res, next) => {
  const { name, phone, email, address, city, dateOfBirth, photoUrl } = req.body;

  if (phone) {
    const existing = await Customer.findOne({ phone });
    if (existing) {
      return next(new AppError('Phone number already registered', 400));
    }
  }

  if (email) {
    const existing = await Customer.findOne({ email });
    if (existing) {
      return next(new AppError('Email already registered', 400));
    }
  }

  const customer = await Customer.create({
    name,
    phone,
    email,
    address,
    city,
    dateOfBirth,
    photoUrl,
  });

  res.status(201).json({
    success: true,
    message: 'Customer created successfully',
    data: { customer },
  });
});

// @desc    Update customer
// @route   PUT /api/v1/customers/:id
// @access  Private (Admin/Manager)
exports.updateCustomer = asyncHandler(async (req, res, next) => {
  const fieldsToUpdate = {
    name: req.body.name,
    phone: req.body.phone,
    email: req.body.email,
    address: req.body.address,
    city: req.body.city,
    dateOfBirth: req.body.dateOfBirth,
    photoUrl: req.body.photoUrl,
    status: req.body.status,
    loyaltyTierId: req.body.loyaltyTierId,
  };

  Object.keys(fieldsToUpdate).forEach(
    (key) => fieldsToUpdate[key] === undefined && delete fieldsToUpdate[key]
  );

  const customer = await Customer.findByIdAndUpdate(req.params.id, fieldsToUpdate, {
    new: true,
    runValidators: true,
  });

  if (!customer) {
    return next(new AppError('Customer not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Customer updated successfully',
    data: { customer },
  });
});

// @desc    Get my customer profile
// @route   GET /api/v1/customers/me
// @access  Private
exports.getMyProfile = asyncHandler(async (req, res, next) => {
  const customer = await Customer.findById(req.user.customerId)
    .populate('loyaltyTierId', 'name rank multiplierPercent discountPercent freePickup freeDelivery priorityTurnaround');

  if (!customer) {
    return next(new AppError('Customer profile not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Profile fetched successfully',
    data: { customer },
  });
});

// @desc    Update my customer profile
// @route   PUT /api/v1/customers/me
// @access  Private
exports.updateMyProfile = asyncHandler(async (req, res, next) => {
  const fieldsToUpdate = {
    name: req.body.name,
    email: req.body.email,
    address: req.body.address,
    city: req.body.city,
    dateOfBirth: req.body.dateOfBirth,
    photoUrl: req.body.photoUrl,
  };

  Object.keys(fieldsToUpdate).forEach(
    (key) => fieldsToUpdate[key] === undefined && delete fieldsToUpdate[key]
  );

  const customer = await Customer.findByIdAndUpdate(req.user.customerId, fieldsToUpdate, {
    new: true,
    runValidators: true,
  });

  if (!customer) {
    return next(new AppError('Customer profile not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Profile updated successfully',
    data: { customer },
  });
});

// ─── Customer account status ─────────────────────────────────────────────────
//
// Deactivation replaces deletion. The old deleteCustomer ran
// Customer.findByIdAndDelete + User.findByIdAndDelete — a hard delete that left
// every order, payment, wallet, ledger row and referral pointing at a record
// that no longer existed.
//
// User.isActive is the one access switch. login, protect() and socketAuth
// already enforce it, so flipping it is what actually blocks the account.
// Customer.status only mirrors it for display ('suspended' / 'active'); it was
// never enforced anywhere, so it must not become a second source of truth.
//
// Nothing financial is touched: balances, points, orders, payments and ledgers
// are read-only here by construction.

const mongoose = require('mongoose');


async function changeCustomerStatus(req, res, next, { userId, activate, legacyAction }) {
  if (!mongoose.isValidObjectId(userId)) {
    return next(new AppError('Invalid customer ID', 400));
  }

  // Never act on your own account through this path
  if (String(userId) === String(req.user.id)) {
    return next(new AppError('You cannot change the status of your own account', 400));
  }

  const reason = typeof req.body?.reason === 'string'
    ? req.body.reason.trim().slice(0, 500)
    : '';

  const now = new Date();
  const update = activate
    ? {
        $set: { isActive: true, reactivatedAt: now, reactivatedBy: req.user.id },
      }
    : {
        $set: {
          isActive: false,
          deactivatedAt: now,
          deactivatedBy: req.user.id,
          deactivationReason: reason || undefined,
        },
        // Invalidates every JWT issued before now. protect() would already reject
        // them via isActive, but bumping the version means tokens issued while
        // deactivated stay dead after a later reactivation too.
        $inc: { jwtVersion: 1 },
      };

  // Single-document conditional update: atomic in MongoDB, so two admins
  // clicking at once cannot both "succeed", and status, actor, timestamp and
  // reason can never be written partially. The filter is also what makes the
  // "already deactivated / already active" answers race-free.
  const user = await User.findOneAndUpdate(
    {
      _id: userId,
      role: 'customer',
      isActive: activate ? false : { $ne: false },
    },
    update,
    { new: true }
  ).select('-password -otp -otpExpires');

  if (!user) {
    const existing = await User.findOne({ _id: userId, role: 'customer' }).select('isActive').lean();
    if (!existing) return next(new AppError('Customer not found', 404));
    return next(new AppError(
      activate ? 'This customer account is already active' : 'This customer account is already deactivated',
      409
    ));
  }

  // Display mirror. Reactivation only lifts 'suspended' — a 'guest' profile is a
  // walk-in record with its own meaning and is left alone.
  if (user.customerId) {
    try {
      if (activate) {
        await Customer.updateOne({ _id: user.customerId, status: 'suspended' }, { status: 'active' });
      } else {
        await Customer.updateOne({ _id: user.customerId }, { status: 'suspended' });
      }
    } catch (mirrorErr) {
      // Access is governed by isActive, which is already committed. A failed
      // mirror is cosmetic; log it rather than report a failure that did not happen.
      logger.error(`[customerStatus] Customer.status mirror failed for ${user._id}: ${mirrorErr.message}`);
    }
  }

  // Cut any live realtime connection. socketAuth only checks at connect time,
  // so an already-open socket would otherwise keep streaming order updates.
  if (!activate) {
    const io = req.app.get('io');
    if (io) {
      io.in(`user-${user._id}`).disconnectSockets(true);
      if (user.customerId) io.in(`user-${user.customerId}`).disconnectSockets(true);
    }
  }

  await logAudit({
    actorUserId: req.user.id,
    action: activate ? 'CUSTOMER_REACTIVATED' : 'CUSTOMER_DEACTIVATED',
    targetType: 'Customer',
    targetId: user._id.toString(),
    before: { status: activate ? 'DEACTIVATED' : 'ACTIVE' },
    after:  { status: activate ? 'ACTIVE' : 'DEACTIVATED' },
    metadata: {
      customerId: user.customerId ? String(user.customerId) : null,
      name: user.name,
      performedByRole: req.user.role,
      reason: activate ? undefined : (reason || undefined),
      ...(legacyAction ? { via: legacyAction } : {}),
    },
  });

  await user.populate([
    { path: 'deactivatedBy', select: 'name role' },
    { path: 'reactivatedBy', select: 'name role' },
  ]);

  res.status(200).json({
    success: true,
    message: activate ? 'Customer account reactivated' : 'Customer account deactivated',
    data: { customer: user },
  });
}

// @desc    Deactivate a customer account (access only — no data is removed)
// @route   PATCH /api/v1/customers/:id/deactivate
// @access  Private (Admin)
exports.deactivateCustomer = asyncHandler((req, res, next) =>
  changeCustomerStatus(req, res, next, { userId: req.params.id, activate: false })
);

// @desc    Reactivate a deactivated customer account
// @route   PATCH /api/v1/customers/:id/reactivate
// @access  Private (Admin)
exports.reactivateCustomer = asyncHandler((req, res, next) =>
  changeCustomerStatus(req, res, next, { userId: req.params.id, activate: true })
);

// @desc    DEPRECATED — formerly a hard delete. Now deactivates.
// @route   DELETE /api/v1/customers/:id
// @access  Private (Admin)
//
// Kept so a stale admin tab still open from before this release cannot fail
// oddly — and, far more importantly, so it can never hard-delete again.
exports.deleteCustomer = asyncHandler((req, res, next) => {
  res.set('Deprecation', 'true');
  res.set('Link', `</api/v1/customers/${req.params.id}/deactivate>; rel="successor-version"`);
  return changeCustomerStatus(req, res, next, {
    userId: req.params.id, activate: false, legacyAction: 'DELETE /customers/:id',
  });
});

// The legacy suspend/activate routes address the Customer profile _id rather
// than the User _id, and flipped only the cosmetic Customer.status — so a
// "suspended" customer could still log in. They now resolve the account and go
// through the same core, leaving one status system instead of two.
async function resolveUserIdFromProfile(profileId) {
  if (!mongoose.isValidObjectId(profileId)) return null;
  const u = await User.findOne({ customerId: profileId, role: 'customer' }).select('_id').lean();
  return u?._id;
}

// @desc    DEPRECATED — use /deactivate
// @route   PUT /api/v1/customers/:id/suspend   (:id = Customer profile id)
exports.suspendCustomer = asyncHandler(async (req, res, next) => {
  const userId = await resolveUserIdFromProfile(req.params.id);
  if (!userId) return next(new AppError('Customer not found', 404));
  return changeCustomerStatus(req, res, next, { userId, activate: false, legacyAction: 'PUT /customers/:id/suspend' });
});

// @desc    DEPRECATED — use /reactivate
// @route   PUT /api/v1/customers/:id/activate  (:id = Customer profile id)
exports.activateCustomer = asyncHandler(async (req, res, next) => {
  const userId = await resolveUserIdFromProfile(req.params.id);
  if (!userId) return next(new AppError('Customer not found', 404));
  return changeCustomerStatus(req, res, next, { userId, activate: true, legacyAction: 'PUT /customers/:id/activate' });
});
