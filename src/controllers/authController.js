const User = require('../models/User.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');
const { generateOTP, sendTokenResponse } = require('../utils/helpers.js');

// @desc    Register user
// @route   POST /api/v1/auth/register
// @access  Public
exports.register = asyncHandler(async (req, res, next) => {
  const { name, email, phone, password, role } = req.body;

  // Check if user already exists
  const existingUser = await User.findOne({ phone });
  if (existingUser) {
    return next(new AppError('Phone number already registered', 400));
  }

  // Create user
  const user = await User.create({
    name,
    email,
    phone,
    password,
    role: role || 'customer',
  });

  sendTokenResponse(user, 201, res);
});

// @desc    Login user
// @route   POST /api/v1/auth/login
// @access  Public
exports.login = asyncHandler(async (req, res, next) => {
  const { phone, password } = req.body;

  // Validate phone & password
  if (!phone || !password) {
    return next(new AppError('Please provide phone number and password', 400));
  }

  // Check for user
  const user = await User.findOne({ phone }).select('+password');

  if (!user) {
    return next(new AppError('Invalid credentials', 401));
  }

  // Check if password matches
  const isMatch = await user.comparePassword(password);

  if (!isMatch) {
    return next(new AppError('Invalid credentials', 401));
  }

  // Check if user is active
  if (!user.isActive) {
    return next(new AppError('Your account has been deactivated', 401));
  }

  sendTokenResponse(user, 200, res);
});

// @desc    Get current logged in user
// @route   GET /api/v1/auth/me
// @access  Private
exports.getMe = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.user.id);

  res.status(200).json({
    success: true,
    message: 'User profile fetched successfully',
    data: { user },
  });
});

// @desc    Update user details
// @route   PUT /api/v1/auth/update
// @access  Private
exports.updateDetails = asyncHandler(async (req, res, next) => {
  const fieldsToUpdate = {
    name: req.body.name,
    email: req.body.email,
    preferredPickupTime: req.body.preferredPickupTime,
  };

  const user = await User.findByIdAndUpdate(req.user.id, fieldsToUpdate, {
    new: true,
    runValidators: true,
  });

  res.status(200).json({
    success: true,
    message: 'Profile updated successfully',
    data: { user },
  });
});

// @desc    Update password
// @route   PUT /api/v1/auth/updatepassword
// @access  Private
exports.updatePassword = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.user.id).select('+password');

  // Check current password
  if (!(await user.comparePassword(req.body.currentPassword))) {
    return next(new AppError('Current password is incorrect', 401));
  }

  user.password = req.body.newPassword;
  await user.save();

  sendTokenResponse(user, 200, res);
});

// @desc    Logout user / clear cookie
// @route   GET /api/v1/auth/logout
// @access  Private
exports.logout = asyncHandler(async (req, res, next) => {
  res.cookie('token', 'none', {
    expires: new Date(Date.now() + 10 * 1000),
    httpOnly: true,
  });

  res.status(200).json({
    success: true,
    message: 'Logged out successfully',
    data: {},
  });
});

// @desc    Request OTP
// @route   POST /api/v1/auth/request-otp
// @access  Public
exports.requestOTP = asyncHandler(async (req, res, next) => {
  const { phone } = req.body;

  const user = await User.findOne({ phone });

  if (!user) {
    return next(new AppError('User not found', 404));
  }

  // Generate OTP
  const otp = generateOTP();
  user.otp = otp;
  user.otpExpires = Date.now() + 10 * 60 * 1000; // 10 minutes

  await user.save({ validateBeforeSave: false });

  // TODO: Send OTP via SMS (Twilio integration)
  // For now, just return success
  console.log(`OTP for ${phone}: ${otp}`);

  res.status(200).json({
    success: true,
    message: 'OTP sent successfully',
    ...(process.env.NODE_ENV === 'development' && { otp }), // Only in dev
  });
});

// @desc    Verify OTP
// @route   POST /api/v1/auth/verify-otp
// @access  Public
exports.verifyOTP = asyncHandler(async (req, res, next) => {
  const { phone, otp } = req.body;

  const user = await User.findOne({
    phone,
    otp,
    otpExpires: { $gt: Date.now() },
  });

  if (!user) {
    return next(new AppError('Invalid or expired OTP', 400));
  }

  // Clear OTP
  user.otp = undefined;
  user.otpExpires = undefined;
  user.isPhoneVerified = true;
  await user.save({ validateBeforeSave: false });

  sendTokenResponse(user, 200, res);
});

// @desc    Add address
// @route   POST /api/v1/auth/addresses
// @access  Private
exports.addAddress = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.user.id);

  // If this is set as default, unset other defaults
  if (req.body.isDefault) {
    user.addresses.forEach((addr) => {
      addr.isDefault = false;
    });
  }

  user.addresses.push(req.body);
  await user.save();

  res.status(201).json({
    success: true,
    message: 'Address added successfully',
    data: { user },
  });
});
