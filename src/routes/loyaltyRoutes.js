const express = require('express');
const router = express.Router();
const {
  getTiers,
  getTier,
  createTier,
  updateTier,
  deleteTier,
  getMyLoyalty,
  getLedger,
  getCustomerLoyalty,
  adjustPoints,
} = require('../controllers/loyaltyController.js');

const { dualProtect, protect, authorize } = require('../middleware/auth.js');

// Tier routes
router.get('/tiers', dualProtect, getTiers);
router.post('/tiers', protect, authorize('admin'), createTier);
router.get('/tiers/:id', dualProtect, getTier);
router.put('/tiers/:id', protect, authorize('admin'), updateTier);
router.delete('/tiers/:id', protect, authorize('admin'), deleteTier);

// Customer self-service
router.get('/me', dualProtect, getMyLoyalty);
router.get('/me/ledger', dualProtect, getLedger);

// Admin
router.get('/customer/:customerId', protect, authorize('admin', 'manager'), getCustomerLoyalty);
router.post('/adjust', protect, authorize('admin', 'manager'), adjustPoints);

module.exports = router;
