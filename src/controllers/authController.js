const User = require('../models/User.js');
const Order = require('../models/Order.js');
const WorkShift = require('../models/WorkShift.js');
const Referral = require('../models/Referral.js');
// const { clerkClient } = require('@clerk/express'); // Clerk disabled — using custom JWT auth
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');
const ERROR_CODES = require('../utils/errorCodes.js');
const { generateOTP, splitName, sendTokenResponse, getTodayWAT } = require('../utils/helpers.js');
const sendEmail = require('../utils/sendEmail.js');
const ensureCustomer = require('../utils/ensureCustomer.js');
const normalizePhone = require('../utils/normalizePhone.js');

// @desc    Register user
// @route   POST /api/v1/auth/register
// @access  Public
exports.register = asyncHandler(async (req, res, next) => {
  const { name, email, phone: rawPhone, password, role, referralCode } = req.body;

  // Validate required fields
  if (!name || !rawPhone || !password) {
    return next(new AppError('Please provide name, phone and password', 400));
  }

  if (!email) {
    return next(new AppError('Please provide your email address', 400));
  }

  // Normalize phone to E.164 format (+234XXXXXXXXXX)
  const phone = normalizePhone(rawPhone) || rawPhone.trim();

  // Check if user already exists
  const existingUser = await User.findOne({ phone });
  if (existingUser) {
    return next(new AppError('Phone number already registered', 400));
  }

  const existingEmail = await User.findOne({ email: email.toLowerCase() });
  if (existingEmail) {
    return next(new AppError('Email address already registered', 400));
  }

  // Generate email verification OTP before creating the user
  const otp = generateOTP();
  const otpExpires = Date.now() + 10 * 60 * 1000; // 10 minutes

  // Create user with emailVerified = false
  const user = await User.create({
    name,
    email: email.toLowerCase(),
    phone,
    password,
    role: role || 'customer',
    emailVerified: false,
    otp,
    otpExpires,
  });

  // Auto-generate a unique referral code for this new user
  user.referralCode = `REF-${user._id.toString().slice(-6).toUpperCase()}-${Date.now().toString(36).slice(-3).toUpperCase()}`;
  await user.save({ validateBeforeSave: false });

  // Create linked Customer document for wallet/loyalty/orders
  await ensureCustomer(user);

  // Link any past walk-in orders whose phone matches this new account (fire-and-forget)
  if (phone) {
    Order.updateMany(
      { orderSource: 'offline', 'walkInCustomer.phone': phone },
      { $set: { customer: user._id, customerId: user.customerId } }
    ).catch(() => {});
  }

  // Apply referral code if provided — do this silently (never fail registration)
  if (referralCode && referralCode.trim()) {
    try {
      const referrer = await User.findOne({ referralCode: referralCode.trim().toUpperCase() });

      if (referrer && referrer._id.toString() !== user._id.toString()) {
        const alreadyReferred = await Referral.findOne({ refereeUserId: user._id });
        if (!alreadyReferred) {
          await Referral.create({
            referrerUserId: referrer._id,
            refereeUserId: user._id,
            status: 'pending',
          });
        }
      }
    } catch (_) {
      // Silent — referral failure must not block registration
    }
  }

  // Send verification OTP
  const verifyHtml = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px;">
      <h2 style="color:#1d4ed8;margin-bottom:8px;">Relux Laundry</h2>
      <h3 style="margin-bottom:16px;">Verify Your Email</h3>
      <p>Hi ${user.name},</p>
      <p>Thanks for signing up! Use the code below to verify your email address. It expires in <strong>10 minutes</strong>.</p>
      <div style="text-align:center;margin:32px 0;">
        <span style="font-size:36px;font-weight:bold;letter-spacing:10px;color:#1d4ed8;">${otp}</span>
      </div>
      <p>If you did not create this account, you can safely ignore this email.</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
      <p style="font-size:12px;color:#6b7280;">Relux Laundry &mdash; Your Trusted Laundry Partner</p>
    </div>
  `;

  try {
    await sendEmail({ to: user.email, subject: 'Verify your Relux Laundry email', html: verifyHtml });
  } catch (_) {
    // Don't block signup if email fails — user can resend
  }

  // Return pending state — no token until email is verified
  res.status(201).json({
    success: true,
    message: 'Account created! Please check your email for a 6-digit verification code.',
    data: {
      email: user.email,
      pendingVerification: true,
      ...(process.env.NODE_ENV === 'development' && { otp }),
    },
  });
});

// @desc    Send (or resend) email verification OTP
// @route   POST /api/v1/auth/resend-email-verification
// @access  Public
exports.resendEmailVerification = asyncHandler(async (req, res, next) => {
  const { email } = req.body;

  if (!email) {
    return next(new AppError('Please provide your email address', 400));
  }

  const user = await User.findOne({ email: email.toLowerCase() });

  // Always respond success to prevent email enumeration
  if (!user || user.emailVerified) {
    return res.status(200).json({ success: true, message: 'If that email is pending verification, a new code has been sent.' });
  }

  const otp = generateOTP();
  user.otp = otp;
  user.otpExpires = Date.now() + 10 * 60 * 1000;
  await user.save({ validateBeforeSave: false });

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px;">
      <h2 style="color:#1d4ed8;margin-bottom:8px;">Relux Laundry</h2>
      <h3 style="margin-bottom:16px;">Your New Verification Code</h3>
      <p>Hi ${user.name},</p>
      <p>Here is your new email verification code. It expires in <strong>10 minutes</strong>.</p>
      <div style="text-align:center;margin:32px 0;">
        <span style="font-size:36px;font-weight:bold;letter-spacing:10px;color:#1d4ed8;">${otp}</span>
      </div>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
      <p style="font-size:12px;color:#6b7280;">Relux Laundry</p>
    </div>
  `;

  try {
    await sendEmail({ to: user.email, subject: 'Your Relux Laundry verification code', html });
  } catch (_) {
    return next(new AppError('Email could not be sent. Please try again later.', 500));
  }

  res.status(200).json({
    success: true,
    message: 'If that email is pending verification, a new code has been sent.',
    ...(process.env.NODE_ENV === 'development' && { otp }),
  });
});

