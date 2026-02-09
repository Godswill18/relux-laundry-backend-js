const jwt = require('jsonwebtoken');
const { clerkClient } = require('@clerk/express');
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

    next();
  } catch (error) {
    return next(new AppError('Not authorized to access this route', 401));
  }
});

// Dual protect - accepts either custom JWT or Clerk session token
exports.dualProtect = asyncHandler(async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  } else if (req.cookies.token) {
    token = req.cookies.token;
  }

  if (!token) {
    return next(new AppError('Not authorized to access this route', 401));
  }

  // Try custom JWT first (fast, local verification)
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (user && user.isActive) {
      req.user = user;
      return next();
    }
  } catch (jwtError) {
    // Not a valid custom JWT - try Clerk
  }

  // Try Clerk token verification
  try {
    const { sub: clerkUserId } = await clerkClient.verifyToken(token);
    if (clerkUserId) {
      const user = await User.findOne({ clerkId: clerkUserId });
      if (user && user.isActive) {
        req.user = user;
        return next();
      }
    }
  } catch (clerkError) {
    // Not a valid Clerk token either
  }

  return next(new AppError('Not authorized to access this route', 401));
});

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
