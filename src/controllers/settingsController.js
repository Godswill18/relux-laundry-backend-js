const PaymentSetting = require('../models/PaymentSetting.js');
const NotificationSetting = require('../models/NotificationSetting.js');
const ReferralSetting = require('../models/ReferralSetting.js');
const LoyaltySetting = require('../models/LoyaltySetting.js');
const ServiceLevelConfig = require('../models/ServiceLevelConfig.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');

// ========== PAYMENT SETTINGS ==========

// @desc    Get payment settings
// @route   GET /api/v1/settings/payment
// @access  Private (Admin)
exports.getPaymentSettings = asyncHandler(async (req, res, next) => {
  let settings = await PaymentSetting.findOne();

  if (!settings) {
    settings = await PaymentSetting.create({});
  }

  res.status(200).json({
    success: true,
    message: 'Payment settings fetched successfully',
    data: { settings },
  });
});

// @desc    Update payment settings
// @route   PUT /api/v1/settings/payment
// @access  Private (Admin)
exports.updatePaymentSettings = asyncHandler(async (req, res, next) => {
  const settings = await PaymentSetting.findOneAndUpdate({}, req.body, {
    new: true,
    upsert: true,
    runValidators: true,
  });

  res.status(200).json({
    success: true,
    message: 'Payment settings updated successfully',
    data: { settings },
  });
});

// ========== NOTIFICATION SETTINGS ==========

// @desc    Get notification settings
// @route   GET /api/v1/settings/notification
// @access  Private (Admin)
exports.getNotificationSettings = asyncHandler(async (req, res, next) => {
  let settings = await NotificationSetting.findOne();

  if (!settings) {
    settings = await NotificationSetting.create({});
  }

  res.status(200).json({
    success: true,
    message: 'Notification settings fetched successfully',
    data: { settings },
  });
});

// @desc    Update notification settings
// @route   PUT /api/v1/settings/notification
// @access  Private (Admin)
exports.updateNotificationSettings = asyncHandler(async (req, res, next) => {
  const settings = await NotificationSetting.findOneAndUpdate({}, req.body, {
    new: true,
    upsert: true,
    runValidators: true,
  });

  res.status(200).json({
    success: true,
    message: 'Notification settings updated successfully',
    data: { settings },
  });
});

// ========== REFERRAL SETTINGS ==========

// @desc    Get referral settings
// @route   GET /api/v1/settings/referral
// @access  Private (Admin)
exports.getReferralSettings = asyncHandler(async (req, res, next) => {
  let settings = await ReferralSetting.findOne();

  if (!settings) {
    settings = await ReferralSetting.create({});
  }

  res.status(200).json({
    success: true,
    message: 'Referral settings fetched successfully',
    data: { settings },
  });
});

// @desc    Update referral settings
// @route   PUT /api/v1/settings/referral
// @access  Private (Admin)
exports.updateReferralSettings = asyncHandler(async (req, res, next) => {
  const settings = await ReferralSetting.findOneAndUpdate({}, req.body, {
    new: true,
    upsert: true,
    runValidators: true,
  });

  res.status(200).json({
    success: true,
    message: 'Referral settings updated successfully',
    data: { settings },
  });
});

// ========== LOYALTY SETTINGS ==========

// @desc    Get loyalty settings
// @route   GET /api/v1/settings/loyalty
// @access  Private (Admin)
exports.getLoyaltySettings = asyncHandler(async (req, res, next) => {
  let settings = await LoyaltySetting.findOne();

  if (!settings) {
    settings = await LoyaltySetting.create({});
  }

  res.status(200).json({
    success: true,
    message: 'Loyalty settings fetched successfully',
    data: { settings },
  });
});

// @desc    Update loyalty settings
// @route   PUT /api/v1/settings/loyalty
// @access  Private (Admin)
exports.updateLoyaltySettings = asyncHandler(async (req, res, next) => {
  const settings = await LoyaltySetting.findOneAndUpdate({}, req.body, {
    new: true,
    upsert: true,
    runValidators: true,
  });

  res.status(200).json({
    success: true,
    message: 'Loyalty settings updated successfully',
    data: { settings },
  });
});

// ========== SERVICE LEVEL CONFIGS ==========

// @desc    Get service level configs
// @route   GET /api/v1/settings/service-levels
// @access  Private
exports.getServiceLevelConfigs = asyncHandler(async (req, res, next) => {
  const configs = await ServiceLevelConfig.find().sort('level');

  res.status(200).json({
    success: true,
    message: 'Service level configs fetched successfully',
    data: { configs },
  });
});

// @desc    Create service level config
// @route   POST /api/v1/settings/service-levels
// @access  Private (Admin)
exports.createServiceLevelConfig = asyncHandler(async (req, res, next) => {
  const { level, priceMultiplier, durationHours, active } = req.body;

  const config = await ServiceLevelConfig.create({
    level,
    priceMultiplier,
    durationHours,
    active,
  });

  res.status(201).json({
    success: true,
    message: 'Service level config created successfully',
    data: { config },
  });
});

// @desc    Update service level config
// @route   PUT /api/v1/settings/service-levels/:id
// @access  Private (Admin)
exports.updateServiceLevelConfig = asyncHandler(async (req, res, next) => {
  const fieldsToUpdate = {
    priceMultiplier: req.body.priceMultiplier,
    durationHours: req.body.durationHours,
    active: req.body.active,
  };

  Object.keys(fieldsToUpdate).forEach(
    (key) => fieldsToUpdate[key] === undefined && delete fieldsToUpdate[key]
  );

  const config = await ServiceLevelConfig.findByIdAndUpdate(req.params.id, fieldsToUpdate, {
    new: true,
    runValidators: true,
  });

  if (!config) {
    return next(new AppError('Service level config not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Service level config updated successfully',
    data: { config },
  });
});
