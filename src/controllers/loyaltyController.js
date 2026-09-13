const LoyaltyTier = require('../models/LoyaltyTier.js');
const LoyaltyLedger = require('../models/LoyaltyLedger.js');
const LoyaltySetting = require('../models/LoyaltySetting.js');
const Customer = require('../models/Customer.js');
const Wallet = require('../models/Wallet.js');
const WalletTransaction = require('../models/WalletTransaction.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');
const { logAudit } = require('../utils/auditLogger.js');
const notify = require('../utils/notify.js');
const logger = require('../utils/logger.js');
const {
  loadLoyaltySettings,
  walletCreditForPoints,
  conversionAvailable,
  publicLoyaltyTerms,
} = require('../utils/loyaltyRates.js');

// @desc    Get all loyalty tiers
// @route   GET /api/v1/loyalty/tiers
// @access  Private
exports.getTiers = asyncHandler(async (req, res, next) => {
  let query = {};
  if (req.query.active !== undefined) query.active = req.query.active === 'true';

  const rawTiers = await LoyaltyTier.find(query).sort('rank');

  // Enrich tiers with computed fields for frontend compatibility
  const tiers = rawTiers.map((t, i) => {
    const obj = t.toObject({ virtuals: true });
    const benefits = [];
    if (t.freePickup) benefits.push('Free Pickup');
    if (t.freeDelivery) benefits.push('Free Delivery');
    if (t.priorityTurnaround) benefits.push('Priority Turnaround');
    if (t.multiplierPercent > 100) benefits.push(`${t.multiplierPercent / 100}x points multiplier`);

    obj.minPoints = t.pointsRequired;
    obj.multiplier = t.multiplierPercent / 100;
    obj.benefits = benefits;
    // maxPoints = next tier's pointsRequired - 1, or undefined for the last tier
    if (i < rawTiers.length - 1) {
      obj.maxPoints = rawTiers[i + 1].pointsRequired - 1;
    }
    return obj;
  });

  res.status(200).json({
    success: true,
    message: 'Loyalty tiers fetched successfully',
    data: { tiers },
  });
});

