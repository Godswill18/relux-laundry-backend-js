const PayrollPeriod = require('../models/PayrollPeriod.js');
const PayrollEntry = require('../models/PayrollEntry.js');
const Payslip = require('../models/Payslip.js');
const StaffCompensation = require('../models/StaffCompensation.js');
const Attendance = require('../models/Attendance.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Calculate hours worked from attendance records.
 * For weekly periods the regular threshold is 40h, biweekly 80h, monthly 160h.
 */
function calculateHoursFromAttendance(attendanceRecords, frequency) {
  let totalHours = 0;
  let lateCount = 0;

  for (const record of attendanceRecords) {
    if (record.clockOutAt) {
      const hours = (record.clockOutAt - record.clockInAt) / (1000 * 60 * 60);
      totalHours += Math.round(hours * 100) / 100;
    }
    if (record.status === 'late') lateCount++;
  }

  const thresholds = { weekly: 40, biweekly: 80, monthly: 160, custom: 160 };
  const threshold = thresholds[frequency] || 160;
  const overtimeHours = Math.max(0, totalHours - threshold);
  const regularHours = totalHours - overtimeHours;

  return {
    regularHours: Math.round(regularHours * 100) / 100,
    overtimeHours: Math.round(overtimeHours * 100) / 100,
    attendanceCount: attendanceRecords.length,
    lateCount,
  };
}

/**
 * Calculate pay for a single staff member entry.
 */
function calculatePay(comp, regularHours, overtimeHours) {
  let basePay = 0;
  let overtimePay = 0;

  if (comp.payType === 'hourly') {
    basePay = regularHours * (comp.hourlyRate || 0);
    overtimePay = overtimeHours * (comp.overtimeRate || comp.hourlyRate * 1.5 || 0);
  } else {
    // Monthly salary — not affected by hours
    basePay = comp.monthlySalary || 0;
    overtimePay = overtimeHours * (comp.overtimeRate || 0);
  }

  return {
    basePay: Math.round(basePay),
    overtimePay: Math.round(overtimePay),
    totalPay: Math.round(basePay + overtimePay),
  };
}

// ============================================================================
// PERIOD CRUD
// ============================================================================

// @desc    Get payroll periods
// @route   GET /api/v1/payroll/periods
// @access  Private (Admin/Manager)
exports.getPeriods = asyncHandler(async (req, res) => {
  const query = {};
  if (req.query.status && req.query.status !== 'all') query.status = req.query.status;

  const periods = await PayrollPeriod.find(query)
    .populate('createdBy', 'name')
    .populate('approvedBy', 'name')
    .sort('-startDate');

  res.status(200).json({
    success: true,
    message: 'Payroll periods fetched successfully',
    data: { periods },
  });
});

// @desc    Get single payroll period with summary
// @route   GET /api/v1/payroll/periods/:id
// @access  Private (Admin/Manager)
exports.getPeriod = asyncHandler(async (req, res, next) => {
  const period = await PayrollPeriod.findById(req.params.id)
    .populate('createdBy', 'name')
    .populate('approvedBy', 'name')
    .populate('staffIds', 'name email staffRole');

  if (!period) {
    return next(new AppError('Payroll period not found', 404));
  }

  // Get entry summary
  const entries = await PayrollEntry.find({ periodId: period._id });
  const summary = {
    totalEntries: entries.length,
    totalAmount: entries.reduce((sum, e) => sum + (e.totalPay || 0), 0),
    paidCount: entries.filter((e) => e.paymentStatus === 'paid').length,
    pendingCount: entries.filter((e) => e.paymentStatus === 'pending').length,
  };

  res.status(200).json({
    success: true,
    message: 'Payroll period fetched successfully',
    data: { period, summary },
  });
});

// @desc    Create payroll schedule/period
// @route   POST /api/v1/payroll/periods
// @access  Private (Admin)
exports.createPeriod = asyncHandler(async (req, res, next) => {
  const { name, startDate, endDate, frequency, staffIds } = req.body;

  if (!startDate || !endDate) {
    return next(new AppError('Start date and end date are required', 400));
  }

  const start = new Date(startDate);
  const end = new Date(endDate);

  if (end <= start) {
    return next(new AppError('End date must be after start date', 400));
  }

  // Check for overlapping draft/approved/finalized periods (prevent duplicates)
  const overlap = await PayrollPeriod.findOne({
    startDate: { $lte: end },
    endDate: { $gte: start },
    status: { $in: ['draft', 'approved', 'finalized'] },
  });

  if (overlap) {
    return next(
      new AppError(
        `An active payroll period already overlaps this date range (${overlap.name || 'Unnamed'})`,
        400
      )
    );
  }

  // If staffIds not provided, include all active staff with compensation
  let selectedStaff = staffIds || [];
  if (!selectedStaff.length) {
    const comps = await StaffCompensation.find({ active: true }).select('userId');
    selectedStaff = comps.map((c) => c.userId);
  }

  // Auto-generate name if not provided
  const periodName =
    name ||
    `${(frequency || 'monthly').charAt(0).toUpperCase() + (frequency || 'monthly').slice(1)} Payroll - ${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} to ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

  const period = await PayrollPeriod.create({
    name: periodName,
    startDate: start,
    endDate: end,
    frequency: frequency || 'monthly',
    staffIds: selectedStaff,
    createdBy: req.user.id,
  });

  res.status(201).json({
    success: true,
    message: 'Payroll schedule created successfully',
    data: { period },
  });
});

// @desc    Update payroll period (draft only)
// @route   PUT /api/v1/payroll/periods/:id
// @access  Private (Admin)
exports.updatePeriod = asyncHandler(async (req, res, next) => {
  const period = await PayrollPeriod.findById(req.params.id);

  if (!period) {
    return next(new AppError('Payroll period not found', 404));
  }

  if (period.status !== 'draft') {
    return next(new AppError('Only draft periods can be edited', 400));
  }

  const { name, startDate, endDate, frequency, staffIds } = req.body;
  if (name !== undefined) period.name = name;
  if (startDate) period.startDate = new Date(startDate);
  if (endDate) period.endDate = new Date(endDate);
  if (frequency) period.frequency = frequency;
  if (staffIds) period.staffIds = staffIds;

  await period.save();

  res.status(200).json({
    success: true,
    message: 'Payroll period updated successfully',
    data: { period },
  });
});

// @desc    Delete payroll period (draft only)
// @route   DELETE /api/v1/payroll/periods/:id
// @access  Private (Admin)
exports.deletePeriod = asyncHandler(async (req, res, next) => {
  const period = await PayrollPeriod.findById(req.params.id);

  if (!period) {
    return next(new AppError('Payroll period not found', 404));
  }

  if (period.status !== 'draft') {
    return next(new AppError('Only draft periods can be deleted', 400));
  }

  // Delete associated entries and payslips
  const entries = await PayrollEntry.find({ periodId: period._id }).select('_id');
  const entryIds = entries.map((e) => e._id);
  await Payslip.deleteMany({ entryId: { $in: entryIds } });
  await PayrollEntry.deleteMany({ periodId: period._id });
  await period.deleteOne();

  res.status(200).json({
    success: true,
    message: 'Payroll period deleted successfully',
    data: {},
  });
});

// ============================================================================
// WORKFLOW: Generate → Approve → Finalize → Mark Paid
// ============================================================================

// @desc    Generate/recalculate entries for a draft period
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

  // Determine which staff to include
  let staffUserIds = period.staffIds || [];

  // If no staff selected on the period, use all active compensations
  if (!staffUserIds.length) {
    const comps = await StaffCompensation.find({ active: true }).select('userId');
    staffUserIds = comps.map((c) => c.userId);
  }

  // Get compensations for selected staff
  const compensations = await StaffCompensation.find({
    userId: { $in: staffUserIds },
    active: true,
  });

  if (compensations.length === 0) {
    return next(
      new AppError('No staff with active compensation found for this period', 400)
    );
  }

  const entries = [];
  let periodTotal = 0;

  for (const comp of compensations) {
    // Get attendance for this user in this period
    const attendanceRecords = await Attendance.find({
      userId: comp.userId,
      clockInAt: { $gte: period.startDate, $lte: period.endDate },
    });

    const hours = calculateHoursFromAttendance(attendanceRecords, period.frequency);
    const pay = calculatePay(comp, hours.regularHours, hours.overtimeHours);

    const entry = await PayrollEntry.findOneAndUpdate(
      { periodId: period._id, userId: comp.userId },
      {
        payType: comp.payType,
        baseHours: hours.regularHours,
        overtimeHours: hours.overtimeHours,
        hourlyRate: comp.hourlyRate,
        overtimeRate: comp.overtimeRate || Math.round(comp.hourlyRate * 1.5),
        basePay: pay.basePay,
        overtimePay: pay.overtimePay,
        totalPay: pay.totalPay,
        attendanceCount: hours.attendanceCount,
        lateCount: hours.lateCount,
      },
      { new: true, upsert: true, runValidators: true }
    );

    periodTotal += entry.totalPay;
    entries.push(entry);
  }

  // Update period total
  period.totalAmount = periodTotal;
  await period.save();

  // Populate user info for response
  const populated = await PayrollEntry.find({ periodId: period._id })
    .populate('userId', 'name email role staffRole')
    .sort('userId');

  res.status(201).json({
    success: true,
    message: `Payroll entries generated for ${entries.length} staff members`,
    data: { entries: populated, count: entries.length, totalAmount: periodTotal },
  });
});

// @desc    Approve payroll period
// @route   PUT /api/v1/payroll/periods/:id/approve
// @access  Private (Admin)
exports.approvePeriod = asyncHandler(async (req, res, next) => {
  const period = await PayrollPeriod.findById(req.params.id);

  if (!period) {
    return next(new AppError('Payroll period not found', 404));
  }

  if (period.status !== 'draft') {
    return next(new AppError('Only draft periods can be approved', 400));
  }

  // Verify entries exist
  const entryCount = await PayrollEntry.countDocuments({ periodId: period._id });
  if (entryCount === 0) {
    return next(new AppError('Cannot approve a period with no entries. Generate entries first.', 400));
  }

  period.status = 'approved';
  period.approvedBy = req.user.id;
  period.approvedAt = new Date();
  await period.save();

  res.status(200).json({
    success: true,
    message: 'Payroll period approved successfully',
    data: { period },
  });
});

// @desc    Finalize payroll period (locks editing)
// @route   PUT /api/v1/payroll/periods/:id/finalize
// @access  Private (Admin)
exports.finalizePeriod = asyncHandler(async (req, res, next) => {
  const period = await PayrollPeriod.findById(req.params.id);

  if (!period) {
    return next(new AppError('Payroll period not found', 404));
  }

  if (period.status !== 'draft' && period.status !== 'approved') {
    return next(new AppError('Only draft or approved periods can be finalized', 400));
  }

  // Verify entries exist
  const entryCount = await PayrollEntry.countDocuments({ periodId: period._id });
  if (entryCount === 0) {
    return next(new AppError('Cannot finalize a period with no entries', 400));
  }

  period.status = 'finalized';
  if (!period.approvedBy) {
    period.approvedBy = req.user.id;
    period.approvedAt = new Date();
  }
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

  const now = new Date();

  // Mark all entries as paid
  await PayrollEntry.updateMany(
    { periodId: period._id, paymentStatus: 'pending' },
    { paymentStatus: 'paid', paidAt: now }
  );

  period.status = 'paid';
  period.paidAt = now;
  await period.save();

  res.status(200).json({
    success: true,
    message: 'Payroll period marked as paid. All entries updated.',
    data: { period },
  });
});

// ============================================================================
// ENTRIES
// ============================================================================

// @desc    Get entries for a period
// @route   GET /api/v1/payroll/periods/:periodId/entries
// @access  Private (Admin/Manager)
exports.getEntries = asyncHandler(async (req, res) => {
  const entries = await PayrollEntry.find({ periodId: req.params.periodId })
    .populate('userId', 'name email role staffRole phone')
    .sort('userId');

  // Also compute summary
  const totalAmount = entries.reduce((sum, e) => sum + (e.totalPay || 0), 0);
  const totalBonuses = entries.reduce((sum, e) => sum + (e.bonuses || 0), 0);
  const totalDeductions = entries.reduce((sum, e) => sum + (e.deductions || 0), 0);

  res.status(200).json({
    success: true,
    message: 'Payroll entries fetched successfully',
    data: {
      entries,
      summary: {
        totalEntries: entries.length,
        totalAmount,
        totalBonuses,
        totalDeductions,
      },
    },
  });
});

// @desc    Update payroll entry (draft periods only)
// @route   PUT /api/v1/payroll/entries/:id
// @access  Private (Admin)
exports.updateEntry = asyncHandler(async (req, res, next) => {
  const entry = await PayrollEntry.findById(req.params.id).populate('periodId');

  if (!entry) {
    return next(new AppError('Payroll entry not found', 404));
  }

  // Check period is still editable
  if (entry.periodId && entry.periodId.status && entry.periodId.status !== 'draft') {
    return next(new AppError('Cannot edit entries for non-draft periods', 400));
  }

  const allowed = ['baseHours', 'overtimeHours', 'bonuses', 'deductions', 'totalPay', 'notes'];
  const fieldsToUpdate = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) fieldsToUpdate[key] = req.body[key];
  }

  const updated = await PayrollEntry.findByIdAndUpdate(req.params.id, fieldsToUpdate, {
    new: true,
    runValidators: true,
  }).populate('userId', 'name email role staffRole');

  // Recalculate period total
  const periodId = entry.periodId._id || entry.periodId;
  const allEntries = await PayrollEntry.find({ periodId });
  const newTotal = allEntries.reduce((sum, e) => sum + (e.totalPay || 0), 0);
  await PayrollPeriod.findByIdAndUpdate(periodId, { totalAmount: newTotal });

  res.status(200).json({
    success: true,
    message: 'Payroll entry updated successfully',
    data: { entry: updated },
  });
});

// ============================================================================
// PAYSLIPS
// ============================================================================

// @desc    Get my payslips
// @route   GET /api/v1/payroll/payslips/me
// @access  Private
exports.getMyPayslips = asyncHandler(async (req, res) => {
  const entries = await PayrollEntry.find({ userId: req.user.id })
    .populate('periodId', 'startDate endDate status name frequency')
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
  const payslip = await Payslip.findById(req.params.id).populate({
    path: 'entryId',
    populate: [
      { path: 'userId', select: 'name email role staffRole' },
      { path: 'periodId', select: 'startDate endDate name frequency' },
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
    .populate('userId', 'name email role staffRole')
    .populate('periodId', 'startDate endDate name frequency');

  if (!entry) {
    return next(new AppError('Payroll entry not found', 404));
  }

  const payslip = await Payslip.findOneAndUpdate(
    { entryId: entry._id },
    {
      data: {
        employee: entry.userId,
        period: entry.periodId,
        payType: entry.payType,
        baseHours: entry.baseHours,
        overtimeHours: entry.overtimeHours,
        hourlyRate: entry.hourlyRate,
        overtimeRate: entry.overtimeRate,
        basePay: entry.basePay,
        overtimePay: entry.overtimePay,
        bonuses: entry.bonuses,
        deductions: entry.deductions,
        totalPay: entry.totalPay,
        attendanceCount: entry.attendanceCount,
        lateCount: entry.lateCount,
        paymentStatus: entry.paymentStatus,
        paidAt: entry.paidAt,
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
