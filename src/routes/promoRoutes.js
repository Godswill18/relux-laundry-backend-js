const express = require('express');
const router = express.Router();
const {
  getPromoCodes,
  getPromoCode,
  createPromoCode,
  updatePromoCode,
  deletePromoCode,
  validatePromoCode,
  redeemPromoCode,
  getRedemptions,
} = require('../controllers/promoController.js');

const { protect, authorize } = require('../middleware/auth.js');

// Customer-facing routes
router.post('/validate', protect, validatePromoCode);
router.post('/redeem', protect, redeemPromoCode);

// Admin/manager routes
router.get('/', protect, authorize('admin', 'manager'), getPromoCodes);
router.post('/', protect, authorize('admin', 'manager'), createPromoCode);
router.get('/:id', protect, authorize('admin', 'manager'), getPromoCode);
router.put('/:id', protect, authorize('admin', 'manager'), updatePromoCode);
router.delete('/:id', protect, authorize('admin'), deletePromoCode);
router.get('/:id/redemptions', protect, authorize('admin', 'manager'), getRedemptions);

module.exports = router;
