const PaymentSetting = require('../models/PaymentSetting.js');
const NotificationSetting = require('../models/NotificationSetting.js');
const ReferralSetting = require('../models/ReferralSetting.js');
const LoyaltySetting = require('../models/LoyaltySetting.js');
const ServiceLevelConfig = require('../models/ServiceLevelConfig.js');
const StageDurationSetting = require('../models/StageDurationSetting.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');

// ========== PAYMENT SETTINGS ==========

// @desc    Get payment settings
// @route   GET /api/v1/settings/payment
// @access  Private (Admin)
exports.getPaymentSettings = asyncHandler(async (req, res, next) => {
  // Select secret key fields only to check if they are set (never expose them)
  let settings = await PaymentSetting.findOne()
    .select('+paystackSecretKey +lencoSecretKey +flutterwaveSecretKey');

  if (!settings) {
    settings = await PaymentSetting.create({});
  }

  const paystackSecretKeySet     = !!settings.paystackSecretKey;
  const lencoSecretKeySet        = !!settings.lencoSecretKey;
  const flutterwaveSecretKeySet  = !!settings.flutterwaveSecretKey;

  // Convert to plain object and strip actual secret values
  const settingsObj = settings.toObject();
  delete settingsObj.paystackSecretKey;
  delete settingsObj.lencoSecretKey;
  delete settingsObj.flutterwaveSecretKey;

  res.status(200).json({
    success: true,
    message: 'Payment settings fetched successfully',
    data: {
      settings: settingsObj,
      paystackSecretKeySet,
      lencoSecretKeySet,
      flutterwaveSecretKeySet,
    },
  });
});

// @desc    Update payment settings
// @route   PUT /api/v1/settings/payment
// @access  Private (Admin)
exports.updatePaymentSettings = asyncHandler(async (req, res, next) => {
  const update = { ...req.body };

  // Never overwrite a secret key with an empty string — only update if value provided
  if (!update.paystackSecretKey)    delete update.paystackSecretKey;
  if (!update.lencoSecretKey)       delete update.lencoSecretKey;
  if (!update.flutterwaveSecretKey) delete update.flutterwaveSecretKey;

  const settings = await PaymentSetting.findOneAndUpdate({}, update, {
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

// ========== STAGE DURATION SETTINGS ==========

// @desc    Get stage duration settings
// @route   GET /api/v1/settings/stage-durations
// @access  Private (Admin/Manager/Staff — needed at runtime)
exports.getStageDurationSettings = asyncHandler(async (req, res, next) => {
  let settings = await StageDurationSetting.findOne();
  if (!settings) {
    settings = await StageDurationSetting.create({});
  }
  res.status(200).json({
    success: true,
    message: 'Stage duration settings fetched successfully',
    data: { settings },
  });
});

// @desc    Update stage duration settings
// @route   PUT /api/v1/settings/stage-durations
// @access  Private (Admin)
exports.updateStageDurationSettings = asyncHandler(async (req, res, next) => {
  const allowed = ['confirmed', 'picked-up', 'in_progress', 'washing', 'ironing', 'out-for-delivery'];
  const update = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      update[key] = Number(req.body[key]);
    }
  }
  const settings = await StageDurationSetting.findOneAndUpdate({}, update, {
    new: true,
    upsert: true,
    runValidators: true,
  });
  res.status(200).json({
    success: true,
    message: 'Stage duration settings updated successfully',
    data: { settings },
  });
});
