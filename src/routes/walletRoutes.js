const express = require('express');
const router = express.Router();
const {
  getMyWallet,
  getWalletByCustomer,
  debitWallet,
  adminCreditWallet,
  getTransactions,
  getTransactionsByCustomer,
} = require('../controllers/walletController.js');

const { protect, authorize } = require('../middleware/auth.js');

// Customer self-service routes.
//
// There is deliberately no customer-facing top-up route. Wallet credit only ever
// originates from a verified Paystack payment (processSuccessfulPaystackPayment),
// an admin action (/admin-credit), a referral reward, or a points conversion.
// The old POST /topup credited a caller's own wallet straight from a request body
// with no payment behind it and was removed — use /admin-credit for manual credit.
router.get('/me', protect, getMyWallet);
router.get('/me/transactions', protect, getTransactions);

// Admin/staff routes
router.get('/customer/:customerId', protect, authorize('admin', 'manager'), getWalletByCustomer);
router.get('/customer/:customerId/transactions', protect, authorize('admin', 'manager'), getTransactionsByCustomer);
router.post('/debit', protect, authorize('admin', 'manager', 'staff'), debitWallet);
router.post('/admin-credit', protect, authorize('admin', 'manager'), adminCreditWallet);

module.exports = router;
