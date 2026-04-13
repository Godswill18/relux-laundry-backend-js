const User = require('../models/User.js');
const StaffCompensation = require('../models/StaffCompensation.js');
const WorkShift = require('../models/WorkShift.js');
const AuditLog = require('../models/AuditLog.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');

// ============================================================================
// STAFF CRUD (users with staff/admin/manager roles)
// ============================================================================

// @desc    Get all staff members
// @route   GET /api/v1/staff
// @access  Private (Admin/Manager)
exports.getStaff = asyncHandler(async (req, res, next) => {
  let query = { role: { $in: ['staff', 'admin', 'manager', 'delivery'] } };

  if (req.query.role && req.query.role !== 'all') {
    query.role = req.query.role;
  }

  if (req.query.status && req.query.status !== 'all') {
    query.isActive = req.query.status === 'active';
  }

  if (req.query.search) {
    query.$or = [
      { name: { $regex: req.query.search, $options: 'i' } },
      { phone: { $regex: req.query.search, $options: 'i' } },
      { email: { $regex: req.query.search, $options: 'i' } },
    ];
  }

  const staff = await User.find(query).select('-password').sort('-createdAt');

  res.status(200).json({
    success: true,
    message: 'Staff fetched successfully',
    data: staff,
  });
});

// @desc    Create staff member
// @route   POST /api/v1/staff
// @access  Private (Admin/Manager)
exports.createStaff = asyncHandler(async (req, res, next) => {
  const { name, email, phone, password, role, staffRole, address, city, dateOfBirth, hireDate, bankName, bankAccountNumber, bankAccountName, emergencyContactName, emergencyContactPhone, guarantorName, guarantorPhone } = req.body;

  const existingUser = await User.findOne({
    $or: [
      ...(phone ? [{ phone }] : []),
      ...(email ? [{ email }] : []),
    ],
  });

  if (existingUser) {
    return next(new AppError('A user with this phone or email already exists', 400));
  }

  const user = await User.create({
    name,
    email,
    phone,
    password,
    role: role || 'staff',
    staffRole,
    address,
    city,
    dateOfBirth,
    hireDate,
    bankName,
    bankAccountNumber,
    bankAccountName,
    emergencyContactName,
    emergencyContactPhone,
    guarantorName,
    guarantorPhone,
  });

  user.password = undefined;

  res.status(201).json({
    success: true,
    message: 'Staff member created successfully',
    data: user,
  });
});

// @desc    Update staff member
// @route   PATCH /api/v1/staff/:id
// @access  Private (Admin/Manager)
exports.updateStaff = asyncHandler(async (req, res, next) => {
  const fieldsToUpdate = {
    name: req.body.name,
    email: req.body.email,
    phone: req.body.phone,
    role: req.body.role,
    staffRole: req.body.staffRole,
    isActive: req.body.isActive,
    address: req.body.address,
    city: req.body.city,
    dateOfBirth: req.body.dateOfBirth,
    hireDate: req.body.hireDate,
    bankName: req.body.bankName,
    bankAccountNumber: req.body.bankAccountNumber,
    bankAccountName: req.body.bankAccountName,
    emergencyContactName: req.body.emergencyContactName,
    emergencyContactPhone: req.body.emergencyContactPhone,
    guarantorName: req.body.guarantorName,
    guarantorPhone: req.body.guarantorPhone,
  };

  Object.keys(fieldsToUpdate).forEach(
    (key) => fieldsToUpdate[key] === undefined && delete fieldsToUpdate[key]
  );

  const user = await User.findByIdAndUpdate(req.params.id, fieldsToUpdate, {
    new: true,
    runValidators: true,
  }).select('-password');

  if (!user) {
    return next(new AppError('Staff member not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Staff member updated successfully',
    data: user,
  });
});

// @desc    Delete staff member
// @route   DELETE /api/v1/staff/:id
// @access  Private (Admin)
exports.deleteStaff = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.params.id);

  if (!user) {
    return next(new AppError('Staff member not found', 404));
  }

  if (user._id.toString() === req.user.id) {
    return next(new AppError('You cannot delete your own account', 400));
  }

  await user.deleteOne();

  res.status(200).json({
    success: true,
    message: 'Staff member deleted successfully',
    data: {},
  });
});

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

// ============================================================================
// SHIFT MANAGEMENT
// ============================================================================

