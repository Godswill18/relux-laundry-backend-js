const Attendance = require('../models/Attendance.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');
const { validateGeofence } = require('../utils/geofenceHelper.js');

// @desc    Clock in
// @route   POST /api/v1/attendance/clock-in
// @access  Private
exports.clockIn = asyncHandler(async (req, res, next) => {
  const { shiftId, source, ipAddress, deviceId, geoLat, geoLng, geoAccuracy } = req.body;

  // ── Geofence validation ───────────────────────────────────────────────────
  const fence = await validateGeofence(
    geoLat != null ? Number(geoLat) : null,
    geoLng != null ? Number(geoLng) : null,
    geoAccuracy != null ? Number(geoAccuracy) : null
  );

  if (!fence.allowed) {
    return next(new AppError(fence.reason, 403, 'GEOFENCE_VIOLATION'));
  }

  // Check if already clocked in without clocking out (ignore auto clock-outs —
  // those are treated as closed so the staff member can clock in again)
  const openAttendance = await Attendance.findOne({
    userId: req.user.id,
    clockOutAt: null,
    autoClockOut: { $ne: true },
  });

  if (openAttendance) {
    return next(new AppError('You are already clocked in. Please clock out first.', 400));
  }

  const attendance = await Attendance.create({
    userId: req.user.id,
    shiftId,
    clockInAt: new Date(),
    source: source || 'app',
    ipAddress,
    deviceId,
    geoLat: geoLat != null ? Number(geoLat) : undefined,
    geoLng: geoLng != null ? Number(geoLng) : undefined,
    geoAccuracy: geoAccuracy != null ? Number(geoAccuracy) : undefined,
    distanceFromLocation: fence.distance ?? undefined,
    geofenceValid: fence.geofenceConfigured ? true : undefined,
  });

  res.status(201).json({
    success: true,
    message: 'Clocked in successfully',
    data: { attendance, distance: fence.distance },
  });
});

// @desc    Clock out
// @route   PUT /api/v1/attendance/clock-out
// @access  Private
exports.clockOut = asyncHandler(async (req, res, next) => {
  const { geoLat, geoLng, geoAccuracy } = req.body;

  // ── Geofence validation ───────────────────────────────────────────────────
  const fence = await validateGeofence(
    geoLat != null ? Number(geoLat) : null,
    geoLng != null ? Number(geoLng) : null,
    geoAccuracy != null ? Number(geoAccuracy) : null
  );

  if (!fence.allowed) {
    return next(new AppError(fence.reason, 403, 'GEOFENCE_VIOLATION'));
  }

  // First try to find a genuinely open attendance record
  let attendance = await Attendance.findOne({
    userId: req.user.id,
    clockOutAt: null,
  }).sort('-clockInAt');

  if (!attendance) {
    // Fallback: check for today's auto-clocked-out record so staff can correct
    // the time after being auto-logged out at shift end
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    attendance = await Attendance.findOne({
      userId: req.user.id,
      autoClockOut: true,
      clockInAt: { $gte: todayStart, $lte: todayEnd },
    }).sort('-clockInAt');
  }

  if (!attendance) {
    return next(new AppError('No active clock-in found', 400));
  }

  attendance.clockOutAt = new Date();
  attendance.autoClockOut = false;
  if (geoLat != null) attendance.geoLat = Number(geoLat);
  if (geoLng != null) attendance.geoLng = Number(geoLng);
  if (geoAccuracy != null) attendance.geoAccuracy = Number(geoAccuracy);
  if (fence.distance != null) attendance.distanceFromLocation = fence.distance;
  if (fence.geofenceConfigured) attendance.geofenceValid = true;
  await attendance.save();

  res.status(200).json({
    success: true,
    message: 'Clocked out successfully',
    data: { attendance, distance: fence.distance },
  });
});

