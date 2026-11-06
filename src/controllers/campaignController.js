// ─── Campaigns (e.g. the "Relux Is One!" anniversary celebration) ───────────
// One global switch per campaign, stored in MongoDB so every customer, device
// and backend instance sees the same state, and it survives restarts.
// Only the Superadmin (developer role) can read the management details or
// change it — enforced here, not just hidden in the UI. Customers get a
// read-only { key, name, active } and nothing else.

const CampaignSetting = require('../models/CampaignSetting.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');
const ERROR_CODES = require('../utils/errorCodes.js');
const { logAudit } = require('../utils/auditLogger.js');

const CAMPAIGNS = { anniversary: { name: 'Relux Is One!' } };

// Deliberately NOT authorize(): the allow-list here is exactly the Superadmin.
exports.requireSuperadmin = (req, res, next) => {
  if (req.user?.role !== 'developer') return next(new AppError('Only the Superadmin can manage campaigns', 403));
  next();
};

const isActive = (c, now = new Date()) => !!c?.enabled
  && (!c.startsAt || now >= c.startsAt)
  && (!c.endsAt || now <= c.endsAt);

const publicView = (key, c) => ({ key, name: c?.name || CAMPAIGNS[key].name, active: isActive(c) });

function knownKey(req, next) {
  const { key } = req.params;
  if (!CAMPAIGNS[key]) { next(new AppError('Unknown campaign', 404)); return null; }
  return key;
}

// @route GET /api/v1/campaigns/:key   (public — the state is not secret)
exports.getCampaignState = asyncHandler(async (req, res, next) => {
  const key = knownKey(req, next); if (!key) return;
  const c = await CampaignSetting.findOne({ key }).lean();
  res.set('Cache-Control', 'no-store');
  res.status(200).json({ success: true, data: publicView(key, c) });
});

// @route GET /api/v1/settings/campaigns/:key   (Superadmin)
exports.getCampaignSettings = asyncHandler(async (req, res, next) => {
  const key = knownKey(req, next); if (!key) return;
  const c = await CampaignSetting.findOne({ key }).populate('updatedBy', 'name').lean();
  res.status(200).json({
    success: true,
    data: {
      key,
      name: c?.name || CAMPAIGNS[key].name,
      enabled: !!c?.enabled,
      active: isActive(c),
      startsAt: c?.startsAt || null,
      endsAt: c?.endsAt || null,
      updatedAt: c?.updatedAt || null,
      updatedBy: c?.updatedBy ? { id: c.updatedBy._id, name: c.updatedBy.name } : null,
    },
  });
});

// @route PUT /api/v1/settings/campaigns/:key   { enabled, startsAt?, endsAt? } (Superadmin)
exports.updateCampaignSettings = asyncHandler(async (req, res, next) => {
  const key = knownKey(req, next); if (!key) return;
  const invalid = (m) => next(new AppError(m, 400, ERROR_CODES.VALIDATION_ERROR));
  if (typeof req.body.enabled !== 'boolean') return invalid('enabled must be true or false');

  const parseDate = (v) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? false : d;
  };
  const startsAt = parseDate(req.body.startsAt);
  const endsAt = parseDate(req.body.endsAt);
  if (startsAt === false || endsAt === false) return invalid('Dates must be valid');

  const before = await CampaignSetting.findOne({ key }).lean();
  const nextStart = startsAt === undefined ? before?.startsAt : startsAt;
  const nextEnd = endsAt === undefined ? before?.endsAt : endsAt;
  if (nextStart && nextEnd && nextEnd <= nextStart) return invalid('The end date must be after the start date');

  const set = { enabled: req.body.enabled, name: CAMPAIGNS[key].name, updatedBy: req.user.id };
  const unset = {};
  if (startsAt !== undefined) { if (startsAt) set.startsAt = startsAt; else unset.startsAt = 1; }
  if (endsAt !== undefined) { if (endsAt) set.endsAt = endsAt; else unset.endsAt = 1; }

  // Persist first; only a saved state is ever announced.
  const saved = await CampaignSetting.findOneAndUpdate(
    { key },
    { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).populate('updatedBy', 'name').lean();

  await logAudit({
    actorUserId: req.user.id,
    action: 'CAMPAIGN_UPDATED',
    targetType: 'CampaignSetting',
    targetId: key,
    before: before ? { enabled: before.enabled, startsAt: before.startsAt, endsAt: before.endsAt } : null,
    after: { enabled: saved.enabled, startsAt: saved.startsAt, endsAt: saved.endsAt },
  });

  // Connected dashboards switch immediately; new or reconnecting ones fetch.
  const io = req.app.get('io');
  if (io) io.emit('campaign:updated', publicView(key, saved));

  res.status(200).json({
    success: true,
    message: saved.enabled ? 'Campaign enabled' : 'Campaign disabled',
    data: {
      key,
      name: saved.name,
      enabled: saved.enabled,
      active: isActive(saved),
      startsAt: saved.startsAt || null,
      endsAt: saved.endsAt || null,
      updatedAt: saved.updatedAt,
      updatedBy: saved.updatedBy ? { id: saved.updatedBy._id, name: saved.updatedBy.name } : null,
    },
  });
});