// @desc    Get shifts
// @route   GET /api/v1/staff/shifts
// @access  Private (Admin/Manager/Staff)
exports.getShifts = asyncHandler(async (req, res, next) => {
  let query = {};

  if (req.query.userId) query.userId = req.query.userId;
  if (req.query.status) query.status = req.query.status;
  if (req.query.shiftType) query.shiftType = req.query.shiftType;

  // Date range filters on string YYYY-MM-DD fields
  if (req.query.startDate) {
    query.startDate = { $gte: req.query.startDate };
  }
  if (req.query.endDate) {
    query.endDate = { ...(query.endDate || {}), $lte: req.query.endDate };
  }

  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const startIndex = (page - 1) * limit;

  const total = await WorkShift.countDocuments(query);

  const shifts = await WorkShift.find(query)
    .populate('userId', 'name role staffRole isActive')
    .populate('createdBy', 'name')
    .populate('emergencyActivatedBy', 'name')
    .sort('-startDate -startTime')
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
    .populate('userId', 'name role staffRole isActive')
    .populate('createdBy', 'name')
    .populate('emergencyActivatedBy', 'name');

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
  const { userId, startDate, startTime, endDate, endTime, shiftType, notes } = req.body;

  // Validation
  if (endDate < startDate) {
    return next(new AppError('End date must be on or after start date', 400));
  }

  const shift = await WorkShift.create({
    userId,
    startDate,
    startTime,
    endDate,
    endTime,
    shiftType: shiftType || 'custom',
    status: 'scheduled',
    isActive: false,
    notes,
    createdBy: req.user.id,
  });

  // Populate for response
  await shift.populate('userId', 'name role staffRole isActive');
  await shift.populate('createdBy', 'name');

  // Emit socket event
  const io = req.app.get('io');
  if (io) {
    io.emit('shiftCreated', { shift });
    io.to(`user-${userId}`).emit('shiftCreated', { shift });
  }

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
    startDate: req.body.startDate,
    startTime: req.body.startTime,
    endDate: req.body.endDate,
    endTime: req.body.endTime,
    shiftType: req.body.shiftType,
    status: req.body.status,
    notes: req.body.notes,
  };

  Object.keys(fieldsToUpdate).forEach(
    (key) => fieldsToUpdate[key] === undefined && delete fieldsToUpdate[key]
  );

  // Validation
  if (fieldsToUpdate.endDate && fieldsToUpdate.startDate && fieldsToUpdate.endDate < fieldsToUpdate.startDate) {
    return next(new AppError('End date must be on or after start date', 400));
  }

  const shift = await WorkShift.findByIdAndUpdate(req.params.id, fieldsToUpdate, {
    new: true,
    runValidators: true,
  })
    .populate('userId', 'name role staffRole isActive')
    .populate('createdBy', 'name')
    .populate('emergencyActivatedBy', 'name');

  if (!shift) {
    return next(new AppError('Shift not found', 404));
  }

  // Emit socket event
  const io = req.app.get('io');
  if (io) {
    io.emit('shiftUpdated', { shift });
    io.to(`user-${shift.userId._id || shift.userId}`).emit('shiftUpdated', { shift });
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

  const userId = shift.userId;
  await shift.deleteOne();

  // Emit socket event
  const io = req.app.get('io');
  if (io) {
    io.emit('shiftDeleted', { shiftId: req.params.id, userId });
    io.to(`user-${userId}`).emit('shiftDeleted', { shiftId: req.params.id });
  }

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
    // Filter by endDate >= startDate param so multi-day shifts that started
    // before today but haven't ended yet are still included
    query.endDate = { $gte: req.query.startDate };
  }
  if (req.query.endDate) {
    query.startDate = { ...(query.startDate || {}), $lte: req.query.endDate };
  }
  if (req.query.status) {
    query.status = req.query.status;
  }

  const shifts = await WorkShift.find(query)
    .populate('createdBy', 'name')
    .sort('startDate startTime')
    .limit(100);

  res.status(200).json({
    success: true,
    message: 'My shifts fetched successfully',
    data: { shifts },
  });
});

// ============================================================================
// SELF-SERVICE PROFILE (staff viewing/updating their own profile)
// ============================================================================

// @desc    Get my profile (full user + compensation)
// @route   GET /api/v1/staff/me
// @access  Private
exports.getMyProfile = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.user.id).select('-password');
  if (!user) return next(new AppError('User not found', 404));

  const compensation = await StaffCompensation.findOne({ userId: req.user.id });

  const userObj = user.toObject();
  if (userObj._id && !userObj.id) userObj.id = userObj._id.toString();

  res.status(200).json({
    success: true,
    message: 'Profile fetched successfully',
    data: { user: userObj, compensation: compensation || null },
  });
});

