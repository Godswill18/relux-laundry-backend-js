const AuditLog = require('../models/AuditLog.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');

// @desc    Get audit logs
// @route   GET /api/v1/audit-logs
// @access  Private (Admin)
exports.getAuditLogs = asyncHandler(async (req, res, next) => {
  let query = {};

  if (req.query.action) query.action = req.query.action;
  if (req.query.targetType) query.targetType = req.query.targetType;
  if (req.query.actorUserId) query.actorUserId = req.query.actorUserId;
  if (req.query.startDate) {
    query.createdAt = { $gte: new Date(req.query.startDate) };
  }
  if (req.query.endDate) {
    query.createdAt = { ...query.createdAt, $lte: new Date(req.query.endDate) };
  }

  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const startIndex = (page - 1) * limit;

  const total = await AuditLog.countDocuments(query);

  const logs = await AuditLog.find(query)
    .populate('actorUserId', 'name email role')
    .sort('-createdAt')
    .skip(startIndex)
    .limit(limit);

  res.status(200).json({
    success: true,
    message: 'Audit logs fetched successfully',
    data: { logs },
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

// @desc    Get single audit log
// @route   GET /api/v1/audit-logs/:id
// @access  Private (Admin)
exports.getAuditLog = asyncHandler(async (req, res, next) => {
  const log = await AuditLog.findById(req.params.id)
    .populate('actorUserId', 'name email role');

  if (!log) {
    return next(new AppError('Audit log not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Audit log fetched successfully',
    data: { log },
  });
});

// @desc    Get audit logs by target
// @route   GET /api/v1/audit-logs/target/:targetType/:targetId
// @access  Private (Admin)
exports.getAuditLogsByTarget = asyncHandler(async (req, res, next) => {
  const logs = await AuditLog.find({
    targetType: req.params.targetType,
    targetId: req.params.targetId,
  })
    .populate('actorUserId', 'name email role')
    .sort('-createdAt');

  res.status(200).json({
    success: true,
    message: 'Audit logs fetched successfully',
    data: { logs },
  });
});
