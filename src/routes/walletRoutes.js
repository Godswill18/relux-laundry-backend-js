const express = require('express');
const router = express.Router();
const {
  getMyWallet,
  getWalletByCustomer,
  topUpWallet,
  debitWallet,
  getTransactions,
  getTransactionsByCustomer,
} = require('../controllers/walletController.js');

const { protect, authorize } = require('../middleware/auth.js');

// Customer self-service routes
router.get('/me', protect, getMyWallet);
router.post('/topup', protect, topUpWallet);
router.get('/me/transactions', protect, getTransactions);

// Admin/staff routes
router.get('/customer/:customerId', protect, authorize('admin', 'manager'), getWalletByCustomer);
router.get('/customer/:customerId/transactions', protect, authorize('admin', 'manager'), getTransactionsByCustomer);
router.post('/debit', protect, authorize('admin', 'manager', 'staff'), debitWallet);

module.exports = router;
