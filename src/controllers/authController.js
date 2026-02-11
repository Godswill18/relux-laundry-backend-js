const User = require('../models/User.js');
const Customer = require('../models/Customer.js');
// const { clerkClient } = require('@clerk/express'); // Clerk disabled — using custom JWT auth
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');
const { generateOTP, splitName, sendTokenResponse } = require('../utils/helpers.js');

// Ensure a Customer document exists for the given User and link them.
// Idempotent — safe to call on every login/register.
const ensureCustomer = async (user) => {
  if (user.customerId) return user;

  // Try to find existing Customer by phone or email
  let customer;
  if (user.phone) customer = await Customer.findOne({ phone: user.phone });
  if (!customer && user.email) customer = await Customer.findOne({ email: user.email });

  if (!customer) {
    customer = await Customer.create({
      name: user.name,
      phone: user.phone || undefined,
      email: user.email || undefined,
      status: 'active',
    });
  }

  user.customerId = customer._id;
  await user.save({ validateBeforeSave: false });
  return user;
};

// @desc    Register user
// @route   POST /api/v1/auth/register
// @access  Public
exports.register = asyncHandler(async (req, res, next) => {
  const { name, email, phone, password, role } = req.body;

  // Validate required fields
  if (!name || !phone || !password) {
    return next(new AppError('Please provide name, phone and password', 400));
  }

  // Check if user already exists
  const existingUser = await User.findOne({ phone });
  if (existingUser) {
    return next(new AppError('Phone number already registered', 400));
  }

  // Create user (convert empty strings to undefined for sparse unique fields)
  const user = await User.create({
    name,
    email: email || undefined,
    phone,
    password,
    role: role || 'customer',
  });

  // Create linked Customer document for wallet/loyalty/orders
  await ensureCustomer(user);

  sendTokenResponse(user, 201, res);
});

// @desc    Sync Clerk user to MongoDB (create if not exists)
// @route   POST /api/v1/auth/clerk-sync
// @access  Public (requires valid Clerk token)
exports.clerkSync = asyncHandler(async (req, res, next) => {
  let token;
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    console.log('[clerkSync] No token in Authorization header');
    return next(new AppError('No token provided', 401));
  }

  console.log('[clerkSync] Token received:', token.substring(0, 20) + '...');

  // Verify Clerk token
  let clerkUserId;
  try {
    const verified = await clerkClient.verifyToken(token);
    console.log('[clerkSync] Clerk verified:', JSON.stringify(verified));
    clerkUserId = verified.sub;
  } catch (err) {
    console.log('[clerkSync] Clerk verifyToken FAILED:', err.message);
    return next(new AppError('Invalid Clerk token', 401));
  }

  if (!clerkUserId) {
    return next(new AppError('Invalid Clerk token', 401));
  }

  // Check if user already exists by clerkId
  let user = await User.findOne({ clerkId: clerkUserId });

  if (!user) {
    const { email, name, phone } = req.body;

    // Try to link to an existing user by email
    if (email) {
      user = await User.findOne({ email });
    }

    if (user) {
      // Link existing user to Clerk
      user.clerkId = clerkUserId;
      user.authProvider = 'clerk';
      if (name && !user.name) user.name = name;
      await user.save({ validateBeforeSave: false });
    } else {
      // Create new user
      user = await User.create({
        clerkId: clerkUserId,
        authProvider: 'clerk',
        name: name || 'Customer',
        email: email || undefined,
        phone: phone || undefined,
        role: 'customer',
      });
    }
  }

  res.status(200).json({
    success: true,
    message: 'User synced successfully',
    data: { user },
  });
});

// @desc    Login user
// @route   POST /api/v1/auth/login
// @access  Public
exports.login = asyncHandler(async (req, res, next) => {
  const { phone, email, password } = req.body;

  // Validate credentials
  if ((!phone && !email) || !password) {
    return next(new AppError('Please provide phone/email and password', 400));
  }

  // Check for user by phone or email
  const query = phone ? { phone } : { email: email.toLowerCase() };
  const user = await User.findOne(query).select('+password');

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

  // Ensure Customer document exists (backfill for users created before this fix)
  await ensureCustomer(user);

  sendTokenResponse(user, 200, res);
});

// @desc    Get current logged in user
// @route   GET /api/v1/auth/me
// @access  Private
exports.getMe = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.user.id);

  // Backfill Customer if missing (for users created before ensureCustomer was added)
  await ensureCustomer(user);

  const userObj = user.toObject();
  const { firstName, lastName } = splitName(userObj.name);
  userObj.firstName = firstName;
  userObj.lastName = lastName;
  if (userObj._id && !userObj.id) userObj.id = userObj._id.toString();

  res.status(200).json({
    success: true,
    message: 'User profile fetched successfully',
    data: { user: userObj },
  });
});

// @desc    Update user details
// @route   PUT /api/v1/auth/update
// @access  Private
exports.updateDetails = asyncHandler(async (req, res, next) => {
  const { firstName, lastName, name, email, phone, address, city, dateOfBirth, preferredPickupTime } = req.body;

  const fieldsToUpdate = {};

  // Support both "name" and "firstName/lastName" from frontend
  if (firstName || lastName) {
    fieldsToUpdate.name = [firstName, lastName].filter(Boolean).join(' ');
  } else if (name) {
    fieldsToUpdate.name = name;
  }
  if (email) fieldsToUpdate.email = email;
  if (phone) fieldsToUpdate.phone = phone;
  if (address) fieldsToUpdate.address = address;
  if (city) fieldsToUpdate.city = city;
  if (dateOfBirth) fieldsToUpdate.dateOfBirth = dateOfBirth;
  if (preferredPickupTime) fieldsToUpdate.preferredPickupTime = preferredPickupTime;

  const user = await User.findByIdAndUpdate(req.user.id, fieldsToUpdate, {
    new: true,
    runValidators: false,
  });

  const userObj = user.toObject();
  const { firstName: fn, lastName: ln } = splitName(userObj.name);
  userObj.firstName = fn;
  userObj.lastName = ln;
  if (userObj._id && !userObj.id) userObj.id = userObj._id.toString();

  res.status(200).json({
    success: true,
    message: 'Profile updated successfully',
    data: { user: userObj },
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
