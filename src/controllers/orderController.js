const Order = require('../models/Order.js');
const OrderItem = require('../models/OrderItem.js');
const OrderMedia = require('../models/OrderMedia.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');
const { calculateOrderPricing, generateQRCode } = require('../utils/helpers.js');

// @desc    Create new order
// @route   POST /api/v1/orders
// @access  Private
exports.createOrder = asyncHandler(async (req, res, next) => {
  const {
    serviceType,
    orderType,
    items,
    pickupAddress,
    deliveryAddress,
    pickupDate,
    scheduledPickupTime,
    specialInstructions,
    pricing,
    paymentMethod,
  } = req.body;

  // Calculate pricing if not provided
  let orderPricing = pricing;
  if (!pricing) {
    orderPricing = calculateOrderPricing(
      items,
      req.body.pickupFee || 500,
      req.body.deliveryFee || 500,
      req.body.discount || 0
    );
  }

  // Create order
  const order = await Order.create({
    customer: req.user.id,
    serviceType,
    orderType,
    items,
    pickupAddress: orderType === 'pickup-delivery' ? pickupAddress : undefined,
    deliveryAddress: orderType === 'pickup-delivery' ? deliveryAddress : undefined,
    pickupDate,
    scheduledPickupTime,
    specialInstructions,
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

  // Emit socket event for real-time update
  const io = req.app.get('io');
  if (io) {
    io.emit('order-created', order);
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
exports.getOrders = asyncHandler(async (req, res, next) => {
  let query;

  // For customers, only show their orders
  if (req.user.role === 'customer') {
    query = { customer: req.user.id };
  } else {
    // For staff/admin, allow filtering
    query = {};
    if (req.query.status) query.status = req.query.status;
    if (req.query.serviceType) query.serviceType = req.query.serviceType;
    if (req.query.customer) query.customer = req.query.customer;
  }

  // Pagination
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 10;
  const startIndex = (page - 1) * limit;

  const total = await Order.countDocuments(query);

  const orders = await Order.find(query)
    .populate('customer', 'name phone email')
    .populate('assignedStaff', 'name phone staffRole')
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
    .populate('customer', 'name phone email addresses')
    .populate('assignedStaff', 'name phone staffRole')
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