// @desc    Update my profile (non-sensitive fields only)
// @route   PATCH /api/v1/staff/me
// @access  Private
exports.updateMyProfile = asyncHandler(async (req, res, next) => {
  const ALLOWED = ['phone', 'address', 'city', 'gender', 'emergencyContactName', 'emergencyContactPhone'];
  const fields = {};
  ALLOWED.forEach((key) => {
    if (req.body[key] !== undefined) fields[key] = req.body[key];
  });

  const user = await User.findByIdAndUpdate(req.user.id, fields, {
    new: true,
    runValidators: false,
  }).select('-password');

  if (!user) return next(new AppError('User not found', 404));

  const userObj = user.toObject();
  if (userObj._id && !userObj.id) userObj.id = userObj._id.toString();

  res.status(200).json({
    success: true,
    message: 'Profile updated successfully',
    data: { user: userObj },
  });
});

// @desc    Update bank details (requires valid OTP)
// @route   PATCH /api/v1/staff/me/bank
// @access  Private
exports.updateMyBank = asyncHandler(async (req, res, next) => {
  const { otp, bankName, bankAccountNumber, bankAccountName } = req.body;

  if (!otp) return next(new AppError('OTP is required', 400));
  if (!bankName || !bankAccountNumber || !bankAccountName) {
    return next(new AppError('All bank fields are required', 400));
  }

  // Find user and verify OTP
  const user = await User.findOne({
    _id: req.user.id,
    otp,
    otpExpires: { $gt: Date.now() },
  });

  if (!user) return next(new AppError('Invalid or expired OTP', 400));

  user.bankName = bankName;
  user.bankAccountNumber = bankAccountNumber;
  user.bankAccountName = bankAccountName;
  user.otp = undefined;
  user.otpExpires = undefined;
  await user.save({ validateBeforeSave: false });

  res.status(200).json({
    success: true,
    message: 'Bank details updated successfully',
    data: {},
  });
});

// ============================================================================
// EMERGENCY ACTIVATION (per-shift)
// ============================================================================

// @desc    Emergency activate a shift
// @route   PUT /api/v1/staff/shifts/:id/activate
// @access  Private (Admin/Manager)
exports.emergencyActivate = asyncHandler(async (req, res, next) => {
  const shift = await WorkShift.findById(req.params.id);

  if (!shift) {
    return next(new AppError('Shift not found', 404));
  }

  if (shift.isActive && shift.emergencyActivated) {
    return next(new AppError('Shift is already emergency activated', 400));
  }

  shift.isActive = true;
  shift.emergencyActivated = true;
  shift.emergencyActivatedBy = req.user.id;
  shift.emergencyActivatedAt = new Date();
  if (shift.status === 'scheduled') {
    shift.status = 'in-progress';
  }
  await shift.save();

  // Audit log
  await AuditLog.create({
    actorUserId: req.user.id,
    action: 'emergency-activate-shift',
    targetType: 'WorkShift',
    targetId: shift._id.toString(),
    metadata: {
      activatedBy: req.user.name,
      userId: shift.userId.toString(),
    },
  });

  // Emit socket events
  const io = req.app.get('io');
  if (io) {
    io.to(`user-${shift.userId}`).emit('shift:activated', {
      shiftId: shift._id,
      activatedBy: req.user.name,
      emergency: true,
    });
    io.emit('shiftUpdated', { shift });
  }

  res.status(200).json({
    success: true,
    message: 'Shift emergency activated successfully',
    data: { shift },
  });
});

// @desc    Remove emergency activation from a shift
// @route   PUT /api/v1/staff/shifts/:id/deactivate
// @access  Private (Admin/Manager)
exports.emergencyDeactivate = asyncHandler(async (req, res, next) => {
  const shift = await WorkShift.findById(req.params.id);

  if (!shift) {
    return next(new AppError('Shift not found', 404));
  }

  if (!shift.emergencyActivated) {
    return next(new AppError('Shift does not have emergency activation', 400));
  }

  shift.isActive = false;
  shift.emergencyActivated = false;
  shift.emergencyActivatedBy = undefined;
  shift.emergencyActivatedAt = undefined;
  await shift.save();

  // Audit log
  await AuditLog.create({
    actorUserId: req.user.id,
    action: 'emergency-deactivate-shift',
    targetType: 'WorkShift',
    targetId: shift._id.toString(),
    metadata: {
      deactivatedBy: req.user.name,
      userId: shift.userId.toString(),
    },
  });

  // Emit socket events
  const io = req.app.get('io');
  if (io) {
    io.to(`user-${shift.userId}`).emit('shift:deactivated', {
      shiftId: shift._id,
      deactivatedBy: req.user.name,
    });
    io.to(`user-${shift.userId}`).emit(`user:${shift.userId}:force:logout`, {
      reason: 'Emergency shift deactivation',
    });
    io.emit('shiftUpdated', { shift });
  }

  res.status(200).json({
    success: true,
    message: 'Shift emergency deactivation successful',
    data: { shift },
  });
});
