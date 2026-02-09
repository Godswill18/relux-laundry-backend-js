const Payment = require('../models/Payment.js');
const PaystackTransaction = require('../models/PaystackTransaction.js');
const Order = require('../models/Order.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');

// @desc    Get all payments
// @route   GET /api/v1/payments
// @access  Private (Admin/Manager)
exports.getPayments = asyncHandler(async (req, res, next) => {
  let query = {};

  if (req.query.state) query.state = req.query.state;
  if (req.query.method) query.method = req.query.method;

  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 10;
  const startIndex = (page - 1) * limit;

  const total = await Payment.countDocuments(query);

  const payments = await Payment.find(query)
    .populate('orderId', 'orderNumber status total')
    .populate('confirmedById', 'name')
    .sort('-createdAt')
    .skip(startIndex)
    .limit(limit);

  res.status(200).json({
    success: true,
    message: 'Payments fetched successfully',
    data: { payments },
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

// @desc    Get single payment
// @route   GET /api/v1/payments/:id
// @access  Private (Admin/Manager/Staff)
exports.getPayment = asyncHandler(async (req, res, next) => {
  const payment = await Payment.findById(req.params.id)
    .populate('orderId', 'orderNumber status total customer')
    .populate('confirmedById', 'name');

  if (!payment) {
    return next(new AppError('Payment not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Payment fetched successfully',
    data: { payment },
  });
});

// @desc    Get payment by order
// @route   GET /api/v1/payments/order/:orderId
// @access  Private
exports.getPaymentByOrder = asyncHandler(async (req, res, next) => {
  const payment = await Payment.findOne({ orderId: req.params.orderId })
    .populate('confirmedById', 'name');

  if (!payment) {
    return next(new AppError('Payment not found for this order', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Payment fetched successfully',
    data: { payment },
  });
});

// @desc    Create payment
// @route   POST /api/v1/payments
// @access  Private (Admin/Manager/Staff)
exports.createPayment = asyncHandler(async (req, res, next) => {
  const { orderId, amount, method, reference, metadata } = req.body;

  const order = await Order.findById(orderId);
  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  const existingPayment = await Payment.findOne({ orderId });
  if (existingPayment) {
    return next(new AppError('Payment already exists for this order', 400));
  }

  const payment = await Payment.create({
    orderId,
    amount,
    method,
    reference,
    metadata,
  });

  res.status(201).json({
    success: true,
    message: 'Payment created successfully',
    data: { payment },
  });
});

// @desc    Confirm payment
// @route   PUT /api/v1/payments/:id/confirm
// @access  Private (Admin/Manager/Staff)
exports.confirmPayment = asyncHandler(async (req, res, next) => {
  const payment = await Payment.findById(req.params.id);

  if (!payment) {
    return next(new AppError('Payment not found', 404));
  }

  if (payment.state === 'paid') {
    return next(new AppError('Payment already confirmed', 400));
  }

  payment.state = 'paid';
  payment.paidAt = new Date();
  payment.confirmedById = req.user.id;
  if (req.body.reference) payment.reference = req.body.reference;

  await payment.save();

  // Update order payment status
  await Order.findByIdAndUpdate(payment.orderId, { paymentStatus: 'paid' });

  res.status(200).json({
    success: true,
    message: 'Payment confirmed successfully',
    data: { payment },
  });
});

// @desc    Initialize Paystack transaction
// @route   POST /api/v1/payments/paystack/initialize
// @access  Private
exports.initializePaystack = asyncHandler(async (req, res, next) => {
  const { amount, type, orderId, planId, autoRenew } = req.body;

  const reference = `PAY-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

  const transaction = await PaystackTransaction.create({
    reference,
    amount,
    type: type || 'order',
    customerId: req.user.customerId,
    orderId,
    planId,
    autoRenew,
  });

  res.status(201).json({
    success: true,
    message: 'Paystack transaction initialized',
    data: { transaction },
  });
});

// @desc    Verify Paystack transaction
// @route   GET /api/v1/payments/paystack/verify/:reference
// @access  Private
exports.verifyPaystack = asyncHandler(async (req, res, next) => {
  const transaction = await PaystackTransaction.findOne({ reference: req.params.reference });

  if (!transaction) {
    return next(new AppError('Transaction not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Transaction status fetched',
    data: { transaction },
  });
});
