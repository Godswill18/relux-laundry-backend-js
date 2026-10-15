// ─── Service Level Timer Settings + SLA performance ─────────────────────────
// The processing time belongs to the SERVICE LEVEL (Standard / Express /
// Premium Express …), the same records that carry the price percentage. Only
// the time is managed here; the percentage stays with the normal level edit.
//
// Changing a time is developer-only unless the developer has granted
// MANAGE_SERVICE_SLA to another role — enforced here, not just hidden in the
// UI. It never touches an order that is already confirmed (each order carries
// its own snapshot); it applies to orders confirmed afterwards.

const mongoose = require('mongoose');
const ServiceLevelConfig = require('../models/ServiceLevelConfig.js');
const Order = require('../models/Order.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');
const ERROR_CODES = require('../utils/errorCodes.js');
const { logAudit } = require('../utils/auditLogger.js');
const {
  canConfigureSla, SLA_DUE_SOON_FRACTION, SLA_MIN_HOURS, SLA_MAX_HOURS, validHours,
} = require('../utils/orderSla.js');

const invalid = (m) => new AppError(m, 400, ERROR_CODES.VALIDATION_ERROR);
const HOUR = 3600 * 1000;
const round1 = (n) => Math.round(n * 10) / 10;

// @route GET /api/v1/services/levels/sla
exports.getServiceLevelSlas = asyncHandler(async (req, res) => {
  const levels = await ServiceLevelConfig.find()
    .sort('displayOrder name')
    .populate('slaUpdatedBy', 'name')
    .lean();
  res.status(200).json({
    success: true,
    message: 'Service level timers fetched successfully',
    data: {
      serverTime: new Date().toISOString(),
      dueSoonFraction: SLA_DUE_SOON_FRACTION,
      limits: { minHours: SLA_MIN_HOURS, maxHours: SLA_MAX_HOURS },
      canEdit: await canConfigureSla(req.user.role),
      levels: levels.map((l) => ({
        serviceLevelId: l._id,
        name: l.name,
        percentageAdjustment: l.percentageAdjustment || 0,
        active: l.active,
        hours: l.slaHours ?? null,
        updatedAt: l.slaUpdatedAt || null,
        updatedBy: l.slaUpdatedBy ? { id: l.slaUpdatedBy._id, name: l.slaUpdatedBy.name } : null,
      })),
    },
  });
});

// @route PUT /api/v1/services/levels/sla   body { levels: [{ serviceLevelId, hours }] }
// hours = null turns the timer off for that level.
exports.setServiceLevelSlas = asyncHandler(async (req, res, next) => {
  if (!(await canConfigureSla(req.user.role))) {
    return next(new AppError('You do not have permission to change service level processing times', 403));
  }
  const rows = Array.isArray(req.body.levels) ? req.body.levels : null;
  if (!rows || rows.length === 0) return next(invalid('Nothing to save'));

  // Validate everything before writing anything.
  const plan = [];
  for (const row of rows) {
    if (!mongoose.isValidObjectId(row?.serviceLevelId)) return next(invalid('Unknown service level'));
    let hours = null;
    if (row.hours !== null && row.hours !== '' && row.hours !== undefined) {
      hours = validHours(row.hours);
      if (hours == null) {
        return next(invalid(`Processing time must be between ${SLA_MIN_HOURS} and ${SLA_MAX_HOURS} hours`));
      }
    }
    plan.push({ id: String(row.serviceLevelId), hours });
  }
  const levels = await ServiceLevelConfig.find({ _id: { $in: plan.map((p) => p.id) } });
  const byId = new Map(levels.map((l) => [String(l._id), l]));
  if (byId.size !== new Set(plan.map((p) => p.id)).size) return next(new AppError('Service level not found', 404));

  const changed = [];
  for (const { id, hours } of plan) {
    const level = byId.get(id);
    const previous = level.slaHours ?? null;
    if (previous === hours) continue;
    level.slaHours = hours ?? undefined;
    level.slaUpdatedBy = req.user.id;
    level.slaUpdatedAt = new Date();
    await level.save();
    changed.push(level.name);
    await logAudit({
      actorUserId: req.user.id,
      action: 'SERVICE_LEVEL_SLA_UPDATED',
      targetType: 'ServiceLevelConfig',
      targetId: id,
      before: { hours: previous },
      after: { hours },
      metadata: { serviceLevel: level.name, appliesTo: 'orders confirmed after this change' },
    });
  }

  res.status(200).json({
    success: true,
    message: changed.length
      ? 'Processing times saved. They apply to orders confirmed from now on.'
      : 'No changes',
    data: { changed },
  });
});

// @route GET /api/v1/services/levels/sla/performance?from=&to=
// Per service level: orders finished in the window, how many on time, average
// processing time — measured against the promise snapshotted at confirmation.
exports.getSlaPerformance = asyncHandler(async (req, res, next) => {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 30 * 24 * HOUR);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return next(invalid('Invalid date range'));

  const rows = await Order.aggregate([
    { $match: { slaDueAt: { $ne: null }, readyAt: { $gte: from, $lte: to }, status: { $ne: 'cancelled' } } },
    {
      $project: {
        level: { $ifNull: ['$slaServiceLevelName', 'Unknown'] },
        onTime: { $lte: ['$readyAt', '$slaDueAt'] },
        processingMs: { $subtract: ['$readyAt', '$confirmedAt'] },
        lateMs: { $max: [0, { $subtract: ['$readyAt', '$slaDueAt'] }] },
        targetHours: '$slaHours',
      },
    },
    {
      $group: {
        _id: '$level',
        completed: { $sum: 1 },
        onTime: { $sum: { $cond: ['$onTime', 1, 0] } },
        avgProcessingMs: { $avg: '$processingMs' },
        avgTargetHours: { $avg: '$targetHours' },
        avgLateMs: { $avg: { $cond: ['$onTime', null, '$lateMs'] } },
      },
    },
    { $sort: { completed: -1 } },
  ]);

  const levels = rows.map((r) => ({
    serviceLevel: r._id,
    completed: r.completed,
    onTime: r.onTime,
    late: r.completed - r.onTime,
    compliancePct: r.completed ? round1((r.onTime / r.completed) * 100) : null,
    avgProcessingHours: round1(r.avgProcessingMs / HOUR),
    avgTargetHours: round1(r.avgTargetHours || 0),
    avgLateHours: r.avgLateMs ? round1(r.avgLateMs / HOUR) : 0,
  }));
  const completed = levels.reduce((s, r) => s + r.completed, 0);
  const onTime = levels.reduce((s, r) => s + r.onTime, 0);
  const overdueNow = await Order.countDocuments({
    slaActiveDueAt: { $lt: new Date() }, status: { $nin: ['cancelled', 'completed'] },
  });

  res.status(200).json({
    success: true,
    message: 'SLA performance fetched successfully',
    data: {
      from, to, overdueNow,
      totals: { completed, onTime, late: completed - onTime, compliancePct: completed ? round1((onTime / completed) * 100) : null },
      levels,
    },
  });
});
