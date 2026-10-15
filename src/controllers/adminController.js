const Order = require('../models/Order.js');
const User = require('../models/User.js');
const PayrollPeriod = require('../models/PayrollPeriod.js');
const PayrollEntry = require('../models/PayrollEntry.js');
const WorkShift = require('../models/WorkShift.js');
const Attendance = require('../models/Attendance.js');
const { customerCounts } = require('../utils/customerQueries.js');
const {
  READY_IMPLIED_STATUSES,
  COLLECTED_IMPLIED_STATUSES,
} = require('../utils/orderFulfilment.js');
const asyncHandler = require('../utils/asyncHandler.js');
const {
  paidOrderMatch,
  revenuePipeline,
  orderRevenueField,
  startOfTodayWAT,
  startOfMonthWAT,
  startOfWeekWAT,
  watDayStart,
  watDayEnd,
  getTodayWAT,
} = require('../utils/helpers.js');

// @desc    Get dashboard stats
// @route   GET /api/v1/admin/dashboard
// @access  Private (Admin/Manager)
exports.getDashboardStats = asyncHandler(async (req, res, next) => {
  // All windows anchored to WAT calendar days, and all revenue aggregates built
  // from paidOrderMatch()/orderRevenueField() so this endpoint and
  // /orders/dashboard-stats can no longer report different numbers.
  const today = startOfTodayWAT();

  // Week starts on Sunday, matching the previous behaviour
  const startOfWeek = startOfWeekWAT();

  const startOfMonth = startOfMonthWAT();
  // Upper bound for every revenue window: the end of today (WAT).
  const endOfTodayExclusive = new Date(watDayEnd(getTodayWAT()).getTime() + 1);

  // Today's stats
  const todayOrders = await Order.countDocuments({
    createdAt: { $gte: today },
  });

  const todayRevenue = await Order.aggregate([
    ...revenuePipeline({ from: today, to: endOfTodayExclusive }),
    { $group: { _id: null, total: { $sum: '$revenueAmount' } } },
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
    ...revenuePipeline({ from: startOfWeek, to: endOfTodayExclusive }),
    { $group: { _id: null, total: { $sum: '$revenueAmount' } } },
  ]);

  // Monthly stats
  const monthlyOrders = await Order.countDocuments({
    createdAt: { $gte: startOfMonth },
  });

  const monthlyRevenue = await Order.aggregate([
    ...revenuePipeline({ from: startOfMonth, to: endOfTodayExclusive }),
    { $group: { _id: null, total: { $sum: '$revenueAmount' } } },
  ]);

  // Recent orders
  const recentOrders = await Order.find()
    .populate('customer', 'name phone')
    .sort('-createdAt')
    .limit(5);

  // Top services
  const topServices = await Order.aggregate([
    { $match: { status: { $nin: ['cancelled'] } } },
    { $group: {
      _id: '$serviceType',
      count: { $sum: 1 },
      // Revenue: paid, non-cancelled orders only
      revenue: { $sum: { $cond: [{ $and: [{ $ne: ['$status', 'cancelled'] }, { $eq: ['$paymentStatus', 'paid'] }] }, orderRevenueField(), 0] } },
    } },
    { $sort: { count: -1 } },
    { $limit: 5 },
  ]);

  // Unique customer records, walk-ins included — not portal logins, which is
  // what this used to count. Same definition as the customer list.
  const customerStats = await customerCounts({ monthStart: startOfMonthWAT() });
  const totalCustomers = customerStats.total;
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
      // Portal adoption breakdown (additive — existing fields unchanged).
      customerBreakdown: {
        portalActive: customerStats.portalActive,
        unregistered: customerStats.unregistered,
        pendingVerification: customerStats.pendingVerification,
        deactivated: customerStats.deactivated,
        notEligible: customerStats.notEligible,
        activationRate: customerStats.activationRate,
      },
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

  // Revenue = paid, non-cancelled orders, bucketed on the payment date
  // (revenueAt), in WAT. Date filters are WAT calendar days.
  const from = startDate ? watDayStart(String(startDate).slice(0, 10)) : undefined;
  const to = endDate ? new Date(watDayEnd(String(endDate).slice(0, 10)).getTime() + 1) : undefined;

  const tz = '+01:00';
  let groupByFormat;
  switch (groupBy) {
    case 'week':
      groupByFormat = { $week: { date: '$revenueAt', timezone: tz } };
      break;
    case 'month':
      groupByFormat = { $dateToString: { format: '%Y-%m', date: '$revenueAt', timezone: tz } };
      break;
    case 'year':
      groupByFormat = { $year: { date: '$revenueAt', timezone: tz } };
      break;
    default:
      groupByFormat = { $dateToString: { format: '%Y-%m-%d', date: '$revenueAt', timezone: tz } };
  }

  const revenue = await Order.aggregate([
    ...revenuePipeline({ from, to }),
    {
      $group: {
        _id: groupByFormat,
        totalRevenue: { $sum: '$revenueAmount' },
        orderCount: { $sum: 1 },
        avgOrderValue: { $avg: '$revenueAmount' },
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

  // Garments (sum of line quantities, never a count of lines) across every
  // order that wasn't cancelled. Orders placed before garment tracking are
  // read from their status: 'ready'-or-later = all ready, delivered/completed =
  // all collected.
  const [garmentRow] = await Order.aggregate([
    { $match: { status: { $ne: 'cancelled' } } },
    {
      $project: {
        total: { $ifNull: ['$totalGarments', { $sum: '$items.quantity' }] },
        tracked: { $eq: ['$itemTracking', true] },
        status: 1,
        readyG: '$readyGarments',
        collectedG: '$collectedGarments',
      },
    },
    {
      $project: {
        total: 1,
        ready: {
          $cond: ['$tracked', { $ifNull: ['$readyG', 0] },
            { $cond: [{ $in: ['$status', READY_IMPLIED_STATUSES] }, '$total', 0] }],
        },
        collected: {
          $cond: ['$tracked', { $ifNull: ['$collectedG', 0] },
            { $cond: [{ $in: ['$status', COLLECTED_IMPLIED_STATUSES] }, '$total', 0] }],
        },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$total' },
        ready: { $sum: '$ready' },
        collected: { $sum: '$collected' },
        partiallyReadyOrders: {
          $sum: { $cond: [{ $and: [{ $gt: ['$ready', 0] }, { $lt: ['$ready', '$total'] }] }, 1, 0] },
        },
        partiallyCollectedOrders: {
          $sum: { $cond: [{ $and: [{ $gt: ['$collected', 0] }, { $lt: ['$collected', '$total'] }] }, 1, 0] },
        },
      },
    },
  ]);
  const g = garmentRow || { total: 0, ready: 0, collected: 0, partiallyReadyOrders: 0, partiallyCollectedOrders: 0 };

  // Garments and line revenue per service — one order can now hold several
  // services, which the order-level serviceType above cannot show.
  const garmentsByService = await Order.aggregate([
    { $match: { status: { $ne: 'cancelled' } } },
    { $unwind: '$items' },
    {
      $group: {
        _id: { $ifNull: ['$items.serviceName', { $ifNull: ['$items.serviceType', 'Unspecified'] }] },
        garments: { $sum: '$items.quantity' },
        lines: { $sum: 1 },
        amount: { $sum: { $add: [{ $ifNull: ['$items.total', 0] }, { $ifNull: ['$items.addonsTotal', 0] }] } },
      },
    },
    { $sort: { garments: -1 } },
  ]);

  res.status(200).json({
    success: true,
    message: 'Order statistics fetched successfully',
    data: {
      ordersByStatus,
      ordersByService,
      ordersByType,
      paymentMethods,
      garments: {
        total: g.total,
        processing: g.total - g.ready,
        readyAwaitingCollection: g.ready - g.collected,
        collected: g.collected,
        outstanding: g.total - g.collected,
        partiallyReadyOrders: g.partiallyReadyOrders,
        partiallyCollectedOrders: g.partiallyCollectedOrders,
      },
      garmentsByService,
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
        // Revenue counts only paid, non-cancelled orders (helpers.paidOrderMatch)
        totalRevenue: {
          $sum: {
            $cond: [
              { $and: [{ $ne: ['$status', 'cancelled'] }, { $eq: ['$paymentStatus', 'paid'] }] },
              orderRevenueField(),
              0,
            ],
          },
        },
        completedOrders: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        inProgressOrders: {
          $sum: {
            $cond: [
              { $in: ['$status', ['confirmed', 'in_progress', 'ready']] },
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
