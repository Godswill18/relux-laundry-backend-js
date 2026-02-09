const ChatThread = require('../models/ChatThread.js');
const ChatMessage = require('../models/ChatMessage.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');

// @desc    Get chat threads
// @route   GET /api/v1/chats
// @access  Private
exports.getThreads = asyncHandler(async (req, res, next) => {
  let query = {};

  if (req.user.role === 'customer') {
    query.customerId = req.user.customerId;
  }

  if (req.query.status) query.status = req.query.status;
  if (req.query.customerId && req.user.role !== 'customer') {
    query.customerId = req.query.customerId;
  }

  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 10;
  const startIndex = (page - 1) * limit;

  const total = await ChatThread.countDocuments(query);

  const threads = await ChatThread.find(query)
    .populate('customerId', 'name phone')
    .populate('orderId', 'orderNumber status')
    .sort('-updatedAt')
    .skip(startIndex)
    .limit(limit);

  res.status(200).json({
    success: true,
    message: 'Chat threads fetched successfully',
    data: { threads },
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

// @desc    Get single chat thread
// @route   GET /api/v1/chats/:id
// @access  Private
exports.getThread = asyncHandler(async (req, res, next) => {
  const thread = await ChatThread.findById(req.params.id)
    .populate('customerId', 'name phone')
    .populate('orderId', 'orderNumber status');

  if (!thread) {
    return next(new AppError('Chat thread not found', 404));
  }

  if (req.user.role === 'customer' && thread.customerId._id.toString() !== req.user.customerId) {
    return next(new AppError('Not authorized', 403));
  }

  res.status(200).json({
    success: true,
    message: 'Chat thread fetched successfully',
    data: { thread },
  });
});

// @desc    Create chat thread
// @route   POST /api/v1/chats
// @access  Private
exports.createThread = asyncHandler(async (req, res, next) => {
  const { orderId, subject } = req.body;
  const isCustomer = req.user.role === 'customer';

  const thread = await ChatThread.create({
    orderId,
    customerId: isCustomer ? req.user.customerId : req.body.customerId,
    subject,
    createdBy: isCustomer ? 'customer' : 'staff',
  });

  res.status(201).json({
    success: true,
    message: 'Chat thread created successfully',
    data: { thread },
  });
});

// @desc    Close chat thread
// @route   PUT /api/v1/chats/:id/close
// @access  Private
exports.closeThread = asyncHandler(async (req, res, next) => {
  const thread = await ChatThread.findByIdAndUpdate(
    req.params.id,
    { status: 'closed' },
    { new: true }
  );

  if (!thread) {
    return next(new AppError('Chat thread not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Chat thread closed successfully',
    data: { thread },
  });
});

// @desc    Get messages for a thread
// @route   GET /api/v1/chats/:id/messages
// @access  Private
exports.getMessages = asyncHandler(async (req, res, next) => {
  const thread = await ChatThread.findById(req.params.id);

  if (!thread) {
    return next(new AppError('Chat thread not found', 404));
  }

  if (req.user.role === 'customer' && thread.customerId.toString() !== req.user.customerId) {
    return next(new AppError('Not authorized', 403));
  }

  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 50;
  const startIndex = (page - 1) * limit;

  const total = await ChatMessage.countDocuments({ threadId: req.params.id });

  const messages = await ChatMessage.find({ threadId: req.params.id })
    .populate('senderCustomerId', 'name')
    .populate('senderUserId', 'name role')
    .sort('createdAt')
    .skip(startIndex)
    .limit(limit);

  res.status(200).json({
    success: true,
    message: 'Messages fetched successfully',
    data: { messages },
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

// @desc    Send message in a thread
// @route   POST /api/v1/chats/:id/messages
// @access  Private
exports.sendMessage = asyncHandler(async (req, res, next) => {
  const thread = await ChatThread.findById(req.params.id);

  if (!thread) {
    return next(new AppError('Chat thread not found', 404));
  }

  if (thread.status === 'closed') {
    return next(new AppError('Cannot send message to a closed thread', 400));
  }

  const isCustomer = req.user.role === 'customer';

  const message = await ChatMessage.create({
    threadId: thread._id,
    senderType: isCustomer ? 'customer' : 'staff',
    senderCustomerId: isCustomer ? req.user.customerId : undefined,
    senderUserId: !isCustomer ? req.user.id : undefined,
    body: req.body.body,
  });

  // Update thread updatedAt
  thread.updatedAt = new Date();
  await thread.save();

  // Emit socket event for real-time chat
  const io = req.app.get('io');
  if (io) {
    io.to(`chat-${thread._id}`).emit('chat-message', {
      threadId: thread._id,
      message,
    });
  }

  res.status(201).json({
    success: true,
    message: 'Message sent successfully',
    data: { message },
  });
});