// @desc    Get single tier
// @route   GET /api/v1/loyalty/tiers/:id
// @access  Private
exports.getTier = asyncHandler(async (req, res, next) => {
  const tier = await LoyaltyTier.findById(req.params.id);

  if (!tier) {
    return next(new AppError('Tier not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Tier fetched successfully',
    data: { tier },
  });
});

// @desc    Create tier
// @route   POST /api/v1/loyalty/tiers
// @access  Private (Admin)
exports.createTier = asyncHandler(async (req, res, next) => {
  const { name, pointsRequired, multiplierPercent, rank, freePickup, freeDelivery, priorityTurnaround } = req.body;

  const tier = await LoyaltyTier.create({
    name,
    pointsRequired,
    multiplierPercent,
    rank,
    freePickup,
    freeDelivery,
    priorityTurnaround,
  });

  res.status(201).json({
    success: true,
    message: 'Tier created successfully',
    data: { tier },
  });
});

// @desc    Update tier
// @route   PUT /api/v1/loyalty/tiers/:id
// @access  Private (Admin)
exports.updateTier = asyncHandler(async (req, res, next) => {
  const fieldsToUpdate = {
    name: req.body.name,
    pointsRequired: req.body.pointsRequired,
    multiplierPercent: req.body.multiplierPercent,
    rank: req.body.rank,
    freePickup: req.body.freePickup,
    freeDelivery: req.body.freeDelivery,
    priorityTurnaround: req.body.priorityTurnaround,
    active: req.body.active,
  };

  Object.keys(fieldsToUpdate).forEach(
    (key) => fieldsToUpdate[key] === undefined && delete fieldsToUpdate[key]
  );

  const tier = await LoyaltyTier.findByIdAndUpdate(req.params.id, fieldsToUpdate, {
    new: true,
    runValidators: true,
  });

  if (!tier) {
    return next(new AppError('Tier not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Tier updated successfully',
    data: { tier },
  });
});

// @desc    Delete tier
// @route   DELETE /api/v1/loyalty/tiers/:id
// @access  Private (Admin)
exports.deleteTier = asyncHandler(async (req, res, next) => {
  const tier = await LoyaltyTier.findById(req.params.id);

  if (!tier) {
    return next(new AppError('Tier not found', 404));
  }

  await tier.deleteOne();

  res.status(200).json({
    success: true,
    message: 'Tier deleted successfully',
    data: {},
  });
});

// @desc    Get my loyalty info
// @route   GET /api/v1/loyalty/me
// @access  Private
exports.getMyLoyalty = asyncHandler(async (req, res, next) => {
  const [customer, settings] = await Promise.all([
    Customer.findById(req.user.customerId)
      .populate('loyaltyTierId', 'name rank multiplierPercent discountPercent freePickup freeDelivery priorityTurnaround'),
    LoyaltySetting.findOne().lean(),
  ]);

  if (!customer) {
    return next(new AppError('Customer not found', 404));
  }

  // Lifetime converted total, summed in the database. The Points page used to
  // derive this from the ledger rows it happened to have fetched — page one,
  // twenty rows — so it under-reported as soon as a customer had any history.
  const [convertedAgg] = await LoyaltyLedger.aggregate([
    { $match: { customerId: customer._id, type: 'convert' } },
    { $group: { _id: null, points: { $sum: '$points' } } },
  ]);

  res.status(200).json({
    success: true,
    message: 'Loyalty info fetched successfully',
    data: {
      pointsBalance: customer.loyaltyPointsBalance,
      lifetimePoints: customer.loyaltyLifetimePoints,
      tier: customer.loyaltyTierId,
      totalConverted: Math.abs(convertedAgg?.points || 0),
      // Every rate and switch the customer app renders comes from here, in one
      // unit (points per ₦1). No screen derives a rate of its own.
      ...publicLoyaltyTerms(settings),
    },
  });
});

// @desc    Get my loyalty ledger
// @route   GET /api/v1/loyalty/me/ledger
// @access  Private
exports.getLedger = asyncHandler(async (req, res, next) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const startIndex = (page - 1) * limit;

  let query = { customerId: req.user.customerId };
  if (req.query.type) query.type = req.query.type;

  const total = await LoyaltyLedger.countDocuments(query);

  const ledger = await LoyaltyLedger.find(query)
    .populate('orderId', 'orderNumber')
    .sort('-createdAt')
    .skip(startIndex)
    .limit(limit);

  res.status(200).json({
    success: true,
    message: 'Ledger fetched successfully',
    data: { ledger },
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

// @desc    Get customer loyalty (admin)
// @route   GET /api/v1/loyalty/customer/:customerId
// @access  Private (Admin/Manager)
exports.getCustomerLoyalty = asyncHandler(async (req, res, next) => {
  const customer = await Customer.findById(req.params.customerId)
    .populate('loyaltyTierId');

  if (!customer) {
    return next(new AppError('Customer not found', 404));
  }

  const ledger = await LoyaltyLedger.find({ customerId: req.params.customerId })
    .sort('-createdAt')
    .limit(20);

  res.status(200).json({
    success: true,
    message: 'Customer loyalty fetched successfully',
    data: {
      pointsBalance: customer.loyaltyPointsBalance,
      lifetimePoints: customer.loyaltyLifetimePoints,
      tier: customer.loyaltyTierId,
      recentLedger: ledger,
    },
  });
});

// @desc    Adjust loyalty points
// @route   POST /api/v1/loyalty/adjust
// @access  Private (Admin/Manager)
exports.adjustPoints = asyncHandler(async (req, res, next) => {
  const { customerId, points, reason } = req.body;

  const delta = parseInt(points, 10);
  if (!Number.isFinite(delta) || delta === 0) {
    return next(new AppError('points must be a non-zero number', 400));
  }

  const existing = await Customer.findById(customerId).select('loyaltyPointsBalance').lean();
  if (!existing) {
    return next(new AppError('Customer not found', 404));
  }

  // Atomic adjustment. A negative delta is guarded so a deduction can never drive
  // the balance below zero, and the read-modify-write that could lose a concurrent
  // adjustment is gone.
  const inc = { loyaltyPointsBalance: delta };
  if (delta > 0) inc.loyaltyLifetimePoints = delta;

  const customer = await Customer.findOneAndUpdate(
    delta < 0
      ? { _id: customerId, loyaltyPointsBalance: { $gte: -delta } }
      : { _id: customerId },
    { $inc: inc },
    { new: true }
  );

  if (!customer) {
    return next(new AppError(
      `Insufficient points balance. Customer has ${existing.loyaltyPointsBalance || 0} points.`,
      400
    ));
  }

  await LoyaltyLedger.create({
    customerId,
    points: delta,
    type: 'adjust',
    reason: reason || 'Manual adjustment',
    balanceAfter: customer.loyaltyPointsBalance,
  });

  await logAudit({
    actorUserId: req.user.id,
    action: 'LOYALTY_POINTS_ADJUSTED',
    targetType: 'Customer',
    targetId: String(customerId),
    before: { pointsBalance: existing.loyaltyPointsBalance || 0 },
    after: { pointsBalance: customer.loyaltyPointsBalance },
    metadata: { delta, reason: reason || 'Manual adjustment' },
  });

  res.status(200).json({
    success: true,
    message: 'Points adjusted successfully',
    data: {
      pointsBalance: customer.loyaltyPointsBalance,
      lifetimePoints: customer.loyaltyLifetimePoints,
    },
  });
});

// @desc    Redeem loyalty points for discount
// @route   POST /api/v1/loyalty/redeem
// @access  Private
exports.redeemPoints = asyncHandler(async (req, res, next) => {
  const { points, orderId } = req.body;

  // ── Whose points are being spent ──────────────────────────────────────────
  // customerId used to be taken from the request body with no ownership check
  // at all, on a route guarded only by `protect`. Any signed-in customer could
  // spend — and so destroy — any other customer's points, which are convertible
  // to wallet money. A customer may now only ever redeem their own; staff keep
  // the ability to redeem on a customer's behalf at the counter.
  const isStaffRole = ['staff', 'admin', 'manager', 'receptionist', 'developer'].includes(req.user.role);
  const customerId = isStaffRole && req.body.customerId ? req.body.customerId : req.user.customerId;

  if (!customerId) {
    return next(new AppError('No customer profile linked to this account', 400));
  }
  if (!isStaffRole && req.body.customerId && String(req.body.customerId) !== String(req.user.customerId)) {
    return next(new AppError('Not authorized to redeem another customer\'s points', 403));
  }

  const requestedPoints = parseInt(points, 10);
  if (!orderId) {
    return next(new AppError('Please provide an orderId', 400));
  }
  if (!Number.isFinite(requestedPoints) || requestedPoints <= 0) {
    return next(new AppError('Points must be greater than 0', 400));
  }

  // Honour the same switches every other redemption path honours.
  const settings = await loadLoyaltySettings();
  if (!require('../utils/loyaltyRates.js').redemptionAvailable(settings)) {
    return next(new AppError('Points redemption is currently unavailable.', 403, 'LOYALTY_REDEMPTION_DISABLED'));
  }

  // Atomic check-and-deduct. This was a read, a compare and a save — three
  // steps, so two concurrent calls both passed the balance check and the
  // customer kept points they had already spent.
  const customer = await Customer.findOneAndUpdate(
    { _id: customerId, loyaltyPointsBalance: { $gte: requestedPoints } },
    { $inc: { loyaltyPointsBalance: -requestedPoints } },
    { new: true }
  );
  if (!customer) {
    return next(new AppError('Insufficient loyalty points', 400));
  }

  // Discount comes from the configured redemption rate. This was
  // `const discountAmount = points` — a third hardcoded rate (1 point = ₦1),
  // different again from both the wallet page and checkout.
  const discountAmount = require('../utils/loyaltyRates.js').discountForPoints(requestedPoints, settings);

  let transaction;
  try {
    transaction = await LoyaltyLedger.create({
      customerId,
      points: -requestedPoints,
      type: 'redeem',
      reason: `Redeemed for order ${orderId}`,
      orderId,
      balanceAfter: customer.loyaltyPointsBalance,
    });
  } catch (ledgerErr) {
    // Points are already deducted — hand them back rather than lose them.
    await Customer.findByIdAndUpdate(customerId, {
      $inc: { loyaltyPointsBalance: requestedPoints },
    }).catch((e) => logger.error(`[redeemPoints] CRITICAL point rollback failed: ${e.message}`));

    if (ledgerErr.code === 11000) {
      return next(new AppError('Points have already been redeemed for this order', 409));
    }
    logger.error(`[redeemPoints] Ledger write failed: ${ledgerErr.message}`);
    return next(new AppError('Redemption could not be completed. Your points have not been deducted.', 500));
  }

  // Emit Socket.io event for realtime update (if Socket.io is available)
  const io = req.app.get('io');
  if (io) {
    io.to(`user-${customerId}`).emit('loyalty:points-updated', {
      balance: customer.loyaltyPointsBalance,
      transaction: {
        id: transaction._id,
        points: transaction.points,
        type: transaction.type,
        reason: transaction.reason,
        createdAt: transaction.createdAt,
      },
    });
  }

  res.status(200).json({
    success: true,
    message: 'Points redeemed successfully',
    data: {
      discountAmount,
      newBalance: customer.loyaltyPointsBalance,
      transaction: {
        id: transaction._id,
        points: transaction.points,
        type: transaction.type,
        reason: transaction.reason,
        createdAt: transaction.createdAt,
      },
    },
  });
});

// ============================================================================
// LOYALTY SETTINGS
// ============================================================================

// @desc    Get loyalty settings
// @route   GET /api/v1/loyalty/settings
// @access  Private (Admin/Manager)
exports.getSettings = asyncHandler(async (req, res, next) => {
  let settings = await LoyaltySetting.findOne();

  if (!settings) {
    settings = await LoyaltySetting.create({});
  }

  res.status(200).json({
    success: true,
    message: 'Loyalty settings fetched successfully',
    data: settings,
  });
});

// @desc    Update loyalty settings
// @route   PATCH /api/v1/loyalty/settings
// @access  Private (Admin)
// Fields an admin may actually set. Object.assign(settings, req.body) copied
// anything the request contained, including _id and fields that are not settings
// at all, and applied no validation — a rate of 0 or a negative rate would have
// been accepted and then divided by.
const SETTING_BOOLEANS = [
  'enabled', 'redemptionEnabled', 'walletConversionEnabled',
  'redeemIncludesDelivery', 'redeemIncludesAddons',
  'allowWithSubscription', 'weekendMultiplierEnabled',
];
// Rates: must be greater than zero, because every one of them is a divisor or a
// multiplier on money.
const SETTING_POSITIVE_NUMBERS = [
  'pointsPerCurrency', 'redemptionPointsPerCurrency', 'walletConversionRate',
];
// Thresholds and bonuses: zero is a legitimate value ("no minimum", "no bonus").
const SETTING_NON_NEGATIVE_NUMBERS = [
  'minOrderAmount', 'maxPointsPerOrder', 'maxPointsPerDay',
  'minRedeemPoints', 'minConvertPoints', 'maxRedeemPercent', 'maxRedeemPointsPerOrder',
  'bonusStandardPercent', 'bonusExpressPercent', 'bonusPremiumPercent',
  'bonusFirstOrderPoints', 'bonusSecondOrderPoints', 'weekendMultiplierPercent',
  'bonusStainRemoval', 'bonusRush', 'bonusPickupDelivery',
];

exports.updateSettings = asyncHandler(async (req, res, next) => {
  const update = {};

  for (const key of SETTING_BOOLEANS) {
    if (req.body[key] !== undefined) update[key] = Boolean(req.body[key]);
  }

  for (const key of SETTING_POSITIVE_NUMBERS) {
    if (req.body[key] === undefined) continue;
    const n = Number(req.body[key]);
    if (!Number.isFinite(n) || n <= 0) {
      return next(new AppError(`'${key}' must be a number greater than 0`, 400, 'VALIDATION_ERROR'));
    }
    update[key] = n;
  }

  for (const key of SETTING_NON_NEGATIVE_NUMBERS) {
    if (req.body[key] === undefined) continue;
    const n = Number(req.body[key]);
    if (!Number.isFinite(n) || n < 0) {
      return next(new AppError(`'${key}' must be a number of 0 or more`, 400, 'VALIDATION_ERROR'));
    }
    update[key] = n;
  }

  if (req.body.qualifyOnStatus !== undefined) {
    if (!['paid', 'completed'].includes(req.body.qualifyOnStatus)) {
      return next(new AppError("'qualifyOnStatus' must be 'paid' or 'completed'", 400, 'VALIDATION_ERROR'));
    }
    update.qualifyOnStatus = req.body.qualifyOnStatus;
  }

  if (update.maxRedeemPercent !== undefined && update.maxRedeemPercent > 100) {
    return next(new AppError("'maxRedeemPercent' cannot exceed 100", 400, 'VALIDATION_ERROR'));
  }

  let settings = await LoyaltySetting.findOne();
  const before = settings ? settings.toObject() : null;

  if (!settings) {
    settings = await LoyaltySetting.create(update);
  } else {
    Object.assign(settings, update);
    await settings.save();
  }

  // Rates are money. Record who changed them and what they were.
  await logAudit({
    actorUserId: req.user.id,
    action: 'LOYALTY_SETTINGS_UPDATED',
    targetType: 'LoyaltySetting',
    targetId: settings._id.toString(),
    before: before && {
      walletConversionRate: before.walletConversionRate,
      redemptionPointsPerCurrency: before.redemptionPointsPerCurrency,
      enabled: before.enabled,
      walletConversionEnabled: before.walletConversionEnabled,
      redemptionEnabled: before.redemptionEnabled,
    },
    after: {
      walletConversionRate: settings.walletConversionRate,
      redemptionPointsPerCurrency: settings.redemptionPointsPerCurrency,
      enabled: settings.enabled,
      walletConversionEnabled: settings.walletConversionEnabled,
      redemptionEnabled: settings.redemptionEnabled,
    },
  });

  res.status(200).json({
    success: true,
    message: 'Loyalty settings updated successfully',
    data: settings,
  });
});

// ============================================================================
// LOYALTY TRANSACTIONS (Admin)
// ============================================================================

// @desc    Get all loyalty transactions
// @route   GET /api/v1/loyalty/transactions
// @access  Private (Admin/Manager)
exports.getTransactions = asyncHandler(async (req, res, next) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const startIndex = (page - 1) * limit;

  let query = {};
  if (req.query.type) query.type = req.query.type;
  if (req.query.customerId) query.customerId = req.query.customerId;

  const total = await LoyaltyLedger.countDocuments(query);

  const transactions = await LoyaltyLedger.find(query)
    .populate('customerId', 'firstName lastName email')
    .populate('orderId', 'orderNumber')
    .sort('-createdAt')
    .skip(startIndex)
    .limit(limit);

  res.status(200).json({
    success: true,
    message: 'Transactions fetched successfully',
    data: { transactions },
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

// ============================================================================
// CONVERT POINTS TO WALLET MONEY
// ============================================================================

// @desc    Convert loyalty points to wallet balance
// @route   POST /api/v1/loyalty/convert
// @access  Private (Customer)
exports.convertPointsToWallet = asyncHandler(async (req, res, next) => {
  if (!req.user.customerId) {
    return next(new AppError('No customer profile linked to this account', 400));
  }

  const points = parseInt(req.body.points, 10);
  if (!points || points <= 0) {
    return next(new AppError('Points must be a positive number', 400));
  }

  // Settings are re-read from the database on every conversion, so a rate the
  // customer's page loaded minutes ago can never be the one that is honoured.
  const settings = await loadLoyaltySettings();

  // conversionAvailable() covers the master programme switch as well as the
  // channel switch — hiding a button is not enforcement, this is.
  if (!conversionAvailable(settings)) {
    return next(new AppError(
      settings?.enabled === false
        ? 'The loyalty programme is currently unavailable.'
        : 'Points conversion is currently unavailable.',
      403,
      'LOYALTY_CONVERSION_DISABLED'
    ));
  }

  const conversionRate = require('../utils/loyaltyRates.js').walletPointsPerNaira(settings);
  const minConvert     = settings.minConvertPoints || 0;

  if (minConvert > 0 && points < minConvert) {
    return next(new AppError(`Minimum ${minConvert.toLocaleString()} points required to convert`, 400));
  }

  // The wallet credit is computed here, from the current stored rate. The client
  // sends a number of points and nothing else.
  const walletAmount = walletCreditForPoints(points, settings);
  if (walletAmount <= 0) {
    return next(new AppError(`Not enough points. ${conversionRate.toLocaleString()} points = ₦1`, 400));
  }

  // Atomic deduction — prevents race condition double-spend
  const updatedCustomer = await Customer.findOneAndUpdate(
    { _id: req.user.customerId, loyaltyPointsBalance: { $gte: points } },
    { $inc: { loyaltyPointsBalance: -points } },
    { new: true }
  );
  if (!updatedCustomer) {
    return next(new AppError('Insufficient points balance', 400));
  }

  // ── Credit the wallet, or give the points back ────────────────────────────
  // The points are already gone at this point. Everything from here is wrapped
  // so that a failure returns them: previously a wallet write that threw left
  // the customer with neither their points nor the credit, and nothing to
  // reconcile from. There is no replica set guaranteed on this deployment, so
  // this is a compensating rollback rather than a driver transaction.
  let wallet;
  try {
    wallet = await Wallet.findOneAndUpdate(
      { customerId: req.user.customerId },
      { $inc: { balance: walletAmount } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    await WalletTransaction.create({
      walletId: wallet._id,
      customerId: req.user.customerId,
      type: 'credit',
      amount: walletAmount,
      reason: `Points Conversion (${points.toLocaleString()} pts)`,
      balanceAfter: wallet.balance,
      source: 'loyalty',
    });

    // Record in loyalty ledger
    await LoyaltyLedger.create({
      customerId: req.user.customerId,
      points: -points,
      type: 'convert',
      source: 'conversion',
      reason: `Converted ${points.toLocaleString()} pts → ₦${walletAmount.toLocaleString()} wallet credit`,
      balanceAfter: updatedCustomer.loyaltyPointsBalance,
      nairaAmount: walletAmount,
    });
  } catch (creditErr) {
    logger.error(
      `[convertPoints] Credit failed after deducting ${points} pts from customer ` +
      `${req.user.customerId} — rolling back: ${creditErr.message}`
    );

    // Undo the wallet credit first if it landed, then return the points.
    if (wallet) {
      await Wallet.findOneAndUpdate(
        { customerId: req.user.customerId },
        { $inc: { balance: -walletAmount } }
      ).catch((e) => logger.error(`[convertPoints] Wallet rollback failed: ${e.message}`));
    }
    await Customer.findByIdAndUpdate(req.user.customerId, {
      $inc: { loyaltyPointsBalance: points },
    }).catch((e) => logger.error(`[convertPoints] CRITICAL point rollback failed: ${e.message}`));

    return next(new AppError('Conversion could not be completed. Your points have not been deducted.', 500));
  }

  // Real-time updates
  const io = req.app.get('io');
  if (io) {
    io.to(`user-${req.user.customerId}`).emit('loyalty:points-updated', {
      balance: updatedCustomer.loyaltyPointsBalance,
      transaction: { points: -points, type: 'convert', reason: 'Points Conversion' },
    });
    io.to(`user-${req.user.customerId}`).emit('wallet:credited', {
      balance: wallet.balance,
      amount: walletAmount,
      reason: 'Points Conversion',
    });
  }

  await notify(io, {
    type: 'wallet_credited',
    title: 'Wallet Credited',
    body: `₦${walletAmount.toLocaleString()} has been added to your wallet from converting ${points.toLocaleString()} loyalty points.`,
    customerId: String(req.user.customerId),
    metadata: { points, walletAmount },
  });

  res.status(200).json({
    success: true,
    message: `Successfully converted ${points.toLocaleString()} points to ₦${walletAmount.toLocaleString()}`,
    data: {
      pointsDeducted:   points,
      walletCredited:   walletAmount,
      newPointsBalance: updatedCustomer.loyaltyPointsBalance,
      newWalletBalance: wallet.balance,
    },
  });
});
