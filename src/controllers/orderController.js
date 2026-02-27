const Order = require('../models/Order.js');
const OrderItem = require('../models/OrderItem.js');
const OrderMedia = require('../models/OrderMedia.js');
const Customer = require('../models/Customer.js');
const Wallet = require('../models/Wallet.js');
const WalletTransaction = require('../models/WalletTransaction.js');
const Referral = require('../models/Referral.js');
const ReferralSetting = require('../models/ReferralSetting.js');
const User = require('../models/User.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');
const ERROR_CODES = require('../utils/errorCodes.js');
const { calculateOrderPricing, generateQRCode } = require('../utils/helpers.js');

// @desc    Create new order (online or offline walk-in)
// @route   POST /api/v1/orders
// @access  Private
exports.createOrder = asyncHandler(async (req, res, next) => {
  const {
    serviceType,
    orderType,
    orderSource,
    walkInCustomer,
    items,
    pickupAddress,
    deliveryAddress,
    pickupDate,
    scheduledPickupTime,
    specialInstructions,
    pricing,
    paymentMethod,
    customerId: bodyCustomerId,
    assignedStaff,
    serviceLevel,
    pickupMethod,
    rush,
    stainRemoval,
  } = req.body;

  const isStaffRole = ['staff', 'admin', 'manager'].includes(req.user.role);
  // Auto-classify: staff/admin/manager always creates walk-in (offline); customers always create online
  const isOffline = isStaffRole;

  // Determine the customer for this order
  let orderCustomerId = null;
  let orderCustomerRefId = null;

  if (isOffline && isStaffRole) {
    // Offline walk-in order created by staff — no customer User account required
    // walkInCustomer.name and walkInCustomer.phone are used instead
    if (!walkInCustomer || !walkInCustomer.name) {
      return next(new AppError('Walk-in customer name is required for offline orders', 400));
    }
    // Use the staff member's own ID as a placeholder to satisfy the schema
    orderCustomerId = req.user.id;
  } else {
    // Online order
    orderCustomerId = req.user.id;
    orderCustomerRefId = req.user.customerId;

    if (bodyCustomerId && isStaffRole) {
      const customer = await Customer.findById(bodyCustomerId);
      if (!customer) {
        return next(new AppError('Customer not found', 404));
      }
      const customerUser = await User.findOne({ customerId: bodyCustomerId });
      orderCustomerId = customerUser ? customerUser._id : req.user.id;
      orderCustomerRefId = bodyCustomerId;
    }
  }

  // Validate that every item includes a serviceType
  if (Array.isArray(items) && items.length > 0) {
    const missing = items.find((item) => !item.serviceType);
    if (missing) {
      return next(new AppError(`Item "${missing.itemType || 'unknown'}" is missing a service type`, 400));
    }
  }

  // Calculate pricing if not provided
  let orderPricing = pricing;
  if (!pricing) {
    orderPricing = calculateOrderPricing(
      items || [],
      req.body.pickupFee || 0,
      req.body.deliveryFee || 0,
      req.body.discount || 0
    );
  }

  // Create order
  const order = await Order.create({
    customer: orderCustomerId,
    orderSource: isOffline ? 'offline' : 'online',
    walkInCustomer: isOffline ? walkInCustomer : undefined,
    createdByStaff: isStaffRole ? req.user.id : undefined,
    serviceType,
    orderType: orderType || (isOffline ? 'walk-in' : undefined),
    items: items || [],
    pickupAddress: orderType === 'pickup-delivery' ? pickupAddress : undefined,
    deliveryAddress: orderType === 'pickup-delivery' ? deliveryAddress : undefined,
    pickupDate,
    scheduledPickupTime,
    specialInstructions,
    serviceLevel: serviceLevel || 'standard',
    pickupMethod: pickupMethod || undefined,
    rush: rush || false,
    stainRemoval: stainRemoval || false,
    assignedStaff: isOffline ? req.user.id : (assignedStaff || undefined),
    pricing: orderPricing,
    payment: {
      method: paymentMethod || 'cash',
      status: 'pending',
      amount: orderPricing.total,
    },
  });

  // Generate QR code
  order.qrCode = generateQRCode(order.orderNumber);
  await order.save();

  // Handle wallet payment if payment method is 'wallet'
  if (paymentMethod && paymentMethod.toLowerCase() === 'wallet') {
    // Get customer's wallet
    const wallet = await Wallet.findOne({ customerId: orderCustomerRefId });

    if (!wallet) {
      return next(new AppError('Wallet not found for this customer', 404, ERROR_CODES.NOT_FOUND));
    }

    // Validate sufficient balance
    if (wallet.balance < orderPricing.total) {
      return next(new AppError('Insufficient wallet balance', 400, ERROR_CODES.INSUFFICIENT_BALANCE));
    }

    // Deduct from wallet
    wallet.balance -= orderPricing.total;
    await wallet.save();

    // Create wallet transaction
    await WalletTransaction.create({
      walletId: wallet._id,
      customerId: orderCustomerRefId,
      type: 'debit',
      amount: orderPricing.total,
      reason: `Payment for order ${order.orderNumber}`,
      balanceAfter: wallet.balance,
      orderId: order._id,
    });

    // Mark payment as paid
    order.payment.status = 'paid';
    order.payment.paidAt = new Date();
    await order.save();

    // Emit Socket.io event for wallet update
    const io = req.app.get('io');
    if (io) {
      io.to(`user-${orderCustomerRefId}`).emit('wallet:balance-updated', {
        balance: wallet.balance,
        transaction: {
          type: 'debit',
          amount: orderPricing.total,
          reason: `Payment for order ${order.orderNumber}`,
        },
      });
    }
  }

  // Emit socket event for real-time update
  const io = req.app.get('io');
  if (io) {
    io.emit('order-created', order);
    io.to(`user-${orderCustomerRefId || orderCustomerId}`).emit('order:created', order);
  }

  res.status(201).json({
    success: true,
    message: 'Order created successfully',
    data: { order },
  });
});

