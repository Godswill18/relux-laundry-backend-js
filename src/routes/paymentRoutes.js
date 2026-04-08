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
  getPaystackTransactions,
  retryPaystackTransaction,
} = require('../controllers/paymentController.js');

const { protect, authorize } = require('../middleware/auth.js');

// Paystack routes (customer-facing)
router.post('/paystack/initialize', protect, initializePaystack);
router.get('/paystack/verify/:reference', protect, verifyPaystack);

// Paystack transactions (admin)
router.get('/paystack/transactions', protect, authorize('admin', 'manager'), getPaystackTransactions);
// Admin retry for stuck pending transactions
router.post('/paystack/retry/:reference', protect, authorize('admin', 'manager'), retryPaystackTransaction);

// Order payment lookup
router.get('/order/:orderId', protect, getPaymentByOrder);

// Admin/staff routes
router.get('/', protect, authorize('admin', 'manager'), getPayments);
router.post('/', protect, authorize('admin', 'manager', 'staff'), createPayment);
router.get('/:id', protect, authorize('admin', 'manager', 'staff'), getPayment);
router.put('/:id/confirm', protect, authorize('admin', 'manager', 'staff'), confirmPayment);

module.exports = router;
