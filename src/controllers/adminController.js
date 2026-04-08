const Order = require('../models/Order.js');
const User = require('../models/User.js');
const PayrollPeriod = require('../models/PayrollPeriod.js');
const PayrollEntry = require('../models/PayrollEntry.js');
const WorkShift = require('../models/WorkShift.js');
const Attendance = require('../models/Attendance.js');
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

// @desc    Get payroll statistics
// @route   GET /api/v1/admin/stats/payroll
// @access  Private (Admin/Manager)
exports.getPayrollStats = asyncHandler(async (req, res, next) => {
  // Monthly payroll totals for the last 6 months
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  const monthlyPayroll = await PayrollPeriod.aggregate([
    { $match: { startDate: { $gte: sixMonthsAgo } } },
    {
      $lookup: {
        from: 'payrollentries',
        localField: '_id',
        foreignField: 'periodId',
        as: 'entries',
      },
    },
    {
      $project: {
        month: { $dateToString: { format: '%Y-%m', date: '$startDate' } },
        status: 1,
        totalPay: { $sum: '$entries.totalPay' },
        staffCount: { $size: '$entries' },
      },
    },
    { $sort: { month: 1 } },
  ]);

  // Overall totals
  const totals = await PayrollEntry.aggregate([
    {
      $group: {
        _id: null,
        totalPaid: { $sum: '$totalPay' },
        totalBonuses: { $sum: '$bonuses' },
        totalDeductions: { $sum: '$deductions' },
        avgPay: { $avg: '$totalPay' },
      },
    },
  ]);

  const periodsByStatus = await PayrollPeriod.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  res.status(200).json({
    success: true,
    message: 'Payroll stats fetched successfully',
    data: {
      monthlyPayroll,
      totals: totals[0] || { totalPaid: 0, totalBonuses: 0, totalDeductions: 0, avgPay: 0 },
      periodsByStatus,
    },
  });
});

// @desc    Get staff productivity stats
// @route   GET /api/v1/admin/stats/staff-productivity
// @access  Private (Admin/Manager)
exports.getStaffProductivity = asyncHandler(async (req, res, next) => {
  // Optional date range
  const dateFilter = {};
  if (req.query.startDate) dateFilter.$gte = new Date(req.query.startDate);
  if (req.query.endDate) {
    const end = new Date(req.query.endDate);
    end.setHours(23, 59, 59, 999);
    dateFilter.$lte = end;
  }
  const hasDate = Object.keys(dateFilter).length > 0;
  const orderDateMatch = hasDate ? { createdAt: dateFilter } : {};

  // 1. Orders assigned to each staff member
  const assignedOrdersPipeline = [
    { $match: { assignedStaff: { $ne: null }, ...orderDateMatch } },
    {
      $group: {
        _id: '$assignedStaff',
        orderCount: { $sum: 1 },
        totalRevenue: { $sum: '$pricing.total' },
        completedOrders: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        inProgressOrders: {
          $sum: {
            $cond: [
              { $in: ['$status', ['washing', 'drying', 'ironing', 'folding', 'processing', 'ready']] },
              1,
              0,
            ],
          },
        },
        cancelledOrders: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
      },
    },
  ];

  // 2. Status updates performed by staff (from statusHistory)
  const statusUpdatesPipeline = [
    { $match: { 'statusHistory.0': { $exists: true }, ...orderDateMatch } },
    { $unwind: '$statusHistory' },
    ...(hasDate ? [{ $match: { 'statusHistory.timestamp': dateFilter } }] : []),
    { $match: { 'statusHistory.updatedBy': { $ne: null } } },
    { $group: { _id: '$statusHistory.updatedBy', statusUpdates: { $sum: 1 } } },
  ];

  // 3. Walk-in orders created by staff at the counter
  const walkinPipeline = [
    { $match: { createdByStaff: { $ne: null }, ...orderDateMatch } },
    { $group: { _id: '$createdByStaff', walkinOrders: { $sum: 1 } } },
  ];

  // 4. Shifts worked (completed or scheduled)
  const shiftMatch = {};
  if (hasDate) {
    if (req.query.startDate) shiftMatch.endDate = { $gte: req.query.startDate };
    if (req.query.endDate) shiftMatch.startDate = { $lte: req.query.endDate };
  }
  const shiftsPipeline = [
    { $match: { status: { $in: ['completed', 'scheduled'] }, ...shiftMatch } },
    { $group: { _id: '$userId', shiftsWorked: { $sum: 1 } } },
  ];

  // 5. Attendance records
  const attendanceMatch = hasDate ? { clockInAt: dateFilter } : {};
  const attendancePipeline = [
    { $match: attendanceMatch },
    {
      $group: {
        _id: '$userId',
        attendanceCount: { $sum: 1 },
        presentCount: { $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] } },
        lateCount: { $sum: { $cond: [{ $eq: ['$status', 'late'] }, 1, 0] } },
      },
    },
  ];

  // Run all aggregations + user fetch in parallel
  const [assignedOrders, statusUpdates, walkinOrders, shifts, attendance, staffUsers] =
    await Promise.all([
      Order.aggregate(assignedOrdersPipeline),
      Order.aggregate(statusUpdatesPipeline),
      Order.aggregate(walkinPipeline),
      WorkShift.aggregate(shiftsPipeline),
      Attendance.aggregate(attendancePipeline),
      User.find(
        { role: { $in: ['staff', 'manager', 'admin', 'receptionist'] } },
        '_id name role email'
      ).lean(),
    ]);

  // Build lookup maps keyed by user id string
  const toMap = (arr, key = '_id') =>
    Object.fromEntries(arr.map((r) => [r[key].toString(), r]));

  const assignedMap   = toMap(assignedOrders);
  const statusMap     = toMap(statusUpdates);
  const walkinMap     = toMap(walkinOrders);
  const shiftMap      = toMap(shifts);
  const attendanceMap = toMap(attendance);

  // Merge all data per staff member
  const staffOrders = staffUsers.map((user) => {
    const id = user._id.toString();
    const a  = assignedMap[id]   || {};
    const orderCount      = a.orderCount      || 0;
    const completedOrders = a.completedOrders || 0;

    return {
      _id: id,
      name: user.name,
      role: user.role,
      email: user.email,
      orderCount,
      totalRevenue:    a.totalRevenue    || 0,
      completedOrders,
      inProgressOrders: a.inProgressOrders || 0,
      cancelledOrders:  a.cancelledOrders  || 0,
      completionRate:   orderCount > 0 ? Math.round((completedOrders / orderCount) * 100) : 0,
      statusUpdates:    statusMap[id]?.statusUpdates    || 0,
      walkinOrders:     walkinMap[id]?.walkinOrders     || 0,
      shiftsWorked:     shiftMap[id]?.shiftsWorked      || 0,
      attendanceCount:  attendanceMap[id]?.attendanceCount || 0,
      presentCount:     attendanceMap[id]?.presentCount    || 0,
      lateCount:        attendanceMap[id]?.lateCount       || 0,
    };
  });

  // Sort by most active (orders + status updates + walk-ins) descending
  staffOrders.sort(
    (a, b) => (b.orderCount + b.statusUpdates + b.walkinOrders) -
              (a.orderCount + a.statusUpdates + a.walkinOrders)
  );

  res.status(200).json({
    success: true,
    message: 'Staff productivity stats fetched successfully',
    data: { staffOrders },
  });
});
