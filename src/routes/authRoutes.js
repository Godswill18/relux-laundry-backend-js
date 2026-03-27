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
  addAddress,
  forgotPassword,
  resetPassword,
} = require('../controllers/authController.js');

const { protect } = require('../middleware/auth.js');
const { authLimiter } = require('../middleware/rateLimiter.js');

// Public routes
router.post('/register', authLimiter, register);
router.post('/login', authLimiter, login);
// router.post('/clerk-sync', clerkSync); // Clerk disabled
router.post('/request-otp', authLimiter, requestOTP);
router.post('/verify-otp', authLimiter, verifyOTP);
router.post('/forgot-password', authLimiter, forgotPassword);
router.post('/reset-password', authLimiter, resetPassword);

// Protected routes (JWT only)
router.get('/me', protect, getMe);
router.put('/update', protect, updateDetails);
router.post('/addresses', protect, addAddress);
router.put('/updatepassword', protect, updatePassword);
router.get('/logout', protect, logout);

module.exports = router;