// @desc    Verify email with OTP
// @route   POST /api/v1/auth/verify-email
// @access  Public
exports.verifyEmail = asyncHandler(async (req, res, next) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return next(new AppError('Please provide email and verification code', 400));
  }

  const user = await User.findOne({
    email: email.toLowerCase(),
    otp,
    otpExpires: { $gt: Date.now() },
  });

  if (!user) {
    return next(new AppError('Invalid or expired verification code', 400));
  }

  // Mark email as verified and clear OTP
  user.emailVerified = true;
  user.otp = undefined;
  user.otpExpires = undefined;
  await user.save({ validateBeforeSave: false });

  // Now log the user in by returning a token
  await sendTokenResponse(user, 200, res);
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

  // Smart detection: Check if phone field contains an email
  let query;
  const identifier = phone || email;
  const isEmail = identifier && identifier.includes('@');

  if (isEmail) {
    query = { email: identifier.toLowerCase() };
  } else {
    query = { phone: identifier };
  }

  const user = await User.findOne(query).select('+password');

  if (!user) {
    return next(new AppError('Invalid credentials', 401));
  }

  // Check if password matches
  const isMatch = await user.comparePassword(password);

  if (!isMatch) {
    return next(new AppError('Invalid credentials', 401));
  }

  // Check if user account is active (manual admin control)
  if (!user.isActive) {
    return next(new AppError('Your account has been deactivated. Contact an administrator.', 403, ERROR_CODES.ACCOUNT_DEACTIVATED));
  }

