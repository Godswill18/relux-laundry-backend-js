const Referral = require('../models/Referral.js');
const User = require('../models/User.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');

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

  const referrer = await User.findOne({ referralCode });
  if (!referrer) {
    return next(new AppError('Invalid referral code', 400));
  }

  if (referrer._id.toString() === req.user.id) {
    return next(new AppError('You cannot refer yourself', 400));
  }

  const existingReferral = await Referral.findOne({ refereeUserId: req.user.id });
  if (existingReferral) {
    return next(new AppError('You have already been referred', 400));
  }

  const referral = await Referral.create({
    referrerUserId: referrer._id,
    refereeUserId: req.user.id,
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

// @desc    Update referral status
// @route   PUT /api/v1/referrals/:id/status
// @access  Private (Admin/Manager)
exports.updateReferralStatus = asyncHandler(async (req, res, next) => {
  const { status } = req.body;

  const referral = await Referral.findByIdAndUpdate(
    req.params.id,
    { status },
    { new: true, runValidators: true }
  );

  if (!referral) {
    return next(new AppError('Referral not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Referral status updated successfully',
    data: { referral },
  });
});
