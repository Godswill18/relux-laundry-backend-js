const Attendance = require('../models/Attendance.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');

// @desc    Clock in
// @route   POST /api/v1/attendance/clock-in
// @access  Private
exports.clockIn = asyncHandler(async (req, res, next) => {
  const { shiftId, source, ipAddress, deviceId, geoLat, geoLng } = req.body;

  // Check if already clocked in without clocking out
  const openAttendance = await Attendance.findOne({
    userId: req.user.id,
    clockOutAt: null,
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
    geoLat,
    geoLng,
  });

  res.status(201).json({
    success: true,
    message: 'Clocked in successfully',
    data: { attendance },
  });
});

// @desc    Clock out
// @route   PUT /api/v1/attendance/clock-out
// @access  Private
exports.clockOut = asyncHandler(async (req, res, next) => {
  const attendance = await Attendance.findOne({
    userId: req.user.id,
    clockOutAt: null,
  }).sort('-clockInAt');

  if (!attendance) {
    return next(new AppError('No active clock-in found', 400));
  }

  attendance.clockOutAt = new Date();
  await attendance.save();

  res.status(200).json({
    success: true,
    message: 'Clocked out successfully',
    data: { attendance },
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
    .populate('shiftId', 'title startAt endAt')
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
    .populate('shiftId', 'title startAt endAt')
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
    .populate('shiftId', 'title startAt endAt')
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
  };

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
