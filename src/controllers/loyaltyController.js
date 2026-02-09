const LoyaltyTier = require('../models/LoyaltyTier.js');
const LoyaltyLedger = require('../models/LoyaltyLedger.js');
const Customer = require('../models/Customer.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');

// @desc    Get all loyalty tiers
// @route   GET /api/v1/loyalty/tiers
// @access  Private
exports.getTiers = asyncHandler(async (req, res, next) => {
  let query = {};
  if (req.query.active !== undefined) query.active = req.query.active === 'true';

  const tiers = await LoyaltyTier.find(query).sort('rank');

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
  const customer = await Customer.findById(req.user.customerId)
    .populate('loyaltyTierId', 'name rank multiplierPercent freePickup freeDelivery priorityTurnaround');

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
