const Wallet = require('../models/Wallet.js');
const WalletTransaction = require('../models/WalletTransaction.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');
const { logAudit } = require('../utils/auditLogger.js');

// @desc    Get my wallet
// @route   GET /api/v1/wallets/me
// @access  Private
exports.getMyWallet = asyncHandler(async (req, res, next) => {
  if (!req.user.customerId) {
    return next(new AppError('No customer profile linked to this account', 400));
  }

  let wallet = await Wallet.findOne({ customerId: req.user.customerId });

  if (!wallet) {
    wallet = await Wallet.create({ customerId: req.user.customerId, balance: 0 });
  }

  res.status(200).json({
    success: true,
    message: 'Wallet fetched successfully',
    data: { wallet },
  });
});

// @desc    Get wallet by customer
// @route   GET /api/v1/wallets/customer/:customerId
// @access  Private (Admin/Manager)
exports.getWalletByCustomer = asyncHandler(async (req, res, next) => {
  const wallet = await Wallet.findOne({ customerId: req.params.customerId });

  if (!wallet) {
    return next(new AppError('Wallet not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Wallet fetched successfully',
    data: { wallet },
  });
});

// REMOVED: topUpWallet (POST /api/v1/wallets/topup)
//
// This credited the caller's own wallet directly from req.body.amount with no
// payment behind it and only `protect` in front of it, so any authenticated
// customer could grant themselves unlimited balance. Wallet credit now has
// exactly four legitimate sources:
//   1. processSuccessfulPaystackPayment() — a verified, amount-checked payment
//   2. adminCreditWallet()                — admin/manager, audited
//   3. processReferralReward()            — referral payout
//   4. convertPointsToWallet()            — loyalty points conversion
// For a manual credit, use POST /api/v1/wallets/admin-credit.

// @desc    Debit wallet
// @route   POST /api/v1/wallets/debit
// @access  Private (Admin/Manager/Staff)
exports.debitWallet = asyncHandler(async (req, res, next) => {
  const { customerId, reason } = req.body;
  const amount = parseFloat(req.body.amount);

  if (!customerId) {
    return next(new AppError('customerId is required', 400));
  }

  if (isNaN(amount) || amount <= 0) {
    return next(new AppError('Amount must be a number greater than 0', 400));
  }

  const existing = await Wallet.findOne({ customerId });

  if (!existing) {
    return next(new AppError('Wallet not found', 404));
  }

  // Atomic check-and-debit. Reading the balance, comparing it and then saving as
  // three steps let two concurrent debits both pass the check and overdraw.
  const wallet = await Wallet.findOneAndUpdate(
    { _id: existing._id, balance: { $gte: amount } },
    { $inc: { balance: -amount } },
    { new: true }
  );

  if (!wallet) {
    return next(new AppError('Insufficient wallet balance', 400));
  }

  await WalletTransaction.create({
    walletId: wallet._id,
    customerId,
    amount,
    type: 'debit',
    reason: reason || 'Wallet debit',
    balanceAfter: wallet.balance,
    source: 'admin',
  });

  await logAudit({
    actorUserId: req.user.id,
    action: 'WALLET_DEBITED',
    targetType: 'Wallet',
    targetId: wallet._id.toString(),
    after: { amount, balanceAfter: wallet.balance, reason: reason || 'Wallet debit' },
    metadata: { customerId: String(customerId) },
  });

  res.status(200).json({
    success: true,
    message: 'Wallet debited successfully',
    data: { wallet },
  });
});

// @desc    Get my wallet transactions
// @route   GET /api/v1/wallets/me/transactions
// @access  Private
exports.getTransactions = asyncHandler(async (req, res, next) => {
  if (!req.user.customerId) {
    return next(new AppError('No customer profile linked to this account', 400));
  }

  const wallet = await Wallet.findOne({ customerId: req.user.customerId });

  if (!wallet) {
    return next(new AppError('Wallet not found', 404));
  }

  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const startIndex = (page - 1) * limit;

  let query = { walletId: wallet._id };
  if (req.query.type) query.type = req.query.type;

  if (req.query.dateFrom || req.query.dateTo) {
    query.createdAt = {};
    if (req.query.dateFrom) {
      query.createdAt.$gte = new Date(req.query.dateFrom);
    }
    if (req.query.dateTo) {
      const end = new Date(req.query.dateTo);
      end.setHours(23, 59, 59, 999);
      query.createdAt.$lte = end;
    }
  }

  const total = await WalletTransaction.countDocuments(query);

  const transactions = await WalletTransaction.find(query)
    .sort('-createdAt')
    .skip(startIndex)
    .limit(limit);

  res.status(200).json({
    success: true,
    message: 'Transactions fetched successfully',
    data: { transactions },
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

// @desc    Admin credit wallet for a customer
// @route   POST /api/v1/wallets/admin-credit
// @access  Private (Admin/Manager)
exports.adminCreditWallet = asyncHandler(async (req, res, next) => {
  const { customerId, reason } = req.body;
  const amount = parseFloat(req.body.amount);

  if (!customerId) {
    return next(new AppError('customerId is required', 400));
  }

  if (isNaN(amount) || amount <= 0) {
    return next(new AppError('Amount must be a number greater than 0', 400));
  }

  // Atomic upsert-and-credit — no read-modify-write window for a concurrent
  // credit to overwrite, and no separate create step to race against.
  const wallet = await Wallet.findOneAndUpdate(
    { customerId },
    { $inc: { balance: amount } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  await WalletTransaction.create({
    walletId: wallet._id,
    customerId,
    amount,
    type: 'credit',
    reason: reason || 'Admin wallet credit',
    balanceAfter: wallet.balance,
    source: 'admin',
  });

  await logAudit({
    actorUserId: req.user.id,
    action: 'WALLET_CREDITED',
    targetType: 'Wallet',
    targetId: wallet._id.toString(),
    after: { amount, balanceAfter: wallet.balance, reason: reason || 'Admin wallet credit' },
    metadata: { customerId: String(customerId) },
  });

  res.status(200).json({
    success: true,
    message: 'Wallet credited successfully',
    data: { wallet },
  });
});

// @desc    Get wallet transactions by customer
// @route   GET /api/v1/wallets/customer/:customerId/transactions
// @access  Private (Admin/Manager)
exports.getTransactionsByCustomer = asyncHandler(async (req, res, next) => {
  const wallet = await Wallet.findOne({ customerId: req.params.customerId });

  if (!wallet) {
    return next(new AppError('Wallet not found', 404));
  }

  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const startIndex = (page - 1) * limit;

  const total = await WalletTransaction.countDocuments({ walletId: wallet._id });

  const transactions = await WalletTransaction.find({ walletId: wallet._id })
    .sort('-createdAt')
    .skip(startIndex)
    .limit(limit);

  res.status(200).json({
    success: true,
    message: 'Transactions fetched successfully',
    data: { transactions },
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});
