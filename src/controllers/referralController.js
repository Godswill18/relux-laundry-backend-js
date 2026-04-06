const Referral = require('../models/Referral.js');
const ReferralSetting = require('../models/ReferralSetting.js');
const User = require('../models/User.js');
const Customer = require('../models/Customer.js');
const Wallet = require('../models/Wallet.js');
const WalletTransaction = require('../models/WalletTransaction.js');
const LoyaltyLedger = require('../models/LoyaltyLedger.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');

// Helper: credit wallet for a user (by User._id)
async function creditWallet(userId, amount, reason) {
  if (!amount || amount <= 0) return;
  const user = await User.findById(userId).select('customerId').lean();
  if (!user?.customerId) return;
  let wallet = await Wallet.findOne({ customerId: user.customerId });
  if (!wallet) {
    wallet = await Wallet.create({ customerId: user.customerId, balance: 0 });
  }
  wallet.balance += amount;
  await wallet.save();
  await WalletTransaction.create({
    walletId: wallet._id,
    customerId: user.customerId,
    type: 'credit',
    amount,
    reason,
    balanceAfter: wallet.balance,
  });
}

// Helper: credit loyalty points for a user (by User._id)
async function creditLoyalty(userId, points, reason) {
  if (!points || points <= 0) return;
  const user = await User.findById(userId).select('customerId').lean();
  if (!user?.customerId) return;
  await LoyaltyLedger.create({
    customerId: user.customerId,
    points,
    type: 'earn',
    reason,
  });
  await Customer.findByIdAndUpdate(user.customerId, {
    $inc: { loyaltyPointsBalance: points, loyaltyLifetimePoints: points },
  });
}

// @desc    Get my referrals
// @route   GET /api/v1/referrals/me
// @access  Private
exports.getMyReferrals = asyncHandler(async (req, res, next) => {
  const referrals = await Referral.find({ referrerUserId: req.user.id })
    .populate('refereeUserId', 'name email phone')
    .sort('-createdAt');

  res.status(200).json({
    success: true,
    message: 'Referrals fetched successfully',
    data: { referrals },
  });
});

