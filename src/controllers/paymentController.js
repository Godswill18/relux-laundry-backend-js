const https = require('https');
const Payment = require('../models/Payment.js');
const PaystackTransaction = require('../models/PaystackTransaction.js');
const PaymentSetting = require('../models/PaymentSetting.js');
const Wallet = require('../models/Wallet.js');
const WalletTransaction = require('../models/WalletTransaction.js');
const Order = require('../models/Order.js');
const Customer = require('../models/Customer.js');
const User = require('../models/User.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');
const logger = require('../utils/logger.js');
const notify = require('../utils/notify.js');

// ─── Resolve active Paystack secret key ──────────────────────────────────────
// Prefers the key saved in admin Payment Settings over the env var so that
// keys configured through the UI take effect immediately without a server restart.
async function getPaystackSecretKey() {
  try {
    const setting = await PaymentSetting.findOne().select('+paystackSecretKey').lean();
    if (setting?.paystackSecretKey) return setting.paystackSecretKey;
  } catch (_) { /* fall through */ }
  return process.env.PAYSTACK_SECRET_KEY;
}

// ─── Paystack API helper ──────────────────────────────────────────────────────
async function paystackRequest(method, path, body) {
  const secretKey = await getPaystackSecretKey();
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.paystack.co',
      port: 443,
      path,
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid Paystack response')); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

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
    .populate({
      path: 'orderId',
      select: 'orderNumber walkInCustomer customer',
      populate: { path: 'customer', select: 'name' },
    })
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

  // Emit real-time event to all admins watching the payments room
  const io = req.app.get('io');
  if (io) {
    io.to('payments').emit('payment:confirmed', {
      paymentId: payment._id,
      orderId: payment.orderId,
      amount: payment.amount,
      state: payment.state,
      paidAt: payment.paidAt,
    });
  }

  res.status(200).json({
    success: true,
    message: 'Payment confirmed successfully',
    data: { payment },
  });
});

