const express = require('express');
const router = express.Router();
const {
  register,
  login,
  // clerkSync, // Clerk disabled — using custom JWT auth
  getMe,
  updateDetails,
  updatePassword,
  logout,
  requestOTP,
  verifyOTP,
  verifyEmail,
  resendEmailVerification,
  addAddress,
  forgotPassword,
  resetPassword,
} = require('../controllers/authController.js');

const { protect } = require('../middleware/auth.js');
const activation = require('../controllers/activationController.js');
const { authLimiter } = require('../middleware/rateLimiter.js');

// Public routes
router.post('/register', authLimiter, register);
router.post('/login', authLimiter, login);
// router.post('/clerk-sync', clerkSync); // Clerk disabled
// Signed-in only: the one caller (staff bank-details page) is always signed
// in, and an open endpoint let anyone overwrite any user's pending OTP by
// phone number.
router.post('/request-otp', authLimiter, protect, requestOTP);
router.post('/verify-otp', authLimiter, verifyOTP);
router.post('/verify-email', authLimiter, verifyEmail);
router.post('/resend-email-verification', authLimiter, resendEmailVerification);
router.post('/forgot-password', authLimiter, forgotPassword);

// Existing customers (e.g. walk-ins) activating a portal account. Rate-limited
// per IP here; the controller also limits attempts and codes per customer
// record, which does not depend on the caller's IP.
router.post('/activation/start',    authLimiter, activation.startActivation);
router.post('/activation/verify',   authLimiter, activation.verifyActivation);
router.post('/activation/complete', authLimiter, activation.completeActivation);
router.post('/reset-password', authLimiter, resetPassword);

// Protected routes (JWT only)
router.get('/me', protect, getMe);
router.put('/update', protect, updateDetails);
router.post('/addresses', protect, addAddress);
router.put('/updatepassword', protect, updatePassword);
router.get('/logout', protect, logout);

module.exports = router;