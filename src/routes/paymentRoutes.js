const express = require('express');
const router = express.Router();
const {
  getPayments,
  getPayment,
  getPaymentByOrder,
  createPayment,
  confirmPayment,
  initializePaystack,
  verifyPaystack,
} = require('../controllers/paymentController.js');

const { dualProtect, protect, authorize } = require('../middleware/auth.js');

// Paystack routes (customer-facing)
router.post('/paystack/initialize', dualProtect, initializePaystack);
router.get('/paystack/verify/:reference', dualProtect, verifyPaystack);

// Order payment lookup
router.get('/order/:orderId', dualProtect, getPaymentByOrder);

// Admin/staff routes
router.get('/', protect, authorize('admin', 'manager'), getPayments);
router.post('/', protect, authorize('admin', 'manager', 'staff'), createPayment);
router.get('/:id', protect, authorize('admin', 'manager', 'staff'), getPayment);
router.put('/:id/confirm', protect, authorize('admin', 'manager', 'staff'), confirmPayment);

module.exports = router;
