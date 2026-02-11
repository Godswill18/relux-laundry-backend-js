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

const { protect, authorize } = require('../middleware/auth.js');

// Tier routes
router.get('/tiers', protect, getTiers);
router.post('/tiers', protect, authorize('admin'), createTier);
router.get('/tiers/:id', protect, getTier);
router.put('/tiers/:id', protect, authorize('admin'), updateTier);
router.delete('/tiers/:id', protect, authorize('admin'), deleteTier);

// Customer self-service
router.get('/me', protect, getMyLoyalty);
router.get('/me/ledger', protect, getLedger);

// Admin
router.get('/customer/:customerId', protect, authorize('admin', 'manager'), getCustomerLoyalty);
router.post('/adjust', protect, authorize('admin', 'manager'), adjustPoints);

module.exports = router;
