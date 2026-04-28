const LoyaltyTier = require('../models/LoyaltyTier.js');
const LoyaltyLedger = require('../models/LoyaltyLedger.js');
const LoyaltySetting = require('../models/LoyaltySetting.js');
const Customer = require('../models/Customer.js');
const Wallet = require('../models/Wallet.js');
const WalletTransaction = require('../models/WalletTransaction.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');
const notify = require('../utils/notify.js');

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

  res.status(200).json({
    success: true,
    message: 'Loyalty info fetched successfully',
    data: {
      pointsBalance: customer.loyaltyPointsBalance,
      lifetimePoints: customer.loyaltyLifetimePoints,
      tier: customer.loyaltyTierId,
      conversionEnabled: settings?.walletConversionEnabled !== false,
      walletConversionRate: settings?.walletConversionRate || 100,
      minConvertPoints: settings?.minConvertPoints || 100,
      pointsPerCurrency: settings?.pointsPerCurrency || 1,
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

  const customer = await Customer.findById(customerId);
  if (!customer) {
    return next(new AppError('Customer not found', 404));
  }

  customer.loyaltyPointsBalance += points;
  if (points > 0) {
    customer.loyaltyLifetimePoints += points;
  }
  await customer.save();

  await LoyaltyLedger.create({
    customerId,
    points,
    type: 'adjust',
    reason: reason || 'Manual adjustment',
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
  const { customerId, points, orderId } = req.body;

  // Validate required fields
  if (!customerId || !points || !orderId) {
    return next(new AppError('Please provide customerId, points, and orderId', 400));
  }

  // Validate points is a positive number
  if (points <= 0) {
    return next(new AppError('Points must be greater than 0', 400));
  }

  // Get customer
  const customer = await Customer.findById(customerId);
  if (!customer) {
    return next(new AppError('Customer not found', 404));
  }

  // Check if customer has enough points
  if (customer.loyaltyPointsBalance < points) {
    return next(new AppError('Insufficient loyalty points', 400));
  }

  // Calculate discount (1 point = ₦1)
  const discountAmount = points;

  // Deduct points
  customer.loyaltyPointsBalance -= points;
  await customer.save();

  // Create ledger transaction
  const transaction = await LoyaltyLedger.create({
    customerId,
    points: -points,
    type: 'redeem',
    reason: `Redeemed for order ${orderId}`,
    orderId,
  });

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
exports.updateSettings = asyncHandler(async (req, res, next) => {
  let settings = await LoyaltySetting.findOne();

  if (!settings) {
    settings = await LoyaltySetting.create(req.body);
  } else {
    Object.assign(settings, req.body);
    await settings.save();
  }

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

  // Load loyalty settings
  const settings = await LoyaltySetting.findOne().lean();
  if (!settings || !settings.enabled) {
    return next(new AppError('Loyalty program is currently disabled', 400));
  }
  if (settings.walletConversionEnabled === false) {
    return next(new AppError('Points-to-wallet conversion is currently disabled', 400));
  }

  const conversionRate = settings.walletConversionRate || 100; // X points = ₦1
  const minConvert     = settings.minConvertPoints     || 100;

  if (points < minConvert) {
    return next(new AppError(`Minimum ${minConvert} points required to convert`, 400));
  }

  const walletAmount = Math.floor(points / conversionRate);
  if (walletAmount <= 0) {
    return next(new AppError(`Not enough points. ${conversionRate} points = ₦1`, 400));
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

  // Credit wallet
  let wallet = await Wallet.findOne({ customerId: req.user.customerId });
  if (!wallet) {
    wallet = await Wallet.create({ customerId: req.user.customerId, balance: 0 });
  }
  wallet.balance += walletAmount;
  await wallet.save();

  await WalletTransaction.create({
    walletId: wallet._id,
    customerId: req.user.customerId,
    type: 'credit',
    amount: walletAmount,
    reason: `Points Conversion (${points.toLocaleString()} pts)`,
    balanceAfter: wallet.balance,
  });

  // Record in loyalty ledger
  await LoyaltyLedger.create({
    customerId: req.user.customerId,
    points: -points,
    type: 'convert',
    source: 'conversion',
    reason: `Converted ${points.toLocaleString()} pts → ₦${walletAmount.toLocaleString()} wallet credit`,
    balanceAfter: updatedCustomer.loyaltyPointsBalance,
  });

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
