const StaffCompensation = require('../models/StaffCompensation.js');
const WorkShift = require('../models/WorkShift.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');

// @desc    Get staff compensation
// @route   GET /api/v1/staff/:userId/compensation
// @access  Private (Admin/Manager)
exports.getCompensation = asyncHandler(async (req, res, next) => {
  const compensation = await StaffCompensation.findOne({ userId: req.params.userId })
    .populate('userId', 'name email phone role');

  if (!compensation) {
    return next(new AppError('Compensation not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Compensation fetched successfully',
    data: { compensation },
  });
});

// @desc    Set staff compensation
// @route   PUT /api/v1/staff/:userId/compensation
// @access  Private (Admin/Manager)
exports.setCompensation = asyncHandler(async (req, res, next) => {
  const { payType, hourlyRate, overtimeRate, monthlySalary, bonusPerOrder, active } = req.body;

  const compensation = await StaffCompensation.findOneAndUpdate(
    { userId: req.params.userId },
    { payType, hourlyRate, overtimeRate, monthlySalary, bonusPerOrder, active },
    { new: true, upsert: true, runValidators: true }
  );

  res.status(200).json({
    success: true,
    message: 'Compensation updated successfully',
    data: { compensation },
  });
});

// @desc    Get shifts
// @route   GET /api/v1/staff/shifts
// @access  Private (Admin/Manager/Staff)
exports.getShifts = asyncHandler(async (req, res, next) => {
  let query = {};

  if (req.query.userId) query.userId = req.query.userId;
  if (req.query.startDate) {
    query.startAt = { $gte: new Date(req.query.startDate) };
  }
  if (req.query.endDate) {
    query.endAt = { ...query.endAt, $lte: new Date(req.query.endDate) };
  }

  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const startIndex = (page - 1) * limit;

  const total = await WorkShift.countDocuments(query);

  const shifts = await WorkShift.find(query)
    .populate('userId', 'name role staffRole')
    .populate('createdById', 'name')
    .sort('-startAt')
    .skip(startIndex)
    .limit(limit);

  res.status(200).json({
    success: true,
    message: 'Shifts fetched successfully',
    data: { shifts },
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

// @desc    Get single shift
// @route   GET /api/v1/staff/shifts/:id
// @access  Private
exports.getShift = asyncHandler(async (req, res, next) => {
  const shift = await WorkShift.findById(req.params.id)
    .populate('userId', 'name role staffRole')
    .populate('createdById', 'name');

  if (!shift) {
    return next(new AppError('Shift not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Shift fetched successfully',
    data: { shift },
  });
});

// @desc    Create shift
// @route   POST /api/v1/staff/shifts
// @access  Private (Admin/Manager)
exports.createShift = asyncHandler(async (req, res, next) => {
  const { userId, startAt, endAt, title, notes } = req.body;

  const shift = await WorkShift.create({
    userId,
    startAt,
    endAt,
    title,
    notes,
    createdById: req.user.id,
  });

  res.status(201).json({
    success: true,
    message: 'Shift created successfully',
    data: { shift },
  });
});

// @desc    Update shift
// @route   PUT /api/v1/staff/shifts/:id
// @access  Private (Admin/Manager)
exports.updateShift = asyncHandler(async (req, res, next) => {
  const fieldsToUpdate = {
    userId: req.body.userId,
    startAt: req.body.startAt,
    endAt: req.body.endAt,
    title: req.body.title,
    notes: req.body.notes,
  };

  Object.keys(fieldsToUpdate).forEach(
    (key) => fieldsToUpdate[key] === undefined && delete fieldsToUpdate[key]
  );

  const shift = await WorkShift.findByIdAndUpdate(req.params.id, fieldsToUpdate, {
    new: true,
    runValidators: true,
  });

  if (!shift) {
    return next(new AppError('Shift not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Shift updated successfully',
    data: { shift },
  });
});

// @desc    Delete shift
// @route   DELETE /api/v1/staff/shifts/:id
// @access  Private (Admin/Manager)
exports.deleteShift = asyncHandler(async (req, res, next) => {
  const shift = await WorkShift.findById(req.params.id);

  if (!shift) {
    return next(new AppError('Shift not found', 404));
  }

  await shift.deleteOne();

  res.status(200).json({
    success: true,
    message: 'Shift deleted successfully',
    data: {},
  });
});

// @desc    Get my shifts
// @route   GET /api/v1/staff/shifts/me
// @access  Private
exports.getMyShifts = asyncHandler(async (req, res, next) => {
  let query = { userId: req.user.id };

  if (req.query.startDate) {
    query.startAt = { $gte: new Date(req.query.startDate) };
  }

  const shifts = await WorkShift.find(query)
    .sort('-startAt')
    .limit(50);

  res.status(200).json({
    success: true,
    message: 'My shifts fetched successfully',
    data: { shifts },
  });
});
