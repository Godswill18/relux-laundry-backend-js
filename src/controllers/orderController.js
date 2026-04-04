const Order = require('../models/Order.js');
const OrderItem = require('../models/OrderItem.js');
const OrderMedia = require('../models/OrderMedia.js');
const Customer = require('../models/Customer.js');
const Wallet = require('../models/Wallet.js');
const WalletTransaction = require('../models/WalletTransaction.js');
const Referral = require('../models/Referral.js');
const ReferralSetting = require('../models/ReferralSetting.js');
const User = require('../models/User.js');
const ServiceCategory = require('../models/ServiceCategory.js');
const LoyaltyTier = require('../models/LoyaltyTier.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');
const ERROR_CODES = require('../utils/errorCodes.js');
const { calculateOrderPricing, generateQRCode } = require('../utils/helpers.js');

// Care-type multipliers — single source of truth on the backend
const CARE_TYPE_MULTIPLIERS = {
  'wash-fold': 1,
  'wash-only': 1,
  'iron-only': 0.6,
  'wash-iron': 1.5,
};

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
    deliveryDate,
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
    fragrance,
    pickupFee: bodyPickupFee,
    discount: bodyDiscount,
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

  // Recompute unitPrice from DB for every item — never trust frontend price
  let pricedItems = items || [];
  if (pricedItems.length > 0) {
    pricedItems = await Promise.all(
      pricedItems.map(async (item) => {
        if (!item.categoryId) return item; // walk-in items without a category pass through
        const category = await ServiceCategory.findById(item.categoryId).select('basePrice').lean();
        if (!category) return item; // unknown category — leave as-is
        const multiplier = CARE_TYPE_MULTIPLIERS[item.serviceType] ?? 1;
        const unitPrice = Math.round(category.basePrice * multiplier);
        return { ...item, unitPrice, total: unitPrice * (item.quantity || 1) };
      })
    );
  }

  // Service-level surcharge: EXPRESS = +50% of subtotal, PREMIUM = +100%
  const SERVICE_LEVEL_MULTIPLIERS = { standard: 1, express: 1.5, premium: 2 };
  const slMultiplier = SERVICE_LEVEL_MULTIPLIERS[(serviceLevel || 'standard').toLowerCase()] || 1;
  const baseSubtotal = pricedItems.reduce((acc, item) => acc + (item.unitPrice || 0) * (item.quantity || 1), 0);
  const serviceFee = Math.round(baseSubtotal * (slMultiplier - 1) * 100) / 100;

  // Add-ons fee: stain removal ₦300, fragrance ₦200
  const addOnsFee = (stainRemoval ? 300 : 0) + (fragrance ? 200 : 0);

  // pickupFee: frontend passes it at top-level or inside pricing object
  const resolvedPickupFee = bodyPickupFee || (pricing && pricing.pickupFee) || 0;
  const resolvedDeliveryFee = req.body.deliveryFee || (pricing && pricing.deliveryFee) || 0;
  // discount: promo + points reductions passed by frontend
  const resolvedDiscount = bodyDiscount != null ? bodyDiscount : (pricing && pricing.discount) || 0;

  // Always recalculate pricing from DB-verified item prices — ignore frontend total
  const orderPricing = calculateOrderPricing(
    pricedItems,
    resolvedPickupFee,
    resolvedDeliveryFee,
    resolvedDiscount,
    serviceFee,
    addOnsFee
  );

  // Create order
  const order = await Order.create({
    customer: orderCustomerId,
    customerId: orderCustomerRefId || undefined,
    orderSource: isOffline ? 'offline' : 'online',
    walkInCustomer: isOffline ? walkInCustomer : undefined,
    createdByStaff: isStaffRole ? req.user.id : undefined,
    createdByRole: req.user.role,
    serviceType,
    orderType: orderType || (isOffline ? 'walk-in' : undefined),
    items: pricedItems,
    pickupAddress: pickupAddress || undefined,
    deliveryAddress: deliveryAddress || undefined,
    // PICKUP: store pickup date; DELIVERY: store delivery date; DROP_OFF: no schedule
    pickupDate: pickupMethod && pickupMethod.toLowerCase() === 'pickup' ? pickupDate : undefined,
    deliveryDate: pickupMethod && pickupMethod.toLowerCase() === 'delivery' ? (deliveryDate || pickupDate) : undefined,
    scheduledPickupTime: pickupMethod && pickupMethod.toLowerCase() !== 'drop_off' ? scheduledPickupTime : undefined,
    specialInstructions,
    serviceLevel: serviceLevel || 'standard',
    pickupMethod: pickupMethod || undefined,
    rush: rush || false,
    stainRemoval: stainRemoval || false,
    fragrance: fragrance || false,
    // Staff-created walk-in orders → auto-assigned + skip pending (go straight to confirmed)
    // Admin/manager-created and online orders → unassigned pending pool for staff to pick
    assignedStaff: (req.user.role === 'staff' && isOffline)
      ? req.user.id
      : (assignedStaff || undefined),
    status: (req.user.role === 'staff' && isOffline) ? 'confirmed' : 'pending',
    pricing: orderPricing,
    total: orderPricing.total,
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
    } else if (req.query.statusTab) {
      // --- 11-status workflow tab (Admin & Staff pages) ---
      const st = req.query.statusTab;
      const isAdminRole = ['admin', 'manager', 'receptionist'].includes(req.user.role);

      if (st === 'pending') {
        query.status = 'pending';
        if (!isAdminRole) {
          // Staff see only the pickable pool: unassigned orders created by admin/manager OR online orders
          // Staff-created orders are auto-assigned at creation so they never land here,
          // but createdByRole filter ensures correctness even for edge cases
          query.assignedStaff = { $exists: false };
          query.$or = [
            { orderSource: 'online' },                                             // customer / app orders
            { createdByRole: { $in: ['admin', 'manager', 'receptionist'] } },      // admin-created walk-ins
          ];
        }
      } else {
        query.status = st;
        // Staff only see orders assigned to them — covers orders they created,
        // orders they picked, and orders admin assigned to them
        if (!isAdminRole) {
          query.assignedStaff = req.user.id;
        }
      }
    } else {
      // Manual filters
      if (req.query.excludeCompleted === 'true') {
        query.status = { $nin: ['delivered', 'completed', 'cancelled'] };
      } else if (req.query.doneOnly === 'true') {
        query.status = { $in: ['delivered', 'completed'] };
      } else if (req.query.status) {
        query.status = req.query.status;
      }
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
    .populate('statusHistory.updatedBy', 'name')
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

// @desc    Get staff-specific tab counts per status (11-workflow)
// @route   GET /api/v1/orders/staff-counts
// @access  Private (staff, admin, manager)
exports.getStaffCounts = asyncHandler(async (req, res) => {
  const staffId = req.user.id;

  const STATUSES = [
    'pending', 'confirmed', 'picked-up', 'in_progress',
    'washing', 'ironing', 'ready', 'out-for-delivery',
    'delivered', 'completed', 'cancelled',
  ];

  const results = await Promise.all(
    STATUSES.map((s) => {
      if (s === 'pending') {
        // Pending badge = pickable pool: unassigned admin/manager/online orders
        return Order.countDocuments({
          status: 'pending',
          assignedStaff: { $exists: false },
          $or: [
            { orderSource: 'online' },
            { createdByRole: { $in: ['admin', 'manager', 'receptionist'] } },
          ],
        });
      }
      // Count orders strictly by assignedStaff — covers staff-created (auto-assigned),
      // picked orders, and admin-assigned orders
      return Order.countDocuments({ status: s, assignedStaff: staffId });
    })
  );

  const byStatus = Object.fromEntries(STATUSES.map((s, i) => [s, results[i]]));

  res.status(200).json({
    success: true,
    data: byStatus,
  });
});

// @desc    Get order counts per status (admin view — all orders, no staff filter)
// @route   GET /api/v1/orders/counts
// @access  Private (staff, admin, manager)
exports.getOrderCounts = asyncHandler(async (req, res) => {
  const STATUSES = [
    'pending', 'confirmed', 'picked-up', 'in_progress',
    'washing', 'ironing', 'ready', 'out-for-delivery',
    'delivered', 'completed', 'cancelled',
  ];

  const results = await Promise.all(
    STATUSES.map((s) => Order.countDocuments({ status: s }))
  );

  const byStatus = Object.fromEntries(STATUSES.map((s, i) => [s, results[i]]));

  // Convenience totals
  const total      = results.reduce((a, b) => a + b, 0);
  const active     = STATUSES
    .filter((s) => !['delivered', 'completed', 'cancelled'].includes(s))
    .reduce((sum, s) => sum + byStatus[s], 0);

  res.status(200).json({
    success: true,
    data: { ...byStatus, total, active },
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
    .populate('statusHistory.updatedBy', 'name role')
    .populate('deliveryZoneId', 'name fee rushFee radiusKm')
    .populate('pickupWindowId', 'startTime endTime dayOfWeek baseFee');

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

// @desc    Update order details (non-status fields)
// @route   PUT /api/v1/orders/:id
// @access  Private (Staff/Admin/Manager)
exports.updateOrder = asyncHandler(async (req, res, next) => {
  const order = await Order.findById(req.params.id);

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  // Customers cannot edit orders
  if (req.user.role === 'customer') {
    return next(new AppError('Not authorized to edit orders', 403));
  }

  // Only allow editing orders that are not yet completed/cancelled
  if (['completed', 'delivered', 'cancelled'].includes(order.status)) {
    return next(new AppError('Cannot edit a completed, delivered, or cancelled order', 400));
  }

  const allowedFields = [
    'serviceType',
    'orderType',
    'items',
    'pickupAddress',
    'deliveryAddress',
    'pickupDate',
    'deliveryDate',
    'scheduledPickupTime',
    'specialInstructions',
    'serviceLevel',
    'pickupMethod',
    'rush',
    'stainRemoval',
    'pricing',
    'notes',
    'walkInCustomer',
    'assignedStaff',
    'paymentStatus',
  ];

  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) {
      order[field] = req.body[field];
    }
  });

  // Recalculate total from pricing if pricing was updated
  if (req.body.pricing && req.body.pricing.total !== undefined) {
    order.total = req.body.pricing.total;
  }

  order.lastUpdatedById = req.user.id;
  await order.save();

  await order.populate('customer', 'name phone email');
  await order.populate('assignedStaff', 'name phone staffRole');

  const io = req.app.get('io');
  if (io) {
    io.to(`order-${order._id}`).emit('order:updated', { orderId: order._id });
  }

  res.status(200).json({
    success: true,
    message: 'Order updated successfully',
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

// @desc    Look up order by QR code (no status change — preview before confirming)
// @route   POST /api/v1/orders/lookup-by-qr
// @access  Private (Staff/Admin/Manager)
exports.lookupByQR = asyncHandler(async (req, res, next) => {
  const { qrCode } = req.body;

  if (!qrCode) {
    return next(new AppError('QR code is required', 400));
  }

  const order = await Order.findOne({ qrCode })
    .populate('customer', 'name phone email')
    .populate('assignedStaff', 'name')
    .populate('statusHistory.updatedBy', 'name');

  if (!order) {
    return next(new AppError('Invalid or unrecognized QR code', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Order found',
    data: { order },
  });
});

// @desc    Scan QR code to confirm delivery
// @route   POST /api/v1/orders/scan-delivery
// @access  Private (Staff/Admin/Manager)
exports.scanDelivery = asyncHandler(async (req, res, next) => {
  const { qrCode } = req.body;

  if (!qrCode) {
    return next(new AppError('QR code is required', 400));
  }

  const order = await Order.findOne({ qrCode })
    .populate('customer', 'name phone email')
    .populate('assignedStaff', 'name');

  if (!order) {
    return next(new AppError('Invalid or unrecognized QR code', 404));
  }

  if (['delivered', 'completed'].includes(order.status)) {
    return next(new AppError('This order has already been delivered', 400));
  }

  if (order.status === 'cancelled') {
    return next(new AppError('This order has been cancelled and cannot be delivered', 400));
  }

  order.status = 'delivered';
  order.actualDeliveryDate = new Date();
  order.statusHistory.push({
    status: 'delivered',
    updatedBy: req.user.id,
    notes: 'Delivery confirmed via barcode scan',
    timestamp: new Date(),
  });

  await order.save();

  const io = req.app.get('io');
  if (io) {
    io.to(`order-${order._id}`).emit('order-status-updated', {
      orderId: order._id,
      status: 'delivered',
    });
    io.emit('order:status-updated', { orderId: order._id, status: 'delivered' });
  }

  res.status(200).json({
    success: true,
    message: 'Order delivered successfully',
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

  // Only admin/manager-created and online (customer) orders are pickable
  // Staff-created orders are auto-assigned at creation
  if (order.createdByRole === 'staff') {
    return next(new AppError('Walk-in orders created by staff are automatically assigned and cannot be picked', 400));
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

// @desc    Get customer order stats (total orders, total spent) + tier progress from DB tiers
// @route   GET /api/v1/orders/my-stats
// @access  Private (Customer)
exports.getMyStats = asyncHandler(async (req, res, next) => {
  const userId = req.user.id;
  if (!userId) {
    return next(new AppError('Not authorized', 403));
  }

  const mongoose = require('mongoose');

  // Aggregate total orders and total spent for this customer
  const [agg] = await Order.aggregate([
    { $match: { customer: new mongoose.Types.ObjectId(userId), status: { $ne: 'CANCELLED' } } },
    {
      $group: {
        _id: null,
        totalOrders: { $sum: 1 },
        totalSpent: { $sum: '$total' },
      },
    },
  ]);

  const totalOrders = agg?.totalOrders || 0;
  const totalSpent = agg?.totalSpent || 0;

  // Load all active tiers sorted by minSpend ascending
  const tiers = await LoyaltyTier.find({ active: true }).sort({ minSpend: 1 });

  // Determine current tier and next tier based on totalSpent
  let currentTier = null;
  let nextTier = null;

  for (let i = 0; i < tiers.length; i++) {
    if (totalSpent >= tiers[i].minSpend) {
      currentTier = tiers[i];
      nextTier = tiers[i + 1] || null;
    }
  }

  // If no tier matched (spending below first tier), use first tier as next
  if (!currentTier && tiers.length > 0) {
    nextTier = tiers[0];
  }

  res.status(200).json({
    success: true,
    message: 'Stats fetched successfully',
    data: {
      totalOrders,
      totalSpent,
      currentTier: currentTier
        ? { name: currentTier.name, minSpend: currentTier.minSpend, rank: currentTier.rank }
        : null,
      nextTier: nextTier
        ? { name: nextTier.name, minSpend: nextTier.minSpend, rank: nextTier.rank }
        : null,
      tiers: tiers.map((t) => ({ name: t.name, minSpend: t.minSpend, rank: t.rank })),
    },
  });
});
