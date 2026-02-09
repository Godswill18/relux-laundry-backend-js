const Order = require('../models/Order.js');
const User = require('../models/User.js');
const asyncHandler = require('../utils/asyncHandler.js');

// @desc    Get dashboard stats
// @route   GET /api/v1/admin/dashboard
// @access  Private (Admin/Manager)
exports.getDashboardStats = asyncHandler(async (req, res, next) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - today.getDay());

  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  // Today's stats
  const todayOrders = await Order.countDocuments({
    createdAt: { $gte: today },
  });

  const todayRevenue = await Order.aggregate([
    { $match: { createdAt: { $gte: today }, 'payment.status': 'paid' } },
    { $group: { _id: null, total: { $sum: '$pricing.total' } } },
  ]);

  const todayPending = await Order.countDocuments({
    createdAt: { $gte: today },
    status: 'pending',
  });

  const todayCompleted = await Order.countDocuments({
    createdAt: { $gte: today },
    status: 'completed',
  });

  // Weekly stats
  const weeklyOrders = await Order.countDocuments({
    createdAt: { $gte: startOfWeek },
  });

  const weeklyRevenue = await Order.aggregate([
    { $match: { createdAt: { $gte: startOfWeek }, 'payment.status': 'paid' } },
    { $group: { _id: null, total: { $sum: '$pricing.total' } } },
  ]);

  // Monthly stats
  const monthlyOrders = await Order.countDocuments({
    createdAt: { $gte: startOfMonth },
  });

  const monthlyRevenue = await Order.aggregate([
    { $match: { createdAt: { $gte: startOfMonth }, 'payment.status': 'paid' } },
    { $group: { _id: null, total: { $sum: '$pricing.total' } } },
  ]);

  // Recent orders
  const recentOrders = await Order.find()
    .populate('customer', 'name phone')
    .sort('-createdAt')
    .limit(5);

  // Top services
  const topServices = await Order.aggregate([
    { $group: { _id: '$serviceType', count: { $sum: 1 }, revenue: { $sum: '$pricing.total' } } },
    { $sort: { count: -1 } },
    { $limit: 5 },
  ]);

  // Customer count
  const totalCustomers = await User.countDocuments({ role: 'customer' });
  const activeStaff = await User.countDocuments({ role: 'staff', isActive: true });

  res.status(200).json({
    success: true,
    message: 'Dashboard stats fetched successfully',
    data: {
      today: {
        orders: todayOrders,
        revenue: todayRevenue[0]?.total || 0,
        pending: todayPending,
        completed: todayCompleted,
      },
      weekly: {
        orders: weeklyOrders,
        revenue: weeklyRevenue[0]?.total || 0,
      },
      monthly: {
        orders: monthlyOrders,
        revenue: monthlyRevenue[0]?.total || 0,
      },
      totalCustomers,
      activeStaff,
      recentOrders,
      topServices,
    },
  });
});

// @desc    Get revenue report
// @route   GET /api/v1/admin/reports/revenue
// @access  Private (Admin/Manager)
exports.getRevenueReport = asyncHandler(async (req, res, next) => {
  const { startDate, endDate, groupBy = 'day' } = req.query;

  const match = {
    'payment.status': 'paid',
  };

  if (startDate) {
    match.createdAt = { $gte: new Date(startDate) };
  }

  if (endDate) {
    match.createdAt = { ...match.createdAt, $lte: new Date(endDate) };
  }

  let groupByFormat;
  switch (groupBy) {
    case 'day':
      groupByFormat = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } };
      break;
    case 'week':
      groupByFormat = { $week: '$createdAt' };
      break;
    case 'month':
      groupByFormat = { $dateToString: { format: '%Y-%m', date: '$createdAt' } };
      break;
    case 'year':
      groupByFormat = { $year: '$createdAt' };
      break;
    default:
      groupByFormat = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } };
  }

  const revenue = await Order.aggregate([
    { $match: match },
    {
      $group: {
        _id: groupByFormat,
        totalRevenue: { $sum: '$pricing.total' },
        orderCount: { $sum: 1 },
        avgOrderValue: { $avg: '$pricing.total' },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  res.status(200).json({
    success: true,
    message: 'Revenue report fetched successfully',
    data: { revenue },
  });
});

// @desc    Get order statistics
// @route   GET /api/v1/admin/stats/orders
// @access  Private (Admin/Manager)
exports.getOrderStats = asyncHandler(async (req, res, next) => {
  // Orders by status
  const ordersByStatus = await Order.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  // Orders by service type
  const ordersByService = await Order.aggregate([
    { $group: { _id: '$serviceType', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  // Orders by order type
  const ordersByType = await Order.aggregate([
    { $group: { _id: '$orderType', count: { $sum: 1 } } },
  ]);

  // Payment methods
  const paymentMethods = await Order.aggregate([
    { $group: { _id: '$payment.method', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  res.status(200).json({
    success: true,
    message: 'Order statistics fetched successfully',
    data: {
      ordersByStatus,
      ordersByService,
      ordersByType,
      paymentMethods,
    },
  });
});
