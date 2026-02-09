const Wallet = require('../models/Wallet.js');
const WalletTransaction = require('../models/WalletTransaction.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');

// @desc    Get my wallet
// @route   GET /api/v1/wallets/me
// @access  Private
exports.getMyWallet = asyncHandler(async (req, res, next) => {
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

// @desc    Top up wallet
// @route   POST /api/v1/wallets/topup
// @access  Private
exports.topUpWallet = asyncHandler(async (req, res, next) => {
  const { amount, reason } = req.body;

  if (!amount || amount <= 0) {
    return next(new AppError('Amount must be greater than 0', 400));
  }

  let wallet = await Wallet.findOne({ customerId: req.user.customerId });

  if (!wallet) {
    wallet = await Wallet.create({ customerId: req.user.customerId, balance: 0 });
  }

  wallet.balance += amount;
  await wallet.save();

  await WalletTransaction.create({
    walletId: wallet._id,
    amount,
    type: 'credit',
    reason: reason || 'Wallet top-up',
  });

  res.status(200).json({
    success: true,
    message: 'Wallet topped up successfully',
    data: { wallet },
  });
});

// @desc    Debit wallet
// @route   POST /api/v1/wallets/debit
// @access  Private (Admin/Manager/Staff)
exports.debitWallet = asyncHandler(async (req, res, next) => {
  const { customerId, amount, reason } = req.body;

  if (!amount || amount <= 0) {
    return next(new AppError('Amount must be greater than 0', 400));
  }

  const wallet = await Wallet.findOne({ customerId });

  if (!wallet) {
    return next(new AppError('Wallet not found', 404));
  }

  if (wallet.balance < amount) {
    return next(new AppError('Insufficient wallet balance', 400));
  }

  wallet.balance -= amount;
  await wallet.save();

  await WalletTransaction.create({
    walletId: wallet._id,
    amount,
    type: 'debit',
    reason: reason || 'Wallet debit',
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
  const wallet = await Wallet.findOne({ customerId: req.user.customerId });

  if (!wallet) {
    return next(new AppError('Wallet not found', 404));
  }

  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const startIndex = (page - 1) * limit;

  let query = { walletId: wallet._id };
  if (req.query.type) query.type = req.query.type;

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
