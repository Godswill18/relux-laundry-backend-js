const SubscriptionPlan = require('../models/SubscriptionPlan.js');
const Subscription = require('../models/Subscription.js');
const SubscriptionUsage = require('../models/SubscriptionUsage.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');

// @desc    Get all subscription plans
// @route   GET /api/v1/subscriptions/plans
// @access  Private
exports.getPlans = asyncHandler(async (req, res, next) => {
  let query = {};
  if (req.query.active !== undefined) query.active = req.query.active === 'true';

  const plans = await SubscriptionPlan.find(query).sort('price');

  res.status(200).json({
    success: true,
    message: 'Subscription plans fetched successfully',
    data: { plans },
  });
});

// @desc    Get single plan
// @route   GET /api/v1/subscriptions/plans/:id
// @access  Private
exports.getPlan = asyncHandler(async (req, res, next) => {
  const plan = await SubscriptionPlan.findById(req.params.id);

  if (!plan) {
    return next(new AppError('Plan not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Plan fetched successfully',
    data: { plan },
  });
});

// @desc    Create plan
// @route   POST /api/v1/subscriptions/plans
// @access  Private (Admin)
exports.createPlan = asyncHandler(async (req, res, next) => {
  const { name, description, price, durationDays, itemLimit } = req.body;

  const plan = await SubscriptionPlan.create({
    name,
    description,
    price,
    durationDays,
    itemLimit,
  });

  res.status(201).json({
    success: true,
    message: 'Plan created successfully',
    data: { plan },
  });
});

// @desc    Update plan
// @route   PUT /api/v1/subscriptions/plans/:id
// @access  Private (Admin)
exports.updatePlan = asyncHandler(async (req, res, next) => {
  const fieldsToUpdate = {
    name: req.body.name,
    description: req.body.description,
    price: req.body.price,
    durationDays: req.body.durationDays,
    itemLimit: req.body.itemLimit,
    active: req.body.active,
  };

  Object.keys(fieldsToUpdate).forEach(
    (key) => fieldsToUpdate[key] === undefined && delete fieldsToUpdate[key]
  );

  const plan = await SubscriptionPlan.findByIdAndUpdate(req.params.id, fieldsToUpdate, {
    new: true,
    runValidators: true,
  });

  if (!plan) {
    return next(new AppError('Plan not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Plan updated successfully',
    data: { plan },
  });
});

// @desc    Delete plan
// @route   DELETE /api/v1/subscriptions/plans/:id
// @access  Private (Admin)
exports.deletePlan = asyncHandler(async (req, res, next) => {
  const plan = await SubscriptionPlan.findById(req.params.id);

  if (!plan) {
    return next(new AppError('Plan not found', 404));
  }

  await plan.deleteOne();

  res.status(200).json({
    success: true,
    message: 'Plan deleted successfully',
    data: {},
  });
});

// @desc    Get my subscription
// @route   GET /api/v1/subscriptions/me
// @access  Private
exports.getMySubscription = asyncHandler(async (req, res, next) => {
  const subscription = await Subscription.findOne({
    customerId: req.user.customerId,
    status: { $in: ['active', 'paused', 'past_due'] },
  }).populate('planId');

  res.status(200).json({
    success: true,
    message: 'Subscription fetched successfully',
    data: { subscription },
  });
});

// @desc    Subscribe to a plan
// @route   POST /api/v1/subscriptions
// @access  Private
exports.subscribe = asyncHandler(async (req, res, next) => {
  const { planId } = req.body;

  const plan = await SubscriptionPlan.findById(planId);
  if (!plan || !plan.active) {
    return next(new AppError('Plan not found or inactive', 404));
  }

  // Check for existing active subscription
  const existing = await Subscription.findOne({
    customerId: req.user.customerId,
    status: { $in: ['active', 'paused'] },
  });

  if (existing) {
    return next(new AppError('You already have an active subscription', 400));
  }

  const periodStart = new Date();
  const periodEnd = new Date();
  periodEnd.setDate(periodEnd.getDate() + plan.durationDays);

  const subscription = await Subscription.create({
    customerId: req.user.customerId,
    planName: plan.name,
    planId: plan._id,
    periodStart,
    periodEnd,
    nextBilling: periodEnd,
  });

  // Create initial usage record
  await SubscriptionUsage.create({
    subscriptionId: subscription._id,
    periodStart,
    periodEnd,
    usedQuantity: 0,
  });

  res.status(201).json({
    success: true,
    message: 'Subscribed successfully',
    data: { subscription },
  });
});

// @desc    Cancel subscription
// @route   PUT /api/v1/subscriptions/:id/cancel
// @access  Private
exports.cancelSubscription = asyncHandler(async (req, res, next) => {
  const subscription = await Subscription.findById(req.params.id);

  if (!subscription) {
    return next(new AppError('Subscription not found', 404));
  }

  if (req.user.role === 'customer' && subscription.customerId.toString() !== req.user.customerId) {
    return next(new AppError('Not authorized', 403));
  }

  subscription.status = 'cancelled';
  subscription.autoRenew = false;
  await subscription.save();

  res.status(200).json({
    success: true,
    message: 'Subscription cancelled successfully',
    data: { subscription },
  });
});

// @desc    Pause subscription
// @route   PUT /api/v1/subscriptions/:id/pause
// @access  Private
exports.pauseSubscription = asyncHandler(async (req, res, next) => {
  const subscription = await Subscription.findById(req.params.id);

  if (!subscription) {
    return next(new AppError('Subscription not found', 404));
  }

  if (subscription.status !== 'active') {
    return next(new AppError('Only active subscriptions can be paused', 400));
  }

  subscription.status = 'paused';
  await subscription.save();

  res.status(200).json({
    success: true,
    message: 'Subscription paused successfully',
    data: { subscription },
  });
});

// @desc    Resume subscription
// @route   PUT /api/v1/subscriptions/:id/resume
// @access  Private
exports.resumeSubscription = asyncHandler(async (req, res, next) => {
  const subscription = await Subscription.findById(req.params.id);

  if (!subscription) {
    return next(new AppError('Subscription not found', 404));
  }

  if (subscription.status !== 'paused') {
    return next(new AppError('Only paused subscriptions can be resumed', 400));
  }

  subscription.status = 'active';
  await subscription.save();

  res.status(200).json({
    success: true,
    message: 'Subscription resumed successfully',
    data: { subscription },
  });
});

// @desc    Get all subscriptions (admin)
// @route   GET /api/v1/subscriptions
// @access  Private (Admin/Manager)
exports.getSubscriptions = asyncHandler(async (req, res, next) => {
  let query = {};
  if (req.query.status) query.status = req.query.status;
  if (req.query.customerId) query.customerId = req.query.customerId;

  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 10;
  const startIndex = (page - 1) * limit;

  const total = await Subscription.countDocuments(query);

  const subscriptions = await Subscription.find(query)
    .populate('customerId', 'name phone')
    .populate('planId', 'name price')
    .sort('-createdAt')
    .skip(startIndex)
    .limit(limit);

  res.status(200).json({
    success: true,
    message: 'Subscriptions fetched successfully',
    data: { subscriptions },
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

// @desc    Get subscription usage
// @route   GET /api/v1/subscriptions/:id/usage
// @access  Private
exports.getUsage = asyncHandler(async (req, res, next) => {
  const subscription = await Subscription.findById(req.params.id);

  if (!subscription) {
    return next(new AppError('Subscription not found', 404));
  }

  const usage = await SubscriptionUsage.find({ subscriptionId: req.params.id })
    .sort('-periodStart');

  res.status(200).json({
    success: true,
    message: 'Usage fetched successfully',
    data: { usage },
  });
});
