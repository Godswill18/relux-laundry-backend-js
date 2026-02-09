const PayrollPeriod = require('../models/PayrollPeriod.js');
const PayrollEntry = require('../models/PayrollEntry.js');
const Payslip = require('../models/Payslip.js');
const StaffCompensation = require('../models/StaffCompensation.js');
const Attendance = require('../models/Attendance.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');

// @desc    Get payroll periods
// @route   GET /api/v1/payroll/periods
// @access  Private (Admin/Manager)
exports.getPeriods = asyncHandler(async (req, res, next) => {
  let query = {};
  if (req.query.status) query.status = req.query.status;

  const periods = await PayrollPeriod.find(query).sort('-startDate');

  res.status(200).json({
    success: true,
    message: 'Payroll periods fetched successfully',
    data: { periods },
  });
});

// @desc    Get single payroll period
// @route   GET /api/v1/payroll/periods/:id
// @access  Private (Admin/Manager)
exports.getPeriod = asyncHandler(async (req, res, next) => {
  const period = await PayrollPeriod.findById(req.params.id);

  if (!period) {
    return next(new AppError('Payroll period not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Payroll period fetched successfully',
    data: { period },
  });
});

// @desc    Create payroll period
// @route   POST /api/v1/payroll/periods
// @access  Private (Admin)
exports.createPeriod = asyncHandler(async (req, res, next) => {
  const { startDate, endDate } = req.body;

  const period = await PayrollPeriod.create({ startDate, endDate });

  res.status(201).json({
    success: true,
    message: 'Payroll period created successfully',
    data: { period },
  });
});

// @desc    Finalize payroll period
// @route   PUT /api/v1/payroll/periods/:id/finalize
// @access  Private (Admin)
exports.finalizePeriod = asyncHandler(async (req, res, next) => {
  const period = await PayrollPeriod.findById(req.params.id);

  if (!period) {
    return next(new AppError('Payroll period not found', 404));
  }

  if (period.status !== 'draft') {
    return next(new AppError('Only draft periods can be finalized', 400));
  }

  period.status = 'finalized';
  await period.save();

  res.status(200).json({
    success: true,
    message: 'Payroll period finalized successfully',
    data: { period },
  });
});

// @desc    Mark period as paid
// @route   PUT /api/v1/payroll/periods/:id/paid
// @access  Private (Admin)
exports.markPeriodPaid = asyncHandler(async (req, res, next) => {
  const period = await PayrollPeriod.findById(req.params.id);

  if (!period) {
    return next(new AppError('Payroll period not found', 404));
  }

  if (period.status !== 'finalized') {
    return next(new AppError('Only finalized periods can be marked as paid', 400));
  }

  period.status = 'paid';
  await period.save();

  res.status(200).json({
    success: true,
    message: 'Payroll period marked as paid',
    data: { period },
  });
});

// @desc    Get entries for a period
// @route   GET /api/v1/payroll/periods/:periodId/entries
// @access  Private (Admin/Manager)
exports.getEntries = asyncHandler(async (req, res, next) => {
  const entries = await PayrollEntry.find({ periodId: req.params.periodId })
    .populate('userId', 'name email role staffRole')
    .sort('userId');

  res.status(200).json({
    success: true,
    message: 'Payroll entries fetched successfully',
    data: { entries },
  });
});

// @desc    Generate entries for a period
// @route   POST /api/v1/payroll/periods/:periodId/generate
// @access  Private (Admin)
exports.generateEntries = asyncHandler(async (req, res, next) => {
  const period = await PayrollPeriod.findById(req.params.periodId);

  if (!period) {
    return next(new AppError('Payroll period not found', 404));
  }

  if (period.status !== 'draft') {
    return next(new AppError('Can only generate entries for draft periods', 400));
  }

  // Get all staff compensations
  const compensations = await StaffCompensation.find({ active: true });

  const entries = [];

  for (const comp of compensations) {
    // Get attendance for this user in this period
    const attendanceRecords = await Attendance.find({
      userId: comp.userId,
      clockInAt: { $gte: period.startDate, $lte: period.endDate },
    });

    let baseHours = 0;
    let lateCount = 0;

    for (const record of attendanceRecords) {
      if (record.clockOutAt) {
        const hours = (record.clockOutAt - record.clockInAt) / (1000 * 60 * 60);
        baseHours += Math.round(hours * 100) / 100;
      }
      if (record.status === 'late') lateCount++;
    }

    const overtimeHours = Math.max(0, baseHours - 160); // Assuming 160 regular hours/month
    const regularHours = baseHours - overtimeHours;

    let totalPay = 0;
    if (comp.payType === 'hourly') {
      totalPay = (regularHours * comp.hourlyRate) + (overtimeHours * comp.overtimeRate);
    } else {
      totalPay = comp.monthlySalary;
    }

    const entry = await PayrollEntry.findOneAndUpdate(
      { periodId: period._id, userId: comp.userId },
      {
        baseHours: regularHours,
        overtimeHours,
        hourlyRate: comp.hourlyRate,
        overtimeRate: comp.overtimeRate,
        totalPay: Math.round(totalPay),
        attendanceCount: attendanceRecords.length,
        lateCount,
      },
      { new: true, upsert: true, runValidators: true }
    );

    entries.push(entry);
  }

  res.status(201).json({
    success: true,
    message: 'Payroll entries generated successfully',
    data: { entries, count: entries.length },
  });
});

// @desc    Update payroll entry
// @route   PUT /api/v1/payroll/entries/:id
// @access  Private (Admin)
exports.updateEntry = asyncHandler(async (req, res, next) => {
  const fieldsToUpdate = {
    baseHours: req.body.baseHours,
    overtimeHours: req.body.overtimeHours,
    bonuses: req.body.bonuses,
    deductions: req.body.deductions,
    totalPay: req.body.totalPay,
  };

  Object.keys(fieldsToUpdate).forEach(
    (key) => fieldsToUpdate[key] === undefined && delete fieldsToUpdate[key]
  );

  const entry = await PayrollEntry.findByIdAndUpdate(req.params.id, fieldsToUpdate, {
    new: true,
    runValidators: true,
  });

  if (!entry) {
    return next(new AppError('Payroll entry not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Payroll entry updated successfully',
    data: { entry },
  });
});

// @desc    Get my payslips
// @route   GET /api/v1/payroll/payslips/me
// @access  Private
exports.getMyPayslips = asyncHandler(async (req, res, next) => {
  const entries = await PayrollEntry.find({ userId: req.user.id })
    .populate('periodId', 'startDate endDate status')
    .sort('-createdAt');

  const entryIds = entries.map((e) => e._id);
  const payslips = await Payslip.find({ entryId: { $in: entryIds } });

  res.status(200).json({
    success: true,
    message: 'Payslips fetched successfully',
    data: { entries, payslips },
  });
});

// @desc    Get single payslip
// @route   GET /api/v1/payroll/payslips/:id
// @access  Private
exports.getPayslip = asyncHandler(async (req, res, next) => {
  const payslip = await Payslip.findById(req.params.id)
    .populate({
      path: 'entryId',
      populate: [
        { path: 'userId', select: 'name email role' },
        { path: 'periodId', select: 'startDate endDate' },
      ],
    });

  if (!payslip) {
    return next(new AppError('Payslip not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Payslip fetched successfully',
    data: { payslip },
  });
});

// @desc    Generate payslip for an entry
// @route   POST /api/v1/payroll/entries/:entryId/payslip
// @access  Private (Admin)
exports.generatePayslip = asyncHandler(async (req, res, next) => {
  const entry = await PayrollEntry.findById(req.params.entryId)
    .populate('userId', 'name email role')
    .populate('periodId', 'startDate endDate');

  if (!entry) {
    return next(new AppError('Payroll entry not found', 404));
  }

  const payslip = await Payslip.findOneAndUpdate(
    { entryId: entry._id },
    {
      data: {
        employee: entry.userId,
        period: entry.periodId,
        baseHours: entry.baseHours,
        overtimeHours: entry.overtimeHours,
        hourlyRate: entry.hourlyRate,
        overtimeRate: entry.overtimeRate,
        bonuses: entry.bonuses,
        deductions: entry.deductions,
        totalPay: entry.totalPay,
        attendanceCount: entry.attendanceCount,
        lateCount: entry.lateCount,
        generatedAt: new Date(),
      },
    },
    { new: true, upsert: true }
  );

  res.status(201).json({
    success: true,
    message: 'Payslip generated successfully',
    data: { payslip },
  });
});