// @desc    Get my attendance
// @route   GET /api/v1/attendance/me
// @access  Private
exports.getMyAttendance = asyncHandler(async (req, res, next) => {
  let query = { userId: req.user.id };

  if (req.query.startDate) {
    query.clockInAt = { $gte: new Date(req.query.startDate) };
  }
  if (req.query.endDate) {
    query.clockInAt = { ...query.clockInAt, $lte: new Date(req.query.endDate) };
  }

  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const startIndex = (page - 1) * limit;

  const total = await Attendance.countDocuments(query);

  const attendance = await Attendance.find(query)
    .populate('shiftId', 'startDate startTime endDate endTime shiftType status isActive')
    .sort('-clockInAt')
    .skip(startIndex)
    .limit(limit);

  res.status(200).json({
    success: true,
    message: 'Attendance fetched successfully',
    data: { attendance },
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

// @desc    Get all attendance
// @route   GET /api/v1/attendance
// @access  Private (Admin/Manager)
exports.getAttendance = asyncHandler(async (req, res, next) => {
  let query = {};

  if (req.query.userId) query.userId = req.query.userId;
  if (req.query.status) query.status = req.query.status;
  if (req.query.startDate) {
    query.clockInAt = { $gte: new Date(req.query.startDate) };
  }
  if (req.query.endDate) {
    query.clockInAt = { ...query.clockInAt, $lte: new Date(req.query.endDate) };
  }

  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const startIndex = (page - 1) * limit;

  const total = await Attendance.countDocuments(query);

  const attendance = await Attendance.find(query)
    .populate('userId', 'name role staffRole')
    .populate('shiftId', 'startDate startTime endDate endTime shiftType status isActive')
    .sort('-clockInAt')
    .skip(startIndex)
    .limit(limit);

  res.status(200).json({
    success: true,
    message: 'Attendance fetched successfully',
    data: { attendance },
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

// @desc    Get attendance by user
// @route   GET /api/v1/attendance/user/:userId
// @access  Private (Admin/Manager)
exports.getAttendanceByUser = asyncHandler(async (req, res, next) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const startIndex = (page - 1) * limit;

  const total = await Attendance.countDocuments({ userId: req.params.userId });

  const attendance = await Attendance.find({ userId: req.params.userId })
    .populate('shiftId', 'startDate startTime endDate endTime shiftType status isActive')
    .sort('-clockInAt')
    .skip(startIndex)
    .limit(limit);

  res.status(200).json({
    success: true,
    message: 'Attendance fetched successfully',
    data: { attendance },
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

// @desc    Update attendance
// @route   PUT /api/v1/attendance/:id
// @access  Private (Admin/Manager)
exports.updateAttendance = asyncHandler(async (req, res, next) => {
  const fieldsToUpdate = {
    clockInAt: req.body.clockInAt,
    clockOutAt: req.body.clockOutAt,
    status: req.body.status,
    shiftId: req.body.shiftId,
    autoClockOut: req.body.autoClockOut,
  };

  // When admin manually sets a clock-out time, clear the auto-clock-out flag
  if (req.body.clockOutAt !== undefined) {
    fieldsToUpdate.autoClockOut = false;
  }

  Object.keys(fieldsToUpdate).forEach(
    (key) => fieldsToUpdate[key] === undefined && delete fieldsToUpdate[key]
  );

  const attendance = await Attendance.findByIdAndUpdate(req.params.id, fieldsToUpdate, {
    new: true,
    runValidators: true,
  });

  if (!attendance) {
    return next(new AppError('Attendance record not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Attendance updated successfully',
    data: { attendance },
  });
});

// ─── Monthly Hours Summary ────────────────────────────────────────────────────
// @desc    Aggregate work hours per staff member for a given month/year
// @route   GET /api/v1/attendance/monthly-hours
// @access  Admin, Manager
exports.getMonthlyHoursSummary = asyncHandler(async (req, res) => {
  const month  = parseInt(req.query.month, 10) || (new Date().getMonth() + 1);
  const year   = parseInt(req.query.year,  10) || new Date().getFullYear();
  const userId = req.query.userId || null;

  // Clamp month
  const m = Math.max(1, Math.min(12, month));

  const startDate = new Date(Date.UTC(year, m - 1, 1, 0, 0, 0, 0));
  const endDate   = new Date(Date.UTC(year, m,     0, 23, 59, 59, 999));

  const mongoose = require('mongoose');

  const baseMatch = { clockInAt: { $gte: startDate, $lte: endDate } };
  if (userId) baseMatch.userId = new mongoose.Types.ObjectId(userId);

  // ── Complete sessions (have clockOut & positive duration) ────────────────
  const completePipeline = [
    { $match: { ...baseMatch, clockOutAt: { $exists: true, $ne: null } } },
    { $addFields: { durationMs: { $subtract: ['$clockOutAt', '$clockInAt'] } } },
    { $match: { durationMs: { $gt: 0 } } },
    {
      $group: {
        _id: '$userId',
        totalMinutes: { $sum: { $divide: ['$durationMs', 60000] } },
        daysSet: { $addToSet: { $dateToString: { format: '%Y-%m-%d', date: '$clockInAt' } } },
        sessionCount: { $sum: 1 },
      },
    },
    {
      $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' },
    },
    { $unwind: { path: '$user', preserveNullAndEmptyArrays: false } },
    {
      $project: {
        userId:       '$_id',
        name:         { $ifNull: ['$user.name', 'Unknown'] },
        role:         { $ifNull: ['$user.staffRole', '$user.role'] },
        totalMinutes: { $round: ['$totalMinutes', 0] },
        daysWorked:   { $size: '$daysSet' },
        sessionCount: 1,
      },
    },
    { $sort: { name: 1 } },
  ];

  // ── Incomplete sessions (missing or null clockOut) ───────────────────────
  const incompletePipeline = [
    { $match: { ...baseMatch, $or: [{ clockOutAt: { $exists: false } }, { clockOutAt: null }] } },
    { $group: { _id: '$userId', count: { $sum: 1 } } },
  ];

  const [completeRows, incompleteRows] = await Promise.all([
    Attendance.aggregate(completePipeline),
    Attendance.aggregate(incompletePipeline),
  ]);

  const incompleteMap = {};
  incompleteRows.forEach(({ _id, count }) => { incompleteMap[_id.toString()] = count; });

  const STANDARD_DAILY_HOURS = 8;

  const summary = completeRows.map((r) => {
    const totalMinutes  = Math.max(0, r.totalMinutes);
    const totalHours    = Math.round(totalMinutes / 60 * 10) / 10;
    const avgDaily      = r.daysWorked > 0 ? Math.round(totalMinutes / r.daysWorked) : 0;
    const expectedMins  = r.daysWorked * STANDARD_DAILY_HOURS * 60;
    const overtimeMins  = Math.max(0, totalMinutes - expectedMins);
    return {
      userId:              r.userId,
      name:                r.name,
      role:                r.role,
      sessionCount:        r.sessionCount,
      incompleteSessions:  incompleteMap[r.userId.toString()] || 0,
      daysWorked:          r.daysWorked,
      totalMinutes,
      totalHours,
      avgDailyMinutes:     avgDaily,
      avgDailyHours:       Math.round(avgDaily / 60 * 10) / 10,
      overtimeMinutes:     overtimeMins,
      overtimeHours:       Math.round(overtimeMins / 60 * 10) / 10,
    };
  });

  res.status(200).json({
    success: true,
    message: 'Monthly hours summary fetched',
    data: { summary, month: m, year },
  });
});
