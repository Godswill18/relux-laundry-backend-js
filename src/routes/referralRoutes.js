const express = require('express');
const router = express.Router();
const {
  getMyReferrals,
  getMyReferralCode,
  applyReferralCode,
  getReferrals,
  getReferral,
  updateReferralStatus,
} = require('../controllers/referralController.js');

const { protect, authorize } = require('../middleware/auth.js');

// Customer self-service (must be before /:id)
router.get('/me', protect, getMyReferrals);
router.get('/me/code', protect, getMyReferralCode);
router.post('/apply', protect, applyReferralCode);

// Admin
router.get('/', protect, authorize('admin', 'manager'), getReferrals);
router.get('/:id', protect, authorize('admin', 'manager'), getReferral);
router.put('/:id/status', protect, authorize('admin', 'manager'), updateReferralStatus);

module.exports = router;
