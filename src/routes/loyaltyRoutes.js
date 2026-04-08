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
  redeemPoints,
  getSettings,
  updateSettings,
  getTransactions,
  convertPointsToWallet,
} = require('../controllers/loyaltyController.js');

const { protect, authorize } = require('../middleware/auth.js');

// Settings routes (static paths before parameterized)
router.get('/settings', protect, authorize('admin', 'manager'), getSettings);
router.patch('/settings', protect, authorize('admin'), updateSettings);

// Transactions route (admin)
router.get('/transactions', protect, authorize('admin', 'manager'), getTransactions);

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

// Redeem points (for order discount)
router.post('/redeem', protect, redeemPoints);

// Convert points to wallet money
router.post('/convert', protect, convertPointsToWallet);

module.exports = router;