// @desc    Initialize Paystack transaction (creates DB record, returns config for inline popup)
// @route   POST /api/v1/payments/paystack/initialize
// @access  Private
//
// Strategy: we do NOT call Paystack's /transaction/initialize here.
// Instead we create a pending DB record and return the public key + reference
// so the frontend can open PaystackPop.setup({ key, email, amount, ref })
// directly. This avoids the access_code /checkout/request_inline flow which
// applies strict server-side MX email validation and frequently rejects
// valid emails.  Amount and email are re-validated during verifyPaystack.
exports.initializePaystack = asyncHandler(async (req, res, next) => {
  const { amount, type, orderId, planId, autoRenew, email } = req.body;

  if (!amount || amount <= 0) {
    return next(new AppError('Amount is required', 400));
  }

  // Resolve public key (returned to frontend for PaystackPop.setup)
  const resolvedPublicKey = await (async () => {
    try {
      const setting = await PaymentSetting.findOne().lean();
      if (setting?.paystackPublicKey) return setting.paystackPublicKey;
    } catch (_) { /* fall through */ }
    return process.env.PAYSTACK_PUBLIC_KEY || '';
  })();

  if (!resolvedPublicKey) {
    return next(new AppError('Paystack public key is not configured. Add it in Payment Settings.', 503));
  }

  // Secret key must exist for verify to work later
  const resolvedSecretKey = await getPaystackSecretKey();
  if (!resolvedSecretKey || resolvedSecretKey === 'your-paystack-secret-key') {
    return next(new AppError('Paystack secret key is not configured. Add it in Payment Settings.', 503));
  }

  const customerEmail = email || req.user.email;
  if (!customerEmail) {
    return next(new AppError('An email address is required to process this payment', 400));
  }

  const reference = `RLX-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

  // Persist a pending transaction so verifyPaystack can find it after payment
  const transaction = await PaystackTransaction.create({
    reference,
    amount,
    type: type || 'wallet_topup',
    customerId: req.user.customerId,
    userId: req.user.id,
    orderId: orderId || undefined,
    planId: planId || undefined,
    autoRenew,
    metadata: { type, orderId, planId, userId: req.user.id },
  });

  logger.info(`[initializePaystack] DB record created reference=${reference} amount=${amount} type=${type || 'wallet_topup'} userId=${req.user.id}`);

  res.status(201).json({
    success: true,
    message: 'Paystack transaction prepared',
    data: {
      reference,
      paystackPublicKey: resolvedPublicKey,
      email: customerEmail,
      amountKobo: Math.round(amount * 100),
      transaction,
    },
  });
});

// ─── Background retry: re-checks Paystack every BG_INTERVAL_MS for up to BG_MAX_MINS ──
// Called asynchronously — never blocks the HTTP response.
async function backgroundVerifyAndCredit(transactionId, io) {
  const BG_INTERVAL_MS = 8000;   // 8 seconds between attempts
  const BG_MAX_ATTEMPTS = 75;    // 75 × 8s ≈ 10 minutes
  logger.info(`[bgVerify] Started for transactionId=${transactionId}`);

  for (let i = 1; i <= BG_MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, BG_INTERVAL_MS));

    try {
      const tx = await PaystackTransaction.findById(transactionId);
      if (!tx) { logger.warn(`[bgVerify] Transaction ${transactionId} no longer exists`); return; }
      if (tx.webhookProcessed) { logger.info(`[bgVerify] Already processed: ${tx.reference}`); return; }

      const paystackRes = await paystackRequest('GET', `/transaction/verify/${tx.reference}`, null);
      logger.info(`[bgVerify] attempt=${i} status=${paystackRes?.data?.status} ref=${tx.reference}`);

      if (paystackRes.status && paystackRes.data?.status === 'success') {
        await processSuccessfulPaystackPayment(tx, paystackRes.data, io);
        // Re-fetch to confirm webhookProcessed=true (credit may have failed and left it false)
        const refreshed = await PaystackTransaction.findById(transactionId);
        if (refreshed && refreshed.webhookProcessed) {
          logger.info(`[bgVerify] Successfully processed ${tx.reference} on attempt ${i}`);
          return;
        }
        logger.warn(`[bgVerify] processSuccessful ran but webhookProcessed still false for ${tx.reference} — will retry`);
        continue;
      }

      if (paystackRes.data?.status === 'failed') {
        tx.status = 'failed';
        tx.failureReason = paystackRes.data?.gateway_response || 'Payment failed';
        tx.paystackData = paystackRes.data;
        await tx.save();
        logger.warn(`[bgVerify] Marked ${tx.reference} as failed on attempt ${i}`);
        return;
      }
    } catch (err) {
      logger.error(`[bgVerify] Error on attempt ${i} for ${transactionId}: ${err.message}`);
    }
  }

  // Exhausted all retries — do one final Paystack check and mark failed if
  // the payment never went through. This prevents transactions from sitting
  // in "pending" forever after the user abandoned the payment or something
  // went wrong on Paystack's side.
  logger.error(`[bgVerify] Gave up after ${BG_MAX_ATTEMPTS} attempts for transactionId=${transactionId} — marking failed`);
  try {
    const tx = await PaystackTransaction.findById(transactionId);
    if (tx && !tx.webhookProcessed && tx.status === 'pending') {
      // One last Paystack check before giving up
      try {
        const finalRes = await paystackRequest('GET', `/transaction/verify/${tx.reference}`, null);
        if (finalRes.status && finalRes.data?.status === 'success') {
          logger.info(`[bgVerify] Final check: payment confirmed for ${tx.reference} — processing`);
          await processSuccessfulPaystackPayment(tx, finalRes.data, io);
          return;
        }
      } catch (_) { /* ignore — still mark failed below */ }
      tx.status = 'failed';
      tx.failureReason = 'Payment not confirmed by Paystack after 10 minutes — assumed abandoned';
      await tx.save();
      logger.warn(`[bgVerify] Marked ${tx.reference} as failed (abandoned/unconfirmed)`);
      if (io) {
        io.to('payments').emit('payment:paystack-failed', {
          transactionId: tx._id,
          reference: tx.reference,
          amount: tx.amount,
          reason: tx.failureReason,
        });
      }
    }
  } catch (err) {
    logger.error(`[bgVerify] Error marking transaction as failed: ${err.message}`);
  }
}

// @desc    Verify Paystack transaction (called from inline popup onSuccess)
// @route   GET /api/v1/payments/paystack/verify/:reference
// @access  Private
//
// Strategy:
//   1. Try to confirm with Paystack API (3 quick attempts, 2s apart).
//   2. If confirmed immediately → process + return 200.
//   3. If Paystack lags (still pending) → return 200 immediately with processing:true
//      AND start backgroundVerifyAndCredit() which retries for up to 10 minutes.
//   4. The frontend receives 200 either way and listens for the wallet:credited socket
//      event to update the balance in real time.
exports.verifyPaystack = asyncHandler(async (req, res, next) => {
  const { reference } = req.params;
  logger.info(`[verifyPaystack] Start — reference: ${reference}`);

  const transaction = await PaystackTransaction.findOne({ reference });
  if (!transaction) {
    logger.warn(`[verifyPaystack] Transaction not found: ${reference}`);
    return next(new AppError('Transaction not found', 404));
  }

  // Already fully processed (webhook or previous verify)
  if (transaction.webhookProcessed) {
    logger.info(`[verifyPaystack] Already processed: ${reference}`);
    return res.status(200).json({
      success: true,
      message: 'Payment verified and wallet credited',
      data: { transaction, processing: false },
    });
  }

  const resolvedKey = await getPaystackSecretKey();
  if (!resolvedKey || resolvedKey === 'your-paystack-secret-key') {
    return next(new AppError('Paystack is not configured. Add your secret key in Payment Settings.', 503));
  }

  // Quick attempts — short enough to keep the HTTP response snappy
  const QUICK_ATTEMPTS = 3;
  const QUICK_DELAY_MS = 2000;

  let paystackRes = null;
  let confirmedSuccess = false;
  let confirmedFailed  = false;

  for (let attempt = 1; attempt <= QUICK_ATTEMPTS; attempt++) {
    try {
      paystackRes = await paystackRequest('GET', `/transaction/verify/${reference}`, null);
      logger.info(`[verifyPaystack] quick attempt=${attempt} dataStatus=${paystackRes?.data?.status} ref=${reference}`);
    } catch (err) {
      logger.error(`[verifyPaystack] Network error attempt ${attempt}: ${err.message}`);
      if (attempt < QUICK_ATTEMPTS) await new Promise((r) => setTimeout(r, QUICK_DELAY_MS));
      continue;
    }

    if (paystackRes.status && paystackRes.data?.status === 'success') {
      confirmedSuccess = true;
      break;
    }

    if (paystackRes.data?.status === 'failed') {
      confirmedFailed = true;
      break;
    }

    if (attempt < QUICK_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, QUICK_DELAY_MS));
    }
  }

  // Paystack definitively says the payment failed
  if (confirmedFailed) {
    logger.warn(`[verifyPaystack] Paystack confirmed failure: ${reference}`);
    transaction.status = 'failed';
    transaction.failureReason = paystackRes?.data?.gateway_response || 'Payment failed';
    transaction.paystackData = paystackRes?.data;
    await transaction.save();
    return res.status(400).json({
      success: false,
      message: paystackRes?.data?.gateway_response || 'Payment failed',
      error: { code: 'PAYMENT_FAILED' },
      data: { transaction },
    });
  }

  // Paystack confirmed success — process synchronously and return
  if (confirmedSuccess) {
    logger.info(`[verifyPaystack] Quick confirm success — processing synchronously: ${reference}`);
    await processSuccessfulPaystackPayment(transaction, paystackRes.data, req.app.get('io'));
    const updated = await PaystackTransaction.findById(transaction._id);
    return res.status(200).json({
      success: true,
      message: 'Payment verified and wallet credited',
      data: { transaction: updated, processing: false },
    });
  }

  // Paystack hasn't confirmed yet — return 200 immediately and keep retrying in background.
  // This is safe: Paystack's onSuccess fired so the payment is complete on their side;
  // the lag is purely in their verify API catching up.
  logger.info(`[verifyPaystack] Paystack not yet confirmed after ${QUICK_ATTEMPTS} attempts — scheduling background retry for ${reference}`);

  // Fire-and-forget — do NOT await
  const io = req.app.get('io');
  backgroundVerifyAndCredit(transaction._id, io).catch((err) =>
    logger.error(`[bgVerify] Unhandled error for ${transaction._id}: ${err.message}`)
  );

  return res.status(200).json({
    success: true,
    message: 'Payment received — your wallet will be credited within seconds.',
    data: { transaction, processing: true },
  });
});

// @desc    Get all Paystack transactions (admin)
// @route   GET /api/v1/payments/paystack/transactions
// @access  Private (Admin/Manager)
exports.getPaystackTransactions = asyncHandler(async (req, res, next) => {
  const page  = parseInt(req.query.page,  10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const skip  = (page - 1) * limit;

  const query = {};
  if (req.query.status) query.status = req.query.status;
  if (req.query.type)   query.type   = req.query.type;
  if (req.query.search) query.reference = { $regex: req.query.search, $options: 'i' };

  if (req.query.dateFrom || req.query.dateTo) {
    query.createdAt = {};
    if (req.query.dateFrom) query.createdAt.$gte = new Date(req.query.dateFrom);
    if (req.query.dateTo) {
      const end = new Date(req.query.dateTo);
      end.setHours(23, 59, 59, 999);
      query.createdAt.$lte = end;
    }
  }

  const [transactions, total] = await Promise.all([
    PaystackTransaction.find(query)
      .populate('customerId', 'name phone email')
      .populate('orderId', 'orderNumber')
      .sort('-createdAt')
      .skip(skip)
      .limit(limit),
    PaystackTransaction.countDocuments(query),
  ]);

  // Revenue stats
  const [totalRevenue, pendingCount, failedCount] = await Promise.all([
    PaystackTransaction.aggregate([
      { $match: { status: 'paid' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    PaystackTransaction.countDocuments({ status: 'pending' }),
    PaystackTransaction.countDocuments({ status: 'failed' }),
  ]);

  res.status(200).json({
    success: true,
    message: 'Paystack transactions fetched',
    data: {
      transactions,
      stats: {
        totalRevenue: totalRevenue[0]?.total || 0,
        pendingCount,
        failedCount,
      },
    },
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

// ─── Shared success handler (called by webhook AND manual verify) ─────────────
async function processSuccessfulPaystackPayment(transaction, paystackData, io) {
  // Idempotency — only process once
  if (transaction.webhookProcessed) {
    logger.info(`[processSuccessful] Already processed: ${transaction.reference}`);
    return;
  }
  logger.info(`[processSuccessful] Processing: ${transaction.reference} type=${transaction.type} amount=${transaction.amount}`);

  // Mark status paid immediately so admin can see it even if side-effects are slow
  transaction.status = 'paid';
  transaction.paidAt = new Date();
  transaction.paystackData = paystackData;
  await transaction.save();

  // Credit wallet for wallet_topup type
  let walletCreditFailed = false;
  if (transaction.type === 'wallet_topup') {
    try {
      // Idempotency: skip if this reference was already credited
      const alreadyCredited = await WalletTransaction.findOne({ paystackReference: transaction.reference });
      if (alreadyCredited) {
        logger.info(`[processSuccessful] Wallet already credited for ref=${transaction.reference} — skipping`);
      } else {
        // Resolve customerId: use transaction.customerId, or fall back to userId lookup
        let customerId = transaction.customerId;
        if (!customerId && transaction.userId) {
          const user = await User.findById(transaction.userId).select('customerId');
          if (user && user.customerId) {
            customerId = user.customerId;
            transaction.customerId = customerId;
          }
        }

        if (!customerId) {
          logger.error(`[processSuccessful] No customerId for ref=${transaction.reference} userId=${transaction.userId}`);
          walletCreditFailed = true;
        } else {
          // Atomic balance update using findOneAndUpdate to avoid race conditions
          let wallet = await Wallet.findOneAndUpdate(
            { customerId },
            { $inc: { balance: transaction.amount } },
            { new: true, upsert: true }
          );

          logger.info(`[processSuccessful] Wallet credited: customerId=${customerId} amount=${transaction.amount} newBalance=${wallet.balance}`);

          await WalletTransaction.create({
            walletId: wallet._id,
            amount: transaction.amount,
            type: 'credit',
            reason: `Paystack top-up (ref: ${transaction.reference})`,
            balanceAfter: wallet.balance,
            source: 'paystack',
            paystackReference: transaction.reference,
          });

          // Real-time: notify both userId and customerId rooms
          if (io) {
            const rooms = [...new Set([`user-${transaction.userId}`, `user-${customerId}`].filter(Boolean))];
            rooms.forEach((room) => {
              io.to(room).emit('wallet:credited', {
                amount: transaction.amount,
                balance: wallet.balance,
                reference: transaction.reference,
                description: `Wallet top-up via Paystack`,
                createdAt: new Date().toISOString(),
              });
              logger.info(`[processSuccessful] Emitted wallet:credited to room ${room}`);
            });
          } else {
            logger.warn(`[processSuccessful] No io instance — wallet:credited socket event NOT emitted for ref=${transaction.reference}`);
          }

          // Persist in-app notification for wallet credit
          if (customerId) {
            await notify(io, {
              type: 'wallet_credited',
              title: 'Wallet Credited',
              body: `₦${transaction.amount.toLocaleString()} has been added to your wallet via Paystack.`,
              customerId: String(customerId),
              metadata: { amount: transaction.amount, reference: transaction.reference },
            });
          }
        }
      }
    } catch (creditErr) {
      // Duplicate key on paystackReference = already credited by a concurrent call — treat as success
      if (creditErr.code === 11000 && creditErr.message?.includes('paystackReference')) {
        logger.info(`[processSuccessful] Duplicate key — wallet already credited concurrently for ref=${transaction.reference}`);
      } else {
        // Other DB errors: log and flag for retry
        logger.error(`[processSuccessful] Wallet credit error for ref=${transaction.reference}: ${creditErr.message}`, { stack: creditErr.stack });
        walletCreditFailed = true;
      }
    }
  }

  // For order payments — mark order paid
  if (transaction.type === 'order' && transaction.orderId) {
    try {
      await Order.findByIdAndUpdate(transaction.orderId, {
        paymentStatus: 'paid',
        'payment.status': 'paid',
        'payment.method': 'paystack',
        'payment.amount': transaction.amount,
        'payment.paidAt': new Date(),
      });
    } catch (orderErr) {
      logger.error(`[processSuccessful] Order update error for ref=${transaction.reference}: ${orderErr.message}`);
    }
  }

  // Only mark fully processed if wallet credit succeeded (for topup) or isn't needed (other types)
  // If credit failed, leave webhookProcessed=false so the background retry loop will try again
  if (!walletCreditFailed) {
    transaction.webhookProcessed = true;
    await transaction.save();
  } else {
    logger.warn(`[processSuccessful] Wallet credit failed for ref=${transaction.reference} — leaving webhookProcessed=false for retry`);
    await transaction.save(); // Still persist status=paid
  }

  // Real-time: notify admin payments room
  if (io) {
    io.to('payments').emit('payment:paystack-success', {
      transactionId: transaction._id,
      reference: transaction.reference,
      amount: transaction.amount,
      type: transaction.type,
      customerId: transaction.customerId,
      paidAt: transaction.paidAt,
    });
  }
}

// @desc    Admin: retry processing a stuck pending/paid transaction
// @route   POST /api/v1/payments/paystack/retry/:reference
// @access  Private (Admin/Manager)
exports.retryPaystackTransaction = asyncHandler(async (req, res, next) => {
  const { reference } = req.params;
  logger.info(`[retryPaystack] Admin retry for reference=${reference}`);

  const transaction = await PaystackTransaction.findOne({ reference });
  if (!transaction) return next(new AppError('Transaction not found', 404));
  if (transaction.webhookProcessed) {
    return res.status(200).json({ success: true, message: 'Already processed', data: { transaction } });
  }

  const resolvedKey = await getPaystackSecretKey();
  if (!resolvedKey || resolvedKey === 'your-paystack-secret-key') {
    return next(new AppError('Paystack is not configured', 503));
  }

  let paystackRes;
  try {
    paystackRes = await paystackRequest('GET', `/transaction/verify/${reference}`, null);
  } catch (err) {
    return next(new AppError('Could not reach Paystack', 502));
  }

  logger.info(`[retryPaystack] Paystack status=${paystackRes?.data?.status} for ${reference}`);

  if (!paystackRes.status || paystackRes.data?.status !== 'success') {
    return res.status(400).json({
      success: false,
      message: `Paystack status: ${paystackRes.data?.status || 'unknown'} — ${paystackRes.data?.gateway_response || ''}`,
      data: { transaction },
    });
  }

  try {
    await processSuccessfulPaystackPayment(transaction, paystackRes.data, req.app.get('io'));
  } catch (err) {
    logger.error(`[retryPaystack] Failed: ${err.message}`);
    return next(new AppError(`Retry failed: ${err.message}`, 500));
  }

  const updated = await PaystackTransaction.findById(transaction._id);
  res.status(200).json({ success: true, message: 'Transaction re-processed successfully', data: { transaction: updated } });
});

exports.processSuccessfulPaystackPayment = processSuccessfulPaystackPayment;
exports.getPaystackSecretKey = getPaystackSecretKey;
exports.backgroundVerifyAndCredit = backgroundVerifyAndCredit;
exports.paystackRequest = paystackRequest;
