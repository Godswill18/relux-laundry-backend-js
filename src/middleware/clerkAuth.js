const { requireAuth } = require('@clerk/express');
const User = require('../models/User.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');

// Clerk protect middleware - verifies Clerk session and sets req.user as MongoDB document
const clerkProtect = [
  requireAuth(),

  asyncHandler(async (req, res, next) => {
    const clerkUserId = req.auth.userId;

    if (!clerkUserId) {
      return next(new AppError('Not authorized - no Clerk session', 401));
    }

    const user = await User.findOne({ clerkId: clerkUserId });

    if (!user) {
      return next(
        new AppError('User not found in database. Please wait a moment and retry.', 401)
      );
    }

    if (!user.isActive) {
      return next(new AppError('User account is deactivated', 401));
    }

    req.user = user;
    next();
  }),
];

module.exports = { clerkProtect };