// Shift-based login restriction for staff role only
  // Admin and manager bypass shift checks entirely
  if (user.role === 'staff') {
    const today = getTodayWAT();

    // Find shifts assigned to this user that cover today's date
    const userShifts = await WorkShift.find({
      userId: user._id,
      startDate: { $lte: today },
      endDate: { $gte: today },
      status: { $ne: 'cancelled' },
    });

    if (userShifts.length === 0) {
      return next(new AppError('You have no active shift assigned. Contact a manager.', 403, ERROR_CODES.NO_ACTIVE_SHIFT));
    }

    // Check if any of the found shifts has isActive === true
    const activeShift = userShifts.find(s => s.isActive === true);

    if (!activeShift) {
      return next(new AppError('It is not your shift time yet. Please try again during your scheduled shift.', 403, ERROR_CODES.NOT_SHIFT_TIME));
    }
  }

  // Ensure Customer document exists (backfill for users created before this fix)
  await ensureCustomer(user);

  await sendTokenResponse(user, 200, res);
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

  await sendTokenResponse(user, 200, res);
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

  await sendTokenResponse(user, 200, res);
});

// @desc    Forgot password — send OTP to registered email
// @route   POST /api/v1/auth/forgot-password
// @access  Public
exports.forgotPassword = asyncHandler(async (req, res, next) => {
  const { email } = req.body;

  if (!email) {
    return next(new AppError('Please provide your email address', 400));
  }

  const user = await User.findOne({ email: email.toLowerCase() });

  // Always respond with success to prevent email enumeration
  if (!user) {
    return res.status(200).json({
      success: true,
      message: 'If that email is registered, a reset code has been sent.',
    });
  }

  // Generate 6-digit OTP and store it (reuses existing otp / otpExpires fields)
  const otp = generateOTP();
  user.otp = otp;
  user.otpExpires = Date.now() + 15 * 60 * 1000; // 15 minutes
  await user.save({ validateBeforeSave: false });

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px;">
      <h2 style="color:#1d4ed8;margin-bottom:8px;">Relux Laundry</h2>
      <h3 style="margin-bottom:16px;">Password Reset Code</h3>
      <p>Hi ${user.name},</p>
      <p>You requested a password reset. Use the code below to set a new password. It expires in <strong>15 minutes</strong>.</p>
      <div style="text-align:center;margin:32px 0;">
        <span style="font-size:36px;font-weight:bold;letter-spacing:10px;color:#1d4ed8;">${otp}</span>
      </div>
      <p>If you did not request this, you can safely ignore this email.</p>
      <p><b>Do not reply to this email.</b></p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
      <p style="font-size:12px;color:#6b7280;">Relux Laundry &mdash;</p>
    </div>
  `;

  try {
    await sendEmail({
      to: user.email,
      subject: 'Your Relux Laundry password reset code',
      html,
    });
  } catch (err) {
    // Clear OTP so user can retry
    user.otp = undefined;
    user.otpExpires = undefined;
    await user.save({ validateBeforeSave: false });
    return next(new AppError('Email could not be sent. Please try again later.', 500));
  }

  res.status(200).json({
    success: true,
    message: 'If that email is registered, a reset code has been sent.',
    ...(process.env.NODE_ENV === 'development' && { otp }),
  });
});

// @desc    Reset password using OTP from email
// @route   POST /api/v1/auth/reset-password
// @access  Public
exports.resetPassword = asyncHandler(async (req, res, next) => {
  const { email, otp, newPassword } = req.body;

  if (!email || !otp || !newPassword) {
    return next(new AppError('Please provide email, code, and new password', 400));
  }

  if (newPassword.length < 6) {
    return next(new AppError('Password must be at least 6 characters', 400));
  }

  const user = await User.findOne({
    email: email.toLowerCase(),
    otp,
    otpExpires: { $gt: Date.now() },
  }).select('+password');

  if (!user) {
    return next(new AppError('Invalid or expired reset code', 400));
  }

  user.password = newPassword;
  user.otp = undefined;
  user.otpExpires = undefined;
  // Bump jwtVersion to invalidate all existing sessions
  user.jwtVersion = (user.jwtVersion || 0) + 1;
  await user.save();

  res.status(200).json({
    success: true,
    message: 'Password reset successful. Please log in with your new password.',
  });
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
