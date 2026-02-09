const express = require('express');
const router = express.Router();
const {
  register,
  login,
  getMe,
  updateDetails,
  updatePassword,
  logout,
  requestOTP,
  verifyOTP,
  addAddress,
} = require('../controllers/authController.js');

const { protect, dualProtect } = require('../middleware/auth.js');
const { authLimiter } = require('../middleware/rateLimiter.js');

// Public routes
router.post('/register', authLimiter, register);
router.post('/login', authLimiter, login);
router.post('/request-otp', authLimiter, requestOTP);
router.post('/verify-otp', authLimiter, verifyOTP);

// Protected routes (accepts both JWT and Clerk tokens)
router.get('/me', dualProtect, getMe);
router.put('/update', dualProtect, updateDetails);
router.post('/addresses', dualProtect, addAddress);

// JWT-only routes (not relevant to Clerk users)
router.put('/updatepassword', protect, updatePassword);
router.get('/logout', protect, logout);

module.exports = router;