// @desc    Get my referral code
// @route   GET /api/v1/referrals/me/code
// @access  Private
exports.getMyReferralCode = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.user.id);

  if (!user.referralCode) {
    user.referralCode = `REF-${user._id.toString().slice(-6).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
    await user.save();
  }

  res.status(200).json({
    success: true,
    message: 'Referral code fetched successfully',
    data: { referralCode: user.referralCode },
  });
});

// @desc    Apply referral code
// @route   POST /api/v1/referrals/apply
// @access  Private
exports.applyReferralCode = asyncHandler(async (req, res, next) => {
  const { referralCode } = req.body;

  // Load current settings
  let settings = await ReferralSetting.findOne().sort('-createdAt').lean();
  if (!settings) {
    // Seed defaults if none exist
    settings = {
      enabled: true,
      referrerRewardAmount: 1000,
      refereeRewardAmount: 0,
      referrerLoyaltyPoints: 0,
      refereeLoyaltyPoints: 0,
      allowSelfReferral: false,
    };
  }

  if (!settings.enabled) {
    return next(new AppError('Referral program is currently disabled', 400));
  }

  const referrer = await User.findOne({ referralCode });
  if (!referrer) {
    return next(new AppError('Invalid referral code', 400));
  }

  if (!settings.allowSelfReferral && referrer._id.toString() === req.user.id) {
    return next(new AppError('You cannot refer yourself', 400));
  }

  const existingReferral = await Referral.findOne({ refereeUserId: req.user.id });
  if (existingReferral) {
    return next(new AppError('You have already been referred', 400));
  }

  // Check max rewards per referrer
  if (settings.maxRewardsPerReferrer && settings.maxRewardsPerReferrer > 0) {
    const referrerCount = await Referral.countDocuments({
      referrerUserId: referrer._id,
      status: { $in: ['qualified', 'rewarded'] },
    });
    if (referrerCount >= settings.maxRewardsPerReferrer) {
      return next(new AppError('This referrer has reached the maximum referral reward limit', 400));
    }
  }

  // Snapshot current settings into the referral record
  const referral = await Referral.create({
    referrerUserId: referrer._id,
    refereeUserId: req.user.id,
    rewardAmount: settings.referrerRewardAmount,
    refereeRewardAmount: settings.refereeRewardAmount,
    referrerLoyaltyPoints: settings.referrerLoyaltyPoints,
    refereeLoyaltyPoints: settings.refereeLoyaltyPoints,
  });

  res.status(201).json({
    success: true,
    message: 'Referral code applied successfully',
    data: { referral },
  });
});

// @desc    Get all referrals (admin)
// @route   GET /api/v1/referrals
// @access  Private (Admin/Manager)
exports.getReferrals = asyncHandler(async (req, res, next) => {
  let query = {};
  if (req.query.status) query.status = req.query.status;

  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 10;
  const startIndex = (page - 1) * limit;

  const total = await Referral.countDocuments(query);

  const referrals = await Referral.find(query)
    .populate('referrerUserId', 'name email phone')
    .populate('refereeUserId', 'name email phone')
    .sort('-createdAt')
    .skip(startIndex)
    .limit(limit);

  res.status(200).json({
    success: true,
    message: 'Referrals fetched successfully',
    data: { referrals },
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

// @desc    Get single referral
// @route   GET /api/v1/referrals/:id
// @access  Private (Admin/Manager)
exports.getReferral = asyncHandler(async (req, res, next) => {
  const referral = await Referral.findById(req.params.id)
    .populate('referrerUserId', 'name email phone')
    .populate('refereeUserId', 'name email phone');

  if (!referral) {
    return next(new AppError('Referral not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Referral fetched successfully',
    data: { referral },
  });
});

// @desc    Update referral status (and auto-credit rewards when marking rewarded)
// @route   PUT /api/v1/referrals/:id/status
// @access  Private (Admin/Manager)
exports.updateReferralStatus = asyncHandler(async (req, res, next) => {
  const { status } = req.body;

  const referral = await Referral.findById(req.params.id);
  if (!referral) {
    return next(new AppError('Referral not found', 404));
  }

  // When marking as rewarded, credit wallets and loyalty points
  if (status === 'rewarded' && !referral.rewardCredited) {
    // Always read live settings so the reward reflects what is configured in the settings page
    const settings = await ReferralSetting.findOne().sort('-createdAt').lean();
    const referrerRewardAmount   = settings?.referrerRewardAmount   ?? referral.rewardAmount        ?? 0;
    const refereeRewardAmount    = settings?.refereeRewardAmount    ?? referral.refereeRewardAmount  ?? 0;
    const referrerLoyaltyPoints  = settings?.referrerLoyaltyPoints  ?? referral.referrerLoyaltyPoints ?? 0;
    const refereeLoyaltyPoints   = settings?.refereeLoyaltyPoints   ?? referral.refereeLoyaltyPoints  ?? 0;

    await creditWallet(
      referral.referrerUserId,
      referrerRewardAmount,
      `Referral reward for referring a new customer`
    );
    await creditLoyalty(
      referral.referrerUserId,
      referrerLoyaltyPoints,
      `Referral loyalty bonus`
    );
    // Update the snapshotted amounts on the record so the frontend shows the correct value
    referral.rewardAmount = referrerRewardAmount;
    referral.referrerLoyaltyPoints = referrerLoyaltyPoints;
    referral.rewardCredited = true;

    if (!referral.refereeRewardCredited) {
      await creditWallet(
        referral.refereeUserId,
        refereeRewardAmount,
        `Welcome referral bonus`
      );
      await creditLoyalty(
        referral.refereeUserId,
        refereeLoyaltyPoints,
        `Welcome referral loyalty bonus`
      );
      referral.refereeRewardAmount = refereeRewardAmount;
      referral.refereeLoyaltyPoints = refereeLoyaltyPoints;
      referral.refereeRewardCredited = true;
    }
  }

  // When reversing, do not deduct (just mark status)
  referral.status = status;
  await referral.save();

  await referral.populate('referrerUserId', 'name email phone');
  await referral.populate('refereeUserId', 'name email phone');

  res.status(200).json({
    success: true,
    message: 'Referral status updated successfully',
    data: { referral },
  });
});