// @desc    Get all orders
// @route   GET /api/v1/orders
// @access  Private
// Query params (staff/admin):
//   ?status=pending
//   ?orderSource=online|offline
//   ?assignedStaff=me            → orders assigned to logged-in staff
//   ?unassigned=true             → pending orders with no staff assigned
//   ?tab=new|mine|offline        → convenience shorthand for staff tabs
exports.getOrders = asyncHandler(async (req, res, next) => {
  let query;

  // Customers only see their own orders
  if (req.user.role === 'customer') {
    query = { customer: req.user.id };
  } else {
    query = {};

    // --- Staff dashboard tab shortcuts ---
    if (req.query.tab === 'new') {
      // Unassigned online orders available to claim
      query.orderSource = 'online';
      query.assignedStaff = { $exists: false };
      query.status = { $in: ['pending', 'confirmed'] };
    } else if (req.query.tab === 'mine') {
      // Orders assigned to this staff member that are still active
      query.assignedStaff = req.user.id;
      query.status = { $nin: ['completed', 'delivered', 'cancelled'] };
    } else if (req.query.tab === 'offline') {
      // Offline walk-in orders created by this staff member
      query.orderSource = 'offline';
      if (req.user.role === 'staff') query.createdByStaff = req.user.id;
    } else if (req.query.tab === 'completed') {
      // All finished orders handled by this staff (assigned OR created)
      query.$or = [
        { assignedStaff: req.user.id },
        { createdByStaff: req.user.id },
      ];
      query.status = { $in: ['completed', 'delivered'] };
    } else {
      // Manual filters
      if (req.query.status) query.status = req.query.status;
      if (req.query.serviceType) query.serviceType = req.query.serviceType;
      if (req.query.customer) query.customer = req.query.customer;
      if (req.query.orderSource) query.orderSource = req.query.orderSource;

      if (req.query.assignedStaff === 'me') {
        query.assignedStaff = req.user.id;
      } else if (req.query.assignedStaff) {
        query.assignedStaff = req.query.assignedStaff;
      }

      if (req.query.unassigned === 'true') {
        query.assignedStaff = { $exists: false };
      }
    }
  }

  // Pagination
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 10;
  const startIndex = (page - 1) * limit;

  const total = await Order.countDocuments(query);

  const orders = await Order.find(query)
    .populate({
      path: 'customer',
      select: 'name phone email avatar customerId',
      populate: {
        path: 'customerId',
        select: 'loyaltyPointsBalance status loyaltyTierId',
        populate: { path: 'loyaltyTierId', select: 'name rank multiplierPercent' },
      },
    })
    .populate('assignedStaff', 'name phone staffRole email')
    .sort('-createdAt')
    .skip(startIndex)
    .limit(limit);

  res.status(200).json({
    success: true,
    message: 'Orders fetched successfully',
    data: { orders },
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

// @desc    Get single order
// @route   GET /api/v1/orders/:id
// @access  Private
exports.getOrder = asyncHandler(async (req, res, next) => {
  const order = await Order.findById(req.params.id)
    .populate({
      path: 'customer',
      select: 'name phone email addresses avatar customerId',
      populate: {
        path: 'customerId',
        select: 'loyaltyPointsBalance status loyaltyTierId',
        populate: { path: 'loyaltyTierId', select: 'name rank multiplierPercent freePickup freeDelivery' },
      },
    })
    .populate('assignedStaff', 'name phone staffRole email avatar')
    .populate('statusHistory.updatedBy', 'name role');

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  // Check if user has access to this order
  if (
    req.user.role === 'customer' &&
    order.customer._id.toString() !== req.user.id
  ) {
    return next(new AppError('Not authorized to access this order', 403));
  }

  res.status(200).json({
    success: true,
    message: 'Order fetched successfully',
    data: { order },
  });
});

// @desc    Update order status
// @route   PUT /api/v1/orders/:id/status
// @access  Private (Staff/Admin)
exports.updateOrderStatus = asyncHandler(async (req, res, next) => {
  const { status, notes } = req.body;

  const order = await Order.findById(req.params.id);

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  // Update status
  order.status = status;
  if (notes) order.notes = notes;

  // Add to status history
  order.statusHistory.push({
    status,
    updatedBy: req.user.id,
    notes,
  });

  await order.save();

  // Handle referral rewards when order is completed
  if (status && status.toLowerCase() === 'completed') {
    // Check if this is the customer's first completed order
    const completedOrdersCount = await Order.countDocuments({
      customer: order.customer,
      status: 'completed',
    });

    if (completedOrdersCount === 1) {
      // This is the first completed order - check for referral
      const orderCustomer = await Order.findById(order._id).populate('customer');
      const customerId = orderCustomer.customer._id;

      // Find referral where this customer is the referee
      const referral = await Referral.findOne({
        refereeUserId: customerId,
        status: { $in: ['pending', 'qualified'] },
      });

      if (referral) {
        // Get referral settings
        const settings = await ReferralSetting.findOne();
        const rewardAmount = settings?.referrerRewardAmount || 1000;

        // Get referrer's customer ID
        const referrerUser = await User.findById(referral.referrerUserId);
        if (referrerUser && referrerUser.customerId) {
          // Get referrer's wallet
          const referrerWallet = await Wallet.findOne({ customerId: referrerUser.customerId });

          if (referrerWallet) {
            // Credit referrer's wallet
            referrerWallet.balance += rewardAmount;
            await referrerWallet.save();

            // Create wallet transaction
            await WalletTransaction.create({
              walletId: referrerWallet._id,
              customerId: referrerUser.customerId,
              type: 'credit',
              amount: rewardAmount,
              reason: `Referral reward for ${orderCustomer.customer.name}`,
              balanceAfter: referrerWallet.balance,
            });

            // Update referral status
            referral.status = 'rewarded';
            referral.rewardCredited = true;
            referral.rewardAmount = rewardAmount;
            await referral.save();

            // Emit Socket.io event for referrer
            const io = req.app.get('io');
            if (io) {
              io.to(`user-${referrerUser.customerId}`).emit('wallet:balance-updated', {
                balance: referrerWallet.balance,
                transaction: {
                  type: 'credit',
                  amount: rewardAmount,
                  reason: `Referral reward for ${orderCustomer.customer.name}`,
                },
              });

              io.to(`user-${referrerUser.customerId}`).emit('referral:rewarded', {
                referralId: referral._id,
                amount: rewardAmount,
                refereeName: orderCustomer.customer.name,
              });
            }
          }
        }
      }
    }
  }

  // Emit socket event
  const io = req.app.get('io');
  if (io) {
    io.to(`order-${order._id}`).emit('order-status-updated', {
      orderId: order._id,
      status,
      notes,
    });
  }

  res.status(200).json({
    success: true,
    message: 'Order status updated successfully',
    data: { order },
  });
});

// @desc    Assign staff to order
// @route   PUT /api/v1/orders/:id/assign
// @access  Private (Admin)
exports.assignStaff = asyncHandler(async (req, res, next) => {
  const { staffId } = req.body;

  const order = await Order.findByIdAndUpdate(
    req.params.id,
    { assignedStaff: staffId },
    { new: true, runValidators: true }
  ).populate('assignedStaff', 'name phone staffRole');

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Staff assigned successfully',
    data: { order },
  });
});

// @desc    Staff accepts/claims an unassigned online order
// @route   PATCH /api/v1/orders/:id/accept
// @access  Private (Staff/Admin/Manager)
exports.acceptOrder = asyncHandler(async (req, res, next) => {
  const order = await Order.findById(req.params.id);

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  if (order.assignedStaff) {
    return next(new AppError('This order has already been claimed by another staff member', 400));
  }

  if (['completed', 'cancelled', 'delivered'].includes(order.status)) {
    return next(new AppError('Cannot accept a completed or cancelled order', 400));
  }

  order.assignedStaff = req.user.id;
  order.status = 'confirmed';
  order.statusHistory.push({
    status: 'confirmed',
    updatedBy: req.user.id,
    notes: `Order accepted by staff: ${req.user.name}`,
  });
  await order.save();

  await order.populate('assignedStaff', 'name phone staffRole');
  await order.populate('customer', 'name phone email');

  const io = req.app.get('io');
  if (io) {
    io.to(`order-${order._id}`).emit('order-status-updated', {
      orderId: order._id,
      status: 'confirmed',
      assignedStaff: req.user.id,
    });
    io.to(`user-${order.customer?._id || order.customer}`).emit('order:accepted', {
      orderId: order._id,
      orderNumber: order.orderNumber,
      staffName: req.user.name,
    });
  }

  res.status(200).json({
    success: true,
    message: 'Order accepted successfully',
    data: { order },
  });
});

// @desc    Update payment status
// @route   PUT /api/v1/orders/:id/payment
// @access  Private (Staff/Admin)
exports.updatePayment = asyncHandler(async (req, res, next) => {
  const { status, method, transactionId } = req.body;

  const order = await Order.findById(req.params.id);

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  order.payment.status = status;
  if (method) order.payment.method = method;
  if (transactionId) order.payment.transactionId = transactionId;

  if (status === 'paid') {
    order.payment.paidAt = Date.now();
  }

  await order.save();

  res.status(200).json({
    success: true,
    message: 'Payment updated successfully',
    data: { order },
  });
});

// @desc    Cancel order
// @route   PUT /api/v1/orders/:id/cancel
// @access  Private
exports.cancelOrder = asyncHandler(async (req, res, next) => {
  const { reason } = req.body;

  const order = await Order.findById(req.params.id);

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  // Check if user has permission to cancel
  if (
    req.user.role === 'customer' &&
    order.customer.toString() !== req.user.id
  ) {
    return next(new AppError('Not authorized to cancel this order', 403));
  }

  // Check if order can be cancelled
  if (['delivered', 'completed', 'cancelled'].includes(order.status)) {
    return next(new AppError('Order cannot be cancelled', 400));
  }

  order.status = 'cancelled';
  order.notes = `Cancelled: ${reason}`;

  order.statusHistory.push({
    status: 'cancelled',
    updatedBy: req.user.id,
    notes: reason,
  });

  await order.save();

  res.status(200).json({
    success: true,
    message: 'Order cancelled successfully',
    data: { order },
  });
});

// @desc    Add order item
// @route   POST /api/v1/orders/:id/items
// @access  Private
exports.addOrderItem = asyncHandler(async (req, res, next) => {
  const order = await Order.findById(req.params.id);

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  if (req.user.role === 'customer' && order.customer.toString() !== req.user.id) {
    return next(new AppError('Not authorized', 403));
  }

  const { serviceCategoryId, quantity, unitPrice, careType, serviceLevel } = req.body;

  const subtotal = quantity * unitPrice;

  const orderItem = await OrderItem.create({
    orderId: order._id,
    serviceCategoryId,
    quantity,
    unitPrice,
    subtotal,
    careType,
    serviceLevel,
  });

  res.status(201).json({
    success: true,
    message: 'Order item added successfully',
    data: { orderItem },
  });
});

// @desc    Remove order item
// @route   DELETE /api/v1/orders/:id/items/:itemId
// @access  Private
exports.removeOrderItem = asyncHandler(async (req, res, next) => {
  const order = await Order.findById(req.params.id);

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  if (req.user.role === 'customer' && order.customer.toString() !== req.user.id) {
    return next(new AppError('Not authorized', 403));
  }

  const orderItem = await OrderItem.findOneAndDelete({
    _id: req.params.itemId,
    orderId: order._id,
  });

  if (!orderItem) {
    return next(new AppError('Order item not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Order item removed successfully',
    data: {},
  });
});

// @desc    Add order media
// @route   POST /api/v1/orders/:id/media
// @access  Private
exports.addOrderMedia = asyncHandler(async (req, res, next) => {
  const order = await Order.findById(req.params.id);

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  const { mediaUrl, note } = req.body;
  const source = req.user.role === 'customer' ? 'customer' : 'staff';

  const media = await OrderMedia.create({
    orderId: order._id,
    mediaUrl,
    source,
    note,
  });

  res.status(201).json({
    success: true,
    message: 'Media added successfully',
    data: { media },
  });
});

// @desc    Get order media
// @route   GET /api/v1/orders/:id/media
// @access  Private
exports.getOrderMedia = asyncHandler(async (req, res, next) => {
  const order = await Order.findById(req.params.id);

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  if (req.user.role === 'customer' && order.customer.toString() !== req.user.id) {
    return next(new AppError('Not authorized', 403));
  }

  const media = await OrderMedia.find({ orderId: order._id }).sort('-createdAt');

  res.status(200).json({
    success: true,
    message: 'Order media fetched successfully',
    data: { media },
  });
});
