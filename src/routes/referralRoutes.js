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

const { dualProtect, protect, authorize } = require('../middleware/auth.js');

// Customer self-service (must be before /:id)
router.get('/me', dualProtect, getMyReferrals);
router.get('/me/code', dualProtect, getMyReferralCode);
router.post('/apply', dualProtect, applyReferralCode);

// Admin
router.get('/', protect, authorize('admin', 'manager'), getReferrals);
router.get('/:id', protect, authorize('admin', 'manager'), getReferral);
router.put('/:id/status', protect, authorize('admin', 'manager'), updateReferralStatus);

module.exports = router;
