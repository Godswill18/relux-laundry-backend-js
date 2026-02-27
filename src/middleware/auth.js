const jwt = require('jsonwebtoken');
// const { clerkClient } = require('@clerk/express'); // Clerk disabled — using custom JWT auth
const User = require('../models/User.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');

// Protect routes - verify JWT token
exports.protect = asyncHandler(async (req, res, next) => {
  let token;

  // Check for token in headers
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  } else if (req.cookies.token) {
    token = req.cookies.token;
  }

  // Make sure token exists
  if (!token) {
    return next(new AppError('Not authorized to access this route', 401));
  }

  try {
    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Get user from token
    req.user = await User.findById(decoded.id);

    if (!req.user) {
      return next(new AppError('User no longer exists', 401));
    }

    if (!req.user.isActive) {
      return next(new AppError('User account is deactivated', 401));
    }

    // Reject stale JWTs when the user's permissions or role have been changed.
    // Old JWTs (issued before jwtVersion was added) default to 0, which won't
    // match the DB default of 1 — this forces a one-time re-login so every
    // user gets a fresh JWT carrying the current DB permissions.
    const tokenVersion = decoded.jwtVersion ?? 0;
    if (tokenVersion !== req.user.jwtVersion) {
      return next(
        new AppError(
          'Your permissions have changed. Please log in again.',
          401,
          'JWT_VERSION_MISMATCH'
        )
      );
    }

    next();
  } catch (error) {
    return next(new AppError('Not authorized to access this route', 401));
  }
});

// --- Clerk dualProtect commented out — using custom JWT protect instead ---
// exports.dualProtect = asyncHandler(async (req, res, next) => {
//   // ... Clerk + JWT dual verification ...
// });

// Grant access to specific roles
exports.authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(
        new AppError(
          `User role '${req.user.role}' is not authorized to access this route`,
          403
        )
      );
    }
    next();
  };
};