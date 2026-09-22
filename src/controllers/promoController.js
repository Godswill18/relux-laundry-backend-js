const PromoCode = require('../models/PromoCode.js');
const PromoRedemption = require('../models/PromoRedemption.js');
const Order = require('../models/Order.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');
const { customerCanAccessOrder } = require('../utils/customerIdentity.js');

// @desc    Get all promo codes
// @route   GET /api/v1/promos
// @access  Private (Admin/Manager)
exports.getPromoCodes = asyncHandler(async (req, res, next) => {
  let query = {};
  if (req.query.active !== undefined) query.active = req.query.active === 'true';
  if (req.query.type) query.type = req.query.type;

  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 10;
  const startIndex = (page - 1) * limit;

  const total = await PromoCode.countDocuments(query);

  const promoCodes = await PromoCode.find(query)
    .sort('-createdAt')
    .skip(startIndex)
    .limit(limit);

  // Attach live usage counts in one aggregation query
  const redemptionCounts = await PromoRedemption.aggregate([
    { $match: { promoCodeId: { $in: promoCodes.map((p) => p._id) } } },
    { $group: { _id: '$promoCodeId', count: { $sum: 1 } } },
  ]);
  const countMap = new Map(redemptionCounts.map((r) => [r._id.toString(), r.count]));

  const promoCodesWithCount = promoCodes.map((p) => ({
    ...p.toObject(),
    usageCount: countMap.get(p._id.toString()) || 0,
  }));

  res.status(200).json({
    success: true,
    message: 'Promo codes fetched successfully',
    data: { promoCodes: promoCodesWithCount },
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

// @desc    Get single promo code
// @route   GET /api/v1/promos/:id
// @access  Private (Admin/Manager)
exports.getPromoCode = asyncHandler(async (req, res, next) => {
  const promoCode = await PromoCode.findById(req.params.id);

  if (!promoCode) {
    return next(new AppError('Promo code not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Promo code fetched successfully',
    data: { promoCode },
  });
});

// @desc    Create promo code
// @route   POST /api/v1/promos
// @access  Private (Admin/Manager)
exports.createPromoCode = asyncHandler(async (req, res, next) => {
  const { code, type, value, usageLimit, usagePerUser, expiresAt } = req.body;

  const existing = await PromoCode.findOne({ code: code.toUpperCase() });
  if (existing) {
    return next(new AppError('Promo code already exists', 400));
  }

  const promoCode = await PromoCode.create({
    code,
    type,
    value,
    usageLimit,
    usagePerUser: usagePerUser ?? 1,
    expiresAt,
  });

  res.status(201).json({
    success: true,
    message: 'Promo code created successfully',
    data: { promoCode },
  });
});

// @desc    Update promo code
// @route   PUT /api/v1/promos/:id
// @access  Private (Admin/Manager)
exports.updatePromoCode = asyncHandler(async (req, res, next) => {
  const fieldsToUpdate = {
    code: req.body.code,
    type: req.body.type,
    value: req.body.value,
    usageLimit: req.body.usageLimit,
    usagePerUser: req.body.usagePerUser,
    expiresAt: req.body.expiresAt,
    active: req.body.active,
  };

  Object.keys(fieldsToUpdate).forEach(
    (key) => fieldsToUpdate[key] === undefined && delete fieldsToUpdate[key]
  );

  const promoCode = await PromoCode.findByIdAndUpdate(req.params.id, fieldsToUpdate, {
    new: true,
    runValidators: true,
  });

  if (!promoCode) {
    return next(new AppError('Promo code not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Promo code updated successfully',
    data: { promoCode },
  });
});

// @desc    Delete promo code
// @route   DELETE /api/v1/promos/:id
// @access  Private (Admin)
exports.deletePromoCode = asyncHandler(async (req, res, next) => {
  const promoCode = await PromoCode.findById(req.params.id);

  if (!promoCode) {
    return next(new AppError('Promo code not found', 404));
  }

  await promoCode.deleteOne();

  res.status(200).json({
    success: true,
    message: 'Promo code deleted successfully',
    data: {},
  });
});

// @desc    Validate promo code
// @route   POST /api/v1/promos/validate
// @access  Private
exports.validatePromoCode = asyncHandler(async (req, res, next) => {
  const { code } = req.body;

  const promoCode = await PromoCode.findOne({ code: code.toUpperCase(), active: true });

  if (!promoCode) {
    return next(new AppError('Invalid or inactive promo code', 400));
  }

  if (promoCode.expiresAt && new Date(promoCode.expiresAt) < new Date()) {
    return next(new AppError('Promo code has expired', 400));
  }

  const totalUsage = await PromoRedemption.countDocuments({ promoCodeId: promoCode._id });

  if (promoCode.usageLimit && totalUsage >= promoCode.usageLimit) {
    return next(new AppError('Promo code usage limit reached', 400));
  }

  // Per-user limit check
  if (req.user?.customerId && promoCode.usagePerUser > 0) {
    const userUsage = await PromoRedemption.countDocuments({
      promoCodeId: promoCode._id,
      customerId: req.user.customerId,
    });
    if (userUsage >= promoCode.usagePerUser) {
      return next(new AppError(
        promoCode.usagePerUser === 1
          ? 'You have already used this promo code'
          : `You can only use this promo code ${promoCode.usagePerUser} time(s)`,
        400
      ));
    }
  }

  res.status(200).json({
    success: true,
    message: 'Promo code is valid',
    data: { promoCode, usageCount: totalUsage },
  });
});

// @desc    Redeem promo code
// @route   POST /api/v1/promos/redeem
// @access  Private
exports.redeemPromoCode = asyncHandler(async (req, res, next) => {
  const { code, orderId } = req.body;

  if (!code || !orderId) {
    return next(new AppError('A promo code and an order are required', 400));
  }

  const promoCode = await PromoCode.findOne({ code: String(code).toUpperCase(), active: true });

  if (!promoCode) {
    return next(new AppError('Invalid or inactive promo code', 400));
  }

  if (promoCode.expiresAt && new Date(promoCode.expiresAt) < new Date()) {
    return next(new AppError('This promo code has expired', 400));
  }

  // ── The order must be one the caller may actually act on ──────────────────
  // orderId was taken from the body with no check that it belonged to anyone in
  // particular, so a customer could burn a campaign's global usage slots against
  // other people's orders — and, with usageLimit set, exhaust it outright.
  const order = await Order.findById(orderId).select('customer customerId total pricing');
  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  const isStaffRole = ['staff', 'admin', 'manager', 'receptionist', 'developer'].includes(req.user.role);
  if (!isStaffRole && !customerCanAccessOrder(req.user, order)) {
    return next(new AppError('Not authorized to apply a promo code to this order', 403));
  }

  const existingRedemption = await PromoRedemption.findOne({ orderId });
  if (existingRedemption) {
    return next(new AppError('Promo already applied to this order', 400));
  }

  // ── The discount is computed here, never accepted from the caller ─────────
  // `amount` used to come straight from the request body into the redemption
  // record, so the figure the business reports as promo cost was whatever the
  // client claimed. It is derived from the code and the order total instead.
  const orderTotal = order.total || order.pricing?.total || 0;
  const rawDiscount = promoCode.type === 'percent'
    ? Math.round(orderTotal * promoCode.value / 100)
    : promoCode.value;
  const amount = Math.max(0, Math.min(rawDiscount, orderTotal));

  if (amount <= 0) {
    return next(new AppError('This promo code has no value on this order', 400));
  }

  // Per-user limit check
  if (req.user?.customerId && promoCode.usagePerUser > 0) {
    const userUsage = await PromoRedemption.countDocuments({
      promoCodeId: promoCode._id,
      customerId: req.user.customerId,
    });
    if (userUsage >= promoCode.usagePerUser) {
      return next(new AppError(
        promoCode.usagePerUser === 1
          ? 'You have already used this promo code'
          : `You can only use this promo code ${promoCode.usagePerUser} time(s)`,
        400
      ));
    }
  }

  const redemption = await PromoRedemption.create({
    promoCodeId: promoCode._id,
    orderId,
    customerId: req.user.customerId,
    amount,
  });

  // Auto-disable when total usage limit is reached
  if (promoCode.usageLimit) {
    const totalUsage = await PromoRedemption.countDocuments({ promoCodeId: promoCode._id });
    if (totalUsage >= promoCode.usageLimit) {
      await PromoCode.findByIdAndUpdate(promoCode._id, { active: false });
    }
  }

  res.status(201).json({
    success: true,
    message: 'Promo code redeemed successfully',
    data: { redemption },
  });
});

// @desc    Get redemptions for a promo code
// @route   GET /api/v1/promos/:id/redemptions
// @access  Private (Admin/Manager)
exports.getRedemptions = asyncHandler(async (req, res, next) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 10;
  const startIndex = (page - 1) * limit;

  const total = await PromoRedemption.countDocuments({ promoCodeId: req.params.id });

  const redemptions = await PromoRedemption.find({ promoCodeId: req.params.id })
    .populate('orderId', 'orderNumber total')
    .populate('customerId', 'name phone')
    .sort('-createdAt')
    .skip(startIndex)
    .limit(limit);

  res.status(200).json({
    success: true,
    message: 'Redemptions fetched successfully',
    data: { redemptions },
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});